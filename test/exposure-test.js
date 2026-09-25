// A cap on everything open together, as a multiple of equity.
//
// The gap this closes: the per-position ceilings each look at one symbol. Ten
// positions each inside its own cap can still add up to a book many times the
// account — at 75% sizing the live account could reach about 12x — and under
// cross margin that whole book stands on one balance.

const test = require('node:test');
const assert = require('node:assert/strict');
const { executeTrade, validateTradeRequest, DedupeCache } = require('../trading');
const { applyRisk, readRisk, riskConfig, createRiskSettings } = require('../risk');

const quiet = { log() {}, warn() {}, error() {} };
const market = {
  symbol: 'BTC/USDT:USDT', base: 'BTC', quote: 'USDT', settle: 'USDT',
  linear: true, inverse: false, contract: true, contractSize: 1, swap: true, type: 'swap',
  limits: { amount: { min: 0.001 }, cost: { min: 5 } }, precision: { amount: 0.001, price: 0.01 },
};
const base = {
  dryRun: false, leverage: 10, marginMode: 'cross', tradeFraction: 0.5, stopLossPercent: 2,
  takeProfitPercent: null, requireProtectiveStop: true, maxPositionNotional: null, maxPositionPercent: null,
  liquidationSafetyFactor: 0.7, maintenanceMarginRate: 0.005, dedupeTtlMs: 0, minNotionalBump: false,
  maxExposureMultiple: null,
};

// Equity 1000, free 1000; each order 50% of free = 500 notional (0.01 BTC at 50k).
function exchange(sent, { positions = [], positionsFail = false } = {}) {
  return {
    id: 'fake', has: { fetchPositions: true, setLeverage: true },
    markets: { [market.symbol]: market },
    market: () => market,
    async fetchBalance() { return { USDT: { free: 1000, total: 1000 }, free: { USDT: 1000 }, total: { USDT: 1000 } }; },
    async fetchTicker() { return { last: 50_000 }; },
    async fetchPositions(symbols) {
      if (positionsFail && !symbols) throw new Error('rate limited');
      return positions.filter((p) => !symbols || symbols.includes(p.symbol));
    },
    async setLeverage() {},
    amountToPrecision: (_s, a) => Number(a).toFixed(3),
    priceToPrecision: (_s, p) => Number(p).toFixed(2),
    async createOrder(...args) { sent.push(args); return { id: 'o', status: 'closed' }; },
  };
}
const open = (symbol, side, notional) => ({ symbol, side, contracts: notional / 50_000, notional, contractSize: 1 });

async function order({ cap, positions, side = 'buy', reduceOnly = false, positionsFail = false, opts = {}, marginMode = 'cross' }) {
  const sent = [];
  const exchanges = { fake: exchange(sent, { positions, positionsFail }) };
  const req = validateTradeRequest({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side, reduceOnly, stopPrice: side === 'buy' ? 49_000 : 51_000 }, exchanges);
  const out = await executeTrade(req, { config: { ...base, marginMode, maxExposureMultiple: cap }, dedupe: new DedupeCache(0),
    logger: quiet, requestId: 't', ...opts });
  return { out, sent };
}

test('an order that would take the book over the cap is refused', async () => {
  // 1000 equity, cap 3x = 3000. Open 2800, plus 500 new = 3300.
  await assert.rejects(
    order({ cap: 3, positions: [open('ETH/USDT:USDT', 'long', 2800)] }),
    (err) => err.status === 409 && /total open exposure to 3300\.00/.test(err.message) && /3x a 1000\.00 account/.test(err.message)
  );
});

test('under the cap it goes through', async () => {
  const { sent } = await order({ cap: 3, positions: [open('ETH/USDT:USDT', 'long', 2400)] });   // 2900
  assert.equal(sent.length, 1);
});

test('exactly at the cap is allowed', async () => {
  const { sent } = await order({ cap: 3, positions: [open('ETH/USDT:USDT', 'long', 2500)] });   // 3000
  assert.equal(sent.length, 1);
});

test('no cap set: nothing changes', async () => {
  // The same 3300 book the cap refused above goes through without one.
  const { sent } = await order({ cap: null, positions: [open('ETH/USDT:USDT', 'long', 2800)] });
  assert.equal(sent.length, 1, 'off unless chosen');
});

test('a close is never blocked by the cap', async () => {
  // Reducing exposure is what the cap exists to encourage.
  const { sent } = await order({ cap: 1, side: 'sell', reduceOnly: true,
    positions: [open('BTC/USDT:USDT', 'long', 500), open('ETH/USDT:USDT', 'long', 5000)] });
  assert.equal(sent.length, 1);
});

test("a reversal's check does not count the position it is about to close", async () => {
  // Short 500 on BTC about to become long 500: the book does not grow.
  // 2400 elsewhere + 500 new = 2900 under a 3000 cap; counting the short too
  // would read 3400 and refuse a reversal that adds nothing.
  const { out } = await order({ cap: 3, positions: [open('BTC/USDT:USDT', 'short', 500), open('ETH/USDT:USDT', 'long', 2400)],
    opts: { preflight: true, ignoreOpenPosition: true } });
  assert.ok(out, 'the pre-check passes');
});

test('a book that could not be read in full is refused, not guessed', async () => {
  // Under cross margin the liquidation check already refuses this. Under
  // isolated it does not — each position stands on its own margin — so the
  // cap has to refuse it itself: a total it cannot see is a total it cannot cap.
  await assert.rejects(order({ cap: 3, positions: [], positionsFail: true, marginMode: 'isolated' }),
    (err) => err.status === 503 && /total-exposure cap cannot be checked/.test(err.message));
  await assert.rejects(order({ cap: 3, positions: [], positionsFail: true }), /could not be read/,
    'and under cross it is refused either way');
});

test('without a cap, an unreadable book is not a new reason to refuse', async () => {
  const { sent } = await order({ cap: null, positions: [], positionsFail: true, marginMode: 'isolated' });
  assert.equal(sent.length, 1);
});

test('the setting is saved, validated and reaches the order path', () => {
  const settings = createRiskSettings({ tradePercentage: 5, maxExposureMultiple: undefined, scanner: {} });
  assert.equal(readRisk(settings, { scanner: {} }).maxExposureMultiple, null, 'off by default');
  applyRisk(settings, { maxExposureMultiple: 5 });
  assert.equal(readRisk(settings, { scanner: {} }).maxExposureMultiple, 5);
  assert.equal(riskConfig({}, settings).maxExposureMultiple, 5, 'and orders see it');
  applyRisk(settings, { maxExposureMultiple: null });
  assert.equal(riskConfig({}, settings).maxExposureMultiple, null, 'and it can be switched off');
  assert.throws(() => applyRisk(settings, { maxExposureMultiple: 0 }), /maxExposureMultiple/, 'zero would refuse everything');
});

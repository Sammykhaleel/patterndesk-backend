// "Exit only on a flip": positions ride the supertrend, long and short, and
// change only when it turns.
//
// The behaviour this exists for: every entry carried an exchange stop at the
// supertrend line as it stood at entry. Right after a flip that line sits next
// to price, so an ordinary pullback wicked through it and closed the position
// — with no bar closing beyond the line, so no flip, and the bot left flat.
// In one week: 71 such closes against 37 genuine flips. The user asked for the
// position to keep going with the supertrend instead.

const test = require('node:test');
const assert = require('node:assert/strict');

const { executeTrade, validateTradeRequest, DedupeCache } = require('../trading');
const { flipExit } = require('../scanner');
const { readSettings, applySettings } = require('../scannerapi');

const quiet = { log() {}, warn() {}, error() {} };
const market = {
  symbol: 'BTC/USDT:USDT', base: 'BTC', quote: 'USDT', settle: 'USDT',
  linear: true, inverse: false, contract: true, contractSize: 1, swap: true, type: 'swap',
  limits: { amount: { min: 0.001 }, cost: { min: 5 } }, precision: { amount: 0.001, price: 0.01 },
};
const config = {
  dryRun: false, leverage: 3, marginMode: 'cross', tradeFraction: 0.05, stopLossPercent: 2,
  takeProfitPercent: null, requireProtectiveStop: true, maxPositionNotional: null, maxPositionPercent: null,
  liquidationSafetyFactor: 0.7, maintenanceMarginRate: 0.005, dedupeTtlMs: 0, minNotionalBump: false,
};

function exchange(sent, { positions = [], free = 10_000 } = {}) {
  return {
    id: 'fake', has: { fetchPositions: true, setLeverage: true },
    markets: { [market.symbol]: market },
    market: () => market,
    async fetchBalance() { return { USDT: { free, total: free }, free: { USDT: free }, total: { USDT: free } }; },
    async fetchTicker() { return { last: 50_000 }; },
    async fetchPositions() { return positions; },
    async setLeverage() {},
    amountToPrecision: (_s, a) => Number(a).toFixed(3),
    priceToPrecision: (_s, p) => Number(p).toFixed(2),
    async createOrder(...args) { sent.push(args); return { id: 'o1', status: 'closed' }; },
  };
}

async function place({ flipOnly, stopPrice = 49_000, book, fraction = 0.05 }) {
  const sent = [];
  const exchanges = { fake: exchange(sent, book) };
  const request = validateTradeRequest({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy', stopPrice }, exchanges);
  flipExit({ flipExitOnly: flipOnly }, request);
  const out = await executeTrade(request, { config: { ...config, tradeFraction: fraction },
    dedupe: new DedupeCache(0), logger: quiet, requestId: 't' });
  return { out, params: sent[0] && sent[0][5] };
}

test('off: the entry carries a stop at the supertrend line, as before', async () => {
  const { params } = await place({ flipOnly: false });
  assert.equal(params.stopLoss.triggerPrice, 49_000);
});

test('on: no stop is placed on the exchange', async () => {
  const { out, params } = await place({ flipOnly: true });
  assert.equal(params.stopLoss, undefined, 'nothing a wick can take the position out on');
  assert.equal(out.stopPrice ?? null, null);
});

test('on: the 2% fallback stop does not creep back in', async () => {
  // STOP_LOSS_PERCENT fills in a stop when none is sent. Here none is sent on
  // purpose, and the fallback would quietly undo the setting.
  const { params } = await place({ flipOnly: true });
  assert.equal(params.stopLoss, undefined);
});

test('on: the flip level is still checked against liquidation', async () => {
  // A small account already carrying a large book, like the live one: the
  // cross-margin buffer is a few percent, so a line 60% away is an exit the
  // account would be liquidated long before reaching.
  const book = { free: 100, positions: [{ symbol: 'ETH/USDT:USDT', side: 'long', contracts: 1, notional: 2000, contractSize: 1 }] };
  // 90% of $100 free: $90, above the 0.001 BTC lot.
  await assert.rejects(place({ flipOnly: true, stopPrice: 20_000, book, fraction: 0.9 }), /liquidat/i,
    'the trade is refused rather than opened with an exit it could never reach');
  // The same book with a line 2% away is fine.
  const { params } = await place({ flipOnly: true, stopPrice: 49_000, book, fraction: 0.9 });
  assert.equal(params.stopLoss, undefined);
});

test('on: a trade with no line to exit at is refused', async () => {
  // null, not undefined: undefined would pick up the helper's default line.
  await assert.rejects(place({ flipOnly: true, stopPrice: null }), /no supertrend line/);
});

test('nothing sent over HTTP can switch a stop off', () => {
  // The flag is set on the request object by the scanner, never read from a
  // body — a hand-sent order always keeps its protection.
  const exchanges = { fake: exchange([]) };
  const req = validateTradeRequest({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy', exchangeStop: false }, exchanges);
  assert.equal(req.exchangeStop, undefined);
});

test('the setting is readable, writable and off by default', () => {
  const base = { enabled: false, execute: false, reverse: true, strategy: 'supertrend', exchange: 'bybit',
    symbols: ['BTC/USDT:USDT'], timeframe: '1h', timeframes: ['1h'], supertrend: { period: 10, multiplier: 3 }, overrides: {} };
  const cfg = { scanner: { enabled: false, execute: false, exchange: 'bybit', symbols: [], timeframe: '1h', timeframes: ['1h'] } };
  assert.equal(readSettings(base, cfg).flipExitOnly, false, 'off unless chosen');
  const next = applySettings({ ...base }, { flipExitOnly: true }, { exchanges: {} });
  assert.equal(readSettings(next, cfg).flipExitOnly, true, 'and can be switched on');
  assert.throws(() => applySettings({ ...base }, { flipExitOnly: 'yes' }, { exchanges: {} }), /flipExitOnly/,
    'and only to true or false');
});

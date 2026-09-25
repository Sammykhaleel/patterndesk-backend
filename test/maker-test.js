// Limit-order (maker) entries with a market fallback.
//
// What is asserted here is mostly about the two ways this can cost money:
// buying the same size twice (a fill that was not seen, then a market order
// for it), and missing an entry (resting while price runs away). The first is
// guarded by reading the fill two ways and believing the larger; the second
// by a drift limit and a market fallback.

const test = require('node:test');
const assert = require('node:assert/strict');
const { placeMakerEntry } = require('../maker');
const { executeTrade, validateTradeRequest, DedupeCache } = require('../trading');
const { makerEntry } = require('../scanner');
const { readSettings, applySettings } = require('../scannerapi');

const quiet = { log() {}, warn() {}, error() {} };
const noWait = async () => {};
const SYM = 'BTC/USDT:USDT';

/**
 * A book: `quotes` is the bid/ask on each ticker read; `fills[i]` is the
 * fraction of limit attempt i that fills. `positionLag` hides fills from the
 * position read; `orderBlind` hides them from the order read.
 */
function book({ quotes = [{ bid: 100, ask: 100.1 }], fills = [], reject = [], positionLag = false, orderBlind = false } = {}) {
  let held = 0;
  let q = 0;
  let attempt = 0;
  const orders = new Map();
  const log = { limits: [], markets: [], cancels: [] };
  return {
    log,
    id: 'fake',
    async fetchTicker() { const x = quotes[Math.min(q, quotes.length - 1)]; q += 1; return x; },
    priceToPrecision: (_s, p) => Number(p).toFixed(2),
    amountToPrecision: (_s, a) => Number(a).toFixed(3),
    async fetchPositions() { return [{ symbol: SYM, side: 'long', contracts: positionLag ? 0 : held }]; },
    async createOrder(symbol, type, side, amount, price, params) {
      if (type === 'market') {
        log.markets.push({ amount, params });
        held += amount;
        return { id: 'mkt', status: 'closed', filled: amount };
      }
      attempt += 1;
      if (reject[attempt - 1]) throw new Error('post only would cross');
      const filled = amount * (fills[attempt - 1] || 0);
      held += filled;
      const id = `lim${attempt}`;
      orders.set(id, filled);
      log.limits.push({ price, amount, params });
      return { id, status: 'open' };
    },
    async cancelOrder(id) { log.cancels.push(id); },
    async fetchOrder(id) { return { id, filled: orderBlind ? 0 : orders.get(id) || 0 }; },
  };
}

const enter = (ex, extra = {}) => placeMakerEntry({ exchange: ex, symbol: SYM, side: 'buy', amount: 1, params: { clientOrderId: 'sig1' }, minAmount: 0.001, logger: quiet, sleep: noWait, ...extra });

test('filled on the first try: one limit order at the bid, no market order', async () => {
  const ex = book({ fills: [1] });
  const r = await enter(ex);
  assert.equal(ex.log.limits.length, 1);
  assert.equal(ex.log.limits[0].price, 100, 'at the best bid, not through the spread');
  assert.equal(ex.log.limits[0].params.postOnly, true, 'post-only: it can never fill as taker');
  assert.equal(ex.log.limits[0].params.clientOrderId, 'sig1-m1', 'each attempt has its own id');
  assert.equal(ex.log.markets.length, 0);
  assert.equal(r.makerFilled, 1);
  assert.equal(r.fellBack, false);
});

test('a sell rests at the ask', async () => {
  const ex = book({ fills: [1] });
  await enter(ex, { side: 'sell' });
  assert.equal(ex.log.limits[0].price, 100.1);
});

test('never filled: three tries, each cancelled, then market for all of it', async () => {
  const ex = book({ fills: [0, 0, 0] });
  const r = await enter(ex);
  assert.equal(ex.log.limits.length, 3);
  assert.deepEqual(ex.log.cancels, ['lim1', 'lim2', 'lim3'], 'nothing is left resting');
  assert.equal(ex.log.markets.length, 1);
  assert.equal(Number(ex.log.markets[0].amount), 1, 'the entry is never missed');
  assert.equal(r.fellBack, true);
});

test('partly filled: the next try is for what is left, and nothing is bought twice', async () => {
  const ex = book({ fills: [0.4, 1] });
  const r = await enter(ex);
  assert.equal(Number(ex.log.limits[1].amount).toFixed(3), '0.600', 'only the remainder is re-offered');
  assert.equal(ex.log.markets.length, 0);
  assert.equal(r.makerFilled, 1);
});

test('partly filled then not at all: market for the remainder only', async () => {
  const ex = book({ fills: [0.25, 0, 0] });
  await enter(ex);
  assert.equal(Number(ex.log.markets[0].amount), 0.75);
});

test('price running away stops the chase and falls back', async () => {
  // 100 -> 100.2 is 0.2%, over the 0.1% drift limit: chasing further would
  // cost more than the market order it was meant to beat.
  const ex = book({ quotes: [{ bid: 100, ask: 100.1 }, { bid: 100.2, ask: 100.3 }], fills: [0, 0, 0] });
  const r = await enter(ex);
  assert.equal(ex.log.limits.length, 1, 'no second resting order at the worse price');
  assert.equal(ex.log.markets.length, 1);
  assert.equal(r.fellBack, true);
});

test('a post-only order that would cross is retried, not given up on', async () => {
  // Attempt 1 is rejected (it would have crossed); attempt 2 rests and fills.
  const ex = book({ reject: [true, false], fills: [0, 1] });
  const r = await enter(ex);
  assert.equal(ex.log.limits.length, 1, 'the second attempt was placed');
  assert.equal(r.makerFilled, 1, 'and filled as maker');
  assert.equal(ex.log.markets.length, 0, 'with no fallback needed');
});

test('a fill the position has not caught up with is not bought again', async () => {
  // The dangerous case: the order filled, the position read still says 0.
  // Believing the position would send a market order for size already held.
  const ex = book({ fills: [1], positionLag: true });
  const r = await enter(ex);
  assert.equal(ex.log.markets.length, 0, 'no second purchase');
  assert.equal(r.makerFilled, 1);
});

test('a fill the order read missed but the position shows is not bought again either', async () => {
  const ex = book({ fills: [1], orderBlind: true });
  await enter(ex);
  assert.equal(ex.log.markets.length, 0);
});

test('a leftover under the minimum lot is not sent', async () => {
  const ex = book({ fills: [0.9995] });
  await enter(ex);
  assert.equal(ex.log.markets.length, 0, 'a 0.0005 remainder is below the 0.001 lot');
});

/* ---- through the order path ---- */

const market = { symbol: SYM, base: 'BTC', quote: 'USDT', settle: 'USDT', linear: true, inverse: false, contract: true,
  contractSize: 1, swap: true, type: 'swap', limits: { amount: { min: 0.001 }, cost: { min: 5 } }, precision: { amount: 0.001, price: 0.01 } };
const config = { dryRun: false, leverage: 10, marginMode: 'cross', tradeFraction: 0.05, stopLossPercent: 2, takeProfitPercent: null,
  requireProtectiveStop: true, maxPositionNotional: null, maxPositionPercent: null, liquidationSafetyFactor: 0.7,
  maintenanceMarginRate: 0.005, dedupeTtlMs: 0, minNotionalBump: false };

function fullExchange(b, positions = []) {
  return Object.assign(b, {
    has: { fetchPositions: true, setLeverage: true }, markets: { [SYM]: market }, market: () => market,
    async fetchBalance() { return { USDT: { free: 10_000, total: 10_000 }, free: { USDT: 10_000 }, total: { USDT: 10_000 } }; },
    async setLeverage() {},
    fetchPositions: positions.length ? async () => positions : b.fetchPositions,
  });
}

test('a scanner entry marked for maker rests first', async () => {
  const b = book({ quotes: [{ last: 50_000, bid: 50_000, ask: 50_001 }], fills: [1] });
  const ex = fullExchange(b);
  const req = validateTradeRequest({ exchange: 'fake', symbol: SYM, side: 'buy', stopPrice: 49_000 }, { fake: ex });
  makerEntry({ makerEntries: true }, req);
  const out = await executeTrade(req, { config, dedupe: new DedupeCache(0), logger: quiet, requestId: 't', makerSleep: noWait });
  assert.equal(b.log.limits.length, 1, 'a limit order, not market');
  assert.ok(b.log.limits[0].params.stopLoss, 'with the stop still attached when there is one');
  assert.equal(out.maker.fellBack, false);
});

test('a close is never a maker order, even when marked', async () => {
  const b = book({ quotes: [{ last: 50_000, bid: 50_000, ask: 50_001 }] });
  const ex = fullExchange(b, [{ symbol: SYM, side: 'long', contracts: 0.01, notional: 500 }]);
  const req = validateTradeRequest({ exchange: 'fake', symbol: SYM, side: 'sell', reduceOnly: true }, { fake: ex });
  req.makerEntry = true;
  await executeTrade(req, { config, dedupe: new DedupeCache(0), logger: quiet, requestId: 't', makerSleep: noWait });
  assert.equal(b.log.limits.length, 0);
  assert.equal(b.log.markets.length, 1, 'the exit goes at market');
});

test('nothing sent over HTTP can switch it on', () => {
  const b = book();
  const req = validateTradeRequest({ exchange: 'fake', symbol: SYM, side: 'buy', makerEntry: true }, { fake: fullExchange(b) });
  assert.equal(req.makerEntry, undefined);
});

test('the setting is readable, writable, off by default, and only it marks entries', () => {
  const base = { enabled: false, execute: false, reverse: true, strategy: 'supertrend', exchange: 'bybit',
    symbols: [SYM], timeframe: '1h', timeframes: ['1h'], supertrend: { period: 10, multiplier: 3 }, overrides: {} };
  const cfg = { scanner: { enabled: false, execute: false, exchange: 'bybit', symbols: [], timeframe: '1h', timeframes: ['1h'] } };
  assert.equal(readSettings(base, cfg).makerEntries, false);
  const next = applySettings({ ...base }, { makerEntries: true }, { exchanges: {} });
  assert.equal(readSettings(next, cfg).makerEntries, true);
  assert.equal(makerEntry({ makerEntries: false }, {}).makerEntry, undefined, 'off marks nothing');
  assert.equal(makerEntry({ makerEntries: true }, {}).makerEntry, true);
});

test('a leftover that rounds to a real size but is under the market minimum is not sent', async () => {
  // Markets where the minimum order is larger than the lot step: 0.005 is a
  // valid step, but under a 0.01 minimum the exchange would refuse it.
  const ex = book({ fills: [0.995] });
  await placeMakerEntry({ exchange: ex, symbol: SYM, side: 'buy', amount: 1, params: {}, minAmount: 0.01,
    logger: quiet, sleep: noWait });
  assert.equal(ex.log.markets.length, 0);
});

/* ------------------------------------------------------------------ *
 * Exits: one 5-second limit attempt, then market
 * ------------------------------------------------------------------ */

const { placeMakerExit, EXIT_OPTIONS } = require('../maker');

/** A short being closed: buying shrinks it. `fills[i]` is attempt i's fraction. */
function shortBook({ short = 1, fills = [], positionLag = false, orderBlind = false, quotes = [{ bid: 100, ask: 100.1 }] } = {}) {
  let held = short;
  let attempt = 0;
  const orders = new Map();
  const log = { limits: [], markets: [], cancels: [], waits: [] };
  return {
    log,
    async fetchTicker() { return quotes[0]; },
    priceToPrecision: (_s, p) => Number(p).toFixed(2),
    amountToPrecision: (_s, a) => Number(a).toFixed(3),
    async fetchPositions() { return held > 0 ? [{ symbol: SYM, side: 'short', contracts: positionLag ? short : held }] : []; },
    async createOrder(symbol, type, side, amount, price, params) {
      if (type === 'market') { log.markets.push({ amount, params }); held -= amount; return { id: 'mkt', filled: amount }; }
      attempt += 1;
      const filled = amount * (fills[attempt - 1] || 0);
      held -= filled;
      orders.set(`x${attempt}`, filled);
      log.limits.push({ price, amount, params });
      return { id: `x${attempt}` };
    },
    async cancelOrder(id) { log.cancels.push(id); },
    async fetchOrder(id) { return { id, filled: orderBlind ? 0 : orders.get(id) || 0 }; },
  };
}
const close = (ex, extra = {}) => placeMakerExit({ exchange: ex, symbol: SYM, side: 'buy', amount: 1,
  params: { reduceOnly: true, clientOrderId: 'sig1-x' }, logger: quiet, sleep: async (ms) => { ex.log.waits.push(ms); }, ...extra });

test('exit: one attempt of five seconds, not three of ten', async () => {
  const ex = shortBook({ fills: [0] });
  await close(ex);
  assert.equal(ex.log.limits.length, 1, 'one attempt');
  assert.deepEqual(ex.log.waits, [5000], 'resting five seconds');
  assert.equal(EXIT_OPTIONS.attempts, 1);
});

test('exit: filled as maker, no market order', async () => {
  const ex = shortBook({ fills: [1] });
  const r = await close(ex);
  assert.equal(ex.log.limits[0].params.reduceOnly, true, 'the limit can only close, never open');
  assert.equal(ex.log.limits[0].params.postOnly, true);
  assert.equal(ex.log.limits[0].price, 100, 'buying to close waits at the bid');
  assert.equal(ex.log.markets.length, 0);
  assert.equal(r.makerFilled, 1);
});

test('exit: not filled, closed at market — the exit is never skipped', async () => {
  const ex = shortBook({ fills: [0] });
  const r = await close(ex);
  assert.equal(ex.log.markets.length, 1);
  assert.equal(Number(ex.log.markets[0].amount), 1);
  assert.equal(ex.log.markets[0].params.reduceOnly, true, 'the market order can only close too');
  assert.equal(r.fellBack, true);
});

test('exit: partly filled, market for the rest only', async () => {
  const ex = shortBook({ fills: [0.3] });
  await close(ex);
  assert.equal(Number(ex.log.markets[0].amount), 0.7, 'the fill is read as the short shrinking');
});

test('exit: a fill the position has not shown yet is not closed twice', async () => {
  const ex = shortBook({ fills: [1], positionLag: true });
  await close(ex);
  assert.equal(ex.log.markets.length, 0, 'the order says it filled; believed');
});

test('exit: even a tiny remainder is closed, not left open', async () => {
  // An entry may skip a remainder under the minimum; an exit must not, or it
  // leaves a sliver of position with no exit at all.
  const ex = shortBook({ fills: [0.998] });
  await close(ex);
  assert.equal(ex.log.markets.length, 1);
  assert.equal(Number(ex.log.markets[0].amount), 0.002);
});

test('exit: only a scanner flip close is marked; a hand-sent close stays market', async () => {
  const { makerExit } = require('../scanner');
  assert.equal(makerExit({ makerExits: true }, { reduceOnly: true }).makerExit, true);
  assert.equal(makerExit({ makerExits: false }, { reduceOnly: true }).makerExit, undefined, 'off marks nothing');
  assert.equal(makerExit({ makerExits: true }, { reduceOnly: false }).makerExit, undefined, 'an entry is not an exit');
  const b = book({ quotes: [{ last: 50_000, bid: 50_000, ask: 50_001 }] });
  const req = validateTradeRequest({ exchange: 'fake', symbol: SYM, side: 'sell', reduceOnly: true, makerExit: true },
    { fake: fullExchange(b, [{ symbol: SYM, side: 'long', contracts: 0.01, notional: 500 }]) });
  assert.equal(req.makerExit, undefined, 'nothing sent over HTTP can set it');
});

test('exit: through the order path, a marked close rests first', async () => {
  const sb = shortBook({ fills: [1] });
  const ex = fullExchange(Object.assign(sb, { log: sb.log }), [{ symbol: SYM, side: 'short', contracts: 1, notional: 50_000 }]);
  ex.fetchPositions = sb.fetchPositions;
  ex.fetchTicker = async () => ({ last: 50_000, bid: 50_000, ask: 50_001 });
  const req = validateTradeRequest({ exchange: 'fake', symbol: SYM, side: 'buy', reduceOnly: true }, { fake: ex });
  req.makerExit = true;
  const out = await executeTrade(req, { config, dedupe: new DedupeCache(0), logger: quiet, requestId: 't', makerSleep: noWait });
  assert.equal(sb.log.limits.length, 1, 'a limit close');
  assert.ok(out.maker, 'and the result says how it went');
});

test('the exits setting is readable, writable and off by default', () => {
  const base = { enabled: false, execute: false, reverse: true, strategy: 'supertrend', exchange: 'bybit',
    symbols: [SYM], timeframe: '1h', timeframes: ['1h'], supertrend: { period: 10, multiplier: 3 }, overrides: {} };
  const cfg = { scanner: { enabled: false, execute: false, exchange: 'bybit', symbols: [], timeframe: '1h', timeframes: ['1h'] } };
  assert.equal(readSettings(base, cfg).makerExits, false);
  assert.equal(readSettings(applySettings({ ...base }, { makerExits: true }, { exchanges: {} }), cfg).makerExits, true);
});

test('exit: a fill only the position shows is read as the short shrinking', async () => {
  // The order read is blind here, so the position is the only witness: 0.3
  // of the short gone. Reading it the entry way (growth) sees nothing and
  // closes the whole 1.0 again at market.
  const ex = shortBook({ fills: [0.3], orderBlind: true });
  await close(ex);
  assert.equal(Number(ex.log.markets[0].amount), 0.7);
});

test('an entry marked as an exit by mistake is still an ordinary entry', async () => {
  const b = book({ quotes: [{ last: 50_000, bid: 50_000, ask: 50_001 }] });
  const ex = fullExchange(b);
  const req = validateTradeRequest({ exchange: 'fake', symbol: SYM, side: 'buy', stopPrice: 49_000 }, { fake: ex });
  req.makerExit = true;
  await executeTrade(req, { config, dedupe: new DedupeCache(0), logger: quiet, requestId: 't', makerSleep: noWait });
  assert.equal(b.log.limits.length, 0, 'not rested as an exit');
  assert.equal(b.log.markets.length, 1, 'a plain market entry');
});

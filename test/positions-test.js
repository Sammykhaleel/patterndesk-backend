'use strict';

/**
 * Reading and unwinding open positions.
 *
 * These are the only endpoints that act on positions the caller did not just
 * open, so what is asserted here is mostly about not acting on the wrong one:
 * deriving the closing side from the exchange rather than the caller, refusing
 * to guess in a hedge account, and never reporting a stop as cleared on a
 * venue that cannot clear it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  readPositions, readAccounts, findPosition, normalisePosition, positionSideOf,
  closingSideFor, protectionOf, clearProtection, cancelOrders,
} = require('../positions');
const { RequestError } = require('../trading');

const quiet = { log() {}, warn() {}, error() {} };

const pos = (over = {}) => ({
  symbol: 'BTC/USDT:USDT', side: 'long', contracts: 0.5, notional: 40000,
  entryPrice: 80000, markPrice: 80500, unrealizedPnl: 250, leverage: 25,
  liquidationPrice: 60000, info: {}, ...over,
});

const venue = (id, positions, over = {}) => ({
  id,
  has: { fetchPositions: true, cancelAllOrders: true, fetchOpenOrders: true },
  async fetchPositions() { return positions; },
  market: (s) => ({ id: s.replace(/[^A-Z]/g, ''), symbol: s, linear: true }),
  ...over,
});

/* ---------------- reading ---------------- */

test('a flat account reports no positions and no problems', async () => {
  const out = await readPositions({ bybit: venue('bybit', []) }, { logger: quiet });
  assert.deepEqual(out.positions, []);
  assert.deepEqual(out.problems, []);
});

test('zero-size rows are not positions', async () => {
  // ccxt returns a row per symbol ever traded on some venues. Rendering those
  // as open positions would show a dozen phantom holdings.
  const out = await readPositions({
    bybit: venue('bybit', [pos(), pos({ symbol: 'ETH/USDT:USDT', contracts: 0 })]),
  }, { logger: quiet });
  assert.equal(out.positions.length, 1);
  assert.equal(out.positions[0].symbol, 'BTC/USDT:USDT');
});

test('one venue failing still returns the other, and names the failure', async () => {
  // Getting flat is exactly when you cannot afford an all-or-nothing read.
  const broken = venue('weex', []);
  broken.fetchPositions = async () => { throw new Error('weex unreachable'); };
  const out = await readPositions({ bybit: venue('bybit', [pos()]), weex: broken }, { logger: quiet });
  assert.equal(out.positions.length, 1, 'bybit still came through');
  assert.equal(out.problems.length, 1);
  assert.equal(out.problems[0].exchange, 'weex');
  assert.match(out.problems[0].error, /unreachable/);
});

test('a venue that cannot report positions is a named problem, not silence', async () => {
  const blind = venue('weex', []);
  blind.has = { fetchPositions: false };
  const out = await readPositions({ weex: blind }, { logger: quiet });
  assert.equal(out.problems.length, 1);
  assert.match(out.problems[0].error, /cannot report open positions/i);
});

test('positions are ordered by size, largest first', async () => {
  const out = await readPositions({
    bybit: venue('bybit', [
      pos({ symbol: 'A/USDT:USDT', notional: 10 }),
      pos({ symbol: 'B/USDT:USDT', notional: 900 }),
      pos({ symbol: 'C/USDT:USDT', notional: 100 }),
    ]),
  }, { logger: quiet });
  assert.deepEqual(out.positions.map((p) => p.symbol),
    ['B/USDT:USDT', 'C/USDT:USDT', 'A/USDT:USDT']);
});

/* ---------------- protective levels ---------------- */

test('a zero stop is reported as no stop, not as a stop at price zero', () => {
  // Bybit sends "0" for "none" rather than omitting the field. Number("0") is
  // a real number, so the naive reading is a stop that exists and sits very
  // far away — the opposite of the truth, on the field that matters most.
  const p = protectionOf({ info: { stopLoss: '0', takeProfit: '0' } });
  assert.equal(p.stopLoss, null);
  assert.equal(p.takeProfit, null);
});

test('real levels come through as numbers', () => {
  const p = protectionOf({ info: { stopLoss: '78000.5', takeProfit: '85000' } });
  assert.equal(p.stopLoss, 78000.5);
  assert.equal(p.takeProfit, 85000);
});

test('the unified ccxt fields are preferred when present', () => {
  const p = protectionOf({ stopLossPrice: 77000, takeProfitPrice: 90000, info: { stopLoss: '0' } });
  assert.equal(p.stopLoss, 77000);
  assert.equal(p.takeProfit, 90000);
});

test('a string field never reaches the caller as a string', () => {
  const n = normalisePosition('bybit', pos({ notional: '40000', unrealizedPnl: '12.5' }));
  assert.equal(typeof n.notional, 'number');
  assert.equal(typeof n.unrealizedPnl, 'number');
});

test('an unusable number becomes null rather than NaN', () => {
  const n = normalisePosition('bybit', pos({ entryPrice: 'n/a', markPrice: undefined }));
  assert.equal(n.entryPrice, null);
  assert.equal(n.markPrice, null);
});

/* ---------------- which way is it facing ---------------- */

test('long and short are read from the side field', () => {
  assert.equal(positionSideOf({ side: 'long' }), 'long');
  assert.equal(positionSideOf({ side: 'SHORT' }), 'short');
  assert.equal(positionSideOf({ side: 'buy' }), 'long');
  assert.equal(positionSideOf({ side: 'sell' }), 'short');
});

test('a missing side falls back to the sign of the size', () => {
  assert.equal(positionSideOf({ contracts: -2 }), 'short');
  assert.equal(positionSideOf({ contracts: 2 }), 'long');
});

test('closing a long sells and closing a short buys', () => {
  // Getting this backwards does not fail — it DOUBLES the position.
  assert.equal(closingSideFor({ side: 'long' }), 'sell');
  assert.equal(closingSideFor({ side: 'short' }), 'buy');
});

test('a position with no discernible side is refused, not guessed', () => {
  assert.throws(() => closingSideFor({ side: '', contracts: 0 }),
    (e) => e instanceof RequestError && e.status === 502);
});

/* ---------------- finding one ---------------- */

test('no position on the symbol is a 404', async () => {
  await assert.rejects(
    () => findPosition(venue('bybit', []), 'BTC/USDT:USDT'),
    (e) => e instanceof RequestError && e.status === 404
  );
});

test('a filtered query that the venue refuses falls back to the whole book', async () => {
  const ex = venue('bybit', [pos()]);
  ex.fetchPositions = async (symbols) => {
    if (symbols) throw new Error('this venue refuses a symbol filter');
    return [pos()];
  };
  const found = await findPosition(ex, 'BTC/USDT:USDT');
  assert.equal(found.length, 1);
});

test('a hedge account returns both sides rather than picking one', async () => {
  const ex = venue('bybit', [pos({ side: 'long' }), pos({ side: 'short' })]);
  const found = await findPosition(ex, 'BTC/USDT:USDT');
  assert.equal(found.length, 2, 'the caller has to say which, so both come back');
});

test('other symbols in the book are not mistaken for this one', async () => {
  const ex = venue('bybit', [pos({ symbol: 'ETH/USDT:USDT' })]);
  await assert.rejects(
    () => findPosition(ex, 'BTC/USDT:USDT'),
    (e) => e instanceof RequestError && e.status === 404
  );
});

/* ---------------- clearing protection ---------------- */

test('clearing sends zeros for both levels', async () => {
  let sent = null;
  const ex = venue('bybit', [pos()], {
    privatePostV5PositionTradingStop: async (params) => { sent = params; return {}; },
  });
  const out = await clearProtection(ex, 'BTC/USDT:USDT');
  assert.equal(sent.stopLoss, '0');
  assert.equal(sent.takeProfit, '0');
  assert.equal(sent.category, 'linear');
  assert.deepEqual(out.cleared, ['stopLoss', 'takeProfit']);
});

test('a venue without the call refuses rather than reporting success', async () => {
  // Reporting a stop as cleared while it is still live is the most expensive
  // thing this file could be wrong about.
  const ex = venue('weex', [pos()]);
  await assert.rejects(
    () => clearProtection(ex, 'BTC/USDT:USDT'),
    (e) => e instanceof RequestError && e.status === 501 && /not implemented/i.test(e.message)
  );
});

test('an inverse contract is sent with the inverse category', async () => {
  let sent = null;
  const ex = venue('bybit', [pos()], {
    market: (s) => ({ id: 'BTCUSD', symbol: s, linear: false }),
    privatePostV5PositionTradingStop: async (params) => { sent = params; return {}; },
  });
  await clearProtection(ex, 'BTC/USD:BTC');
  assert.equal(sent.category, 'inverse');
});

/* ---------------- cancelling orders ---------------- */

test('cancelling is scoped to the symbol it was given', async () => {
  let asked = null;
  const ex = venue('bybit', [], {
    async fetchOpenOrders() { return [{ id: '1' }, { id: '2' }]; },
    async cancelAllOrders(symbol) { asked = symbol; },
  });
  const out = await cancelOrders(ex, 'BTC/USDT:USDT');
  assert.equal(asked, 'BTC/USDT:USDT', 'never a blanket cancel');
  assert.equal(out.cancelled, 2);
});

test('a count that could not be read is null, not zero', async () => {
  // "Cancelled 0 orders" and "cancelled an unknown number" are different
  // answers, and only one of them means nothing happened.
  const ex = venue('bybit', [], {
    async fetchOpenOrders() { throw new Error('not permitted'); },
    async cancelAllOrders() {},
  });
  const out = await cancelOrders(ex, 'BTC/USDT:USDT');
  assert.equal(out.cancelled, null);
});

test('a venue that cannot cancel says so', async () => {
  const ex = venue('weex', []);
  ex.has = { fetchPositions: true, cancelAllOrders: false };
  await assert.rejects(
    () => cancelOrders(ex, 'BTC/USDT:USDT'),
    (e) => e instanceof RequestError && e.status === 501
  );
});

/* ---------------- account margin ---------------- */

test('free margin is reported per venue', async () => {
  // An entry needs free margin; a reduceOnly close does not. When someone
  // reports "it closes but never opens", this is the number that separates
  // an over-committed account from a refused signal.
  const ex = venue('bybit', []);
  ex.fetchBalance = async () => ({ free: { USDT: 1.25 }, used: { USDT: 6.8 }, total: { USDT: 8.05 } });
  const out = await readAccounts({ bybit: ex }, { logger: quiet });
  assert.equal(out.bybit.free, 1.25);
  assert.equal(out.bybit.used, 6.8);
  assert.equal(out.bybit.total, 8.05);
});

test('the per-currency shape is read too', async () => {
  // ccxt exposes both balance.free.USDT and balance.USDT.free depending on
  // the venue, and reading only one shape reports null on the other.
  const ex = venue('bybit', []);
  ex.fetchBalance = async () => ({ USDT: { free: 2, used: 1, total: 3 } });
  const out = await readAccounts({ bybit: ex }, { logger: quiet });
  assert.equal(out.bybit.free, 2);
  assert.equal(out.bybit.total, 3);
});

test('an unreadable balance is named, not silently zero', async () => {
  // Zero free margin and "could not read it" lead to opposite conclusions.
  const ex = venue('weex', []);
  ex.fetchBalance = async () => { throw new Error('weex unreachable'); };
  const out = await readAccounts({ weex: ex }, { logger: quiet });
  assert.equal(out.weex.free, undefined);
  assert.match(out.weex.error, /unreachable/);
});

test('a missing figure is null rather than NaN', async () => {
  const ex = venue('bybit', []);
  ex.fetchBalance = async () => ({ free: {}, total: {} });
  const out = await readAccounts({ bybit: ex }, { logger: quiet });
  assert.equal(out.bybit.free, null);
  assert.equal(out.bybit.total, null);
});

/* ---------------- the stop ceiling ---------------- */

const { usableStopPercent } = require('../trading');

test('the reported ceiling matches what the guard would allow', () => {
  // These are the same numbers the guard uses. Two copies of this arithmetic
  // would drift, and the failure mode is a panel offering a setting the
  // server refuses on every signal.
  const args = { equity: 7.11, notionalQuote: 10.23, existingNotional: 145.99,
                 maintenanceMarginRate: 0.01, safetyFactor: 0.7 };
  const usable = usableStopPercent(args);
  assert.ok(usable > 2.4 && usable < 2.6, `expected about 2.5%, got ${usable}`);

  // A stop just inside is accepted; just outside is refused. That is the
  // property the number is claiming.
  const { assertStopInsideLiquidation } = require('../trading');
  const check = (pct) => {
    try {
      assertStopInsideLiquidation({ price: 100, stop: 100 * (1 + pct / 100), marginMode: 'cross',
        leverage: 25, safetyFactor: args.safetyFactor, equity: args.equity,
        notionalQuote: args.notionalQuote, existingNotional: args.existingNotional,
        maintenanceMarginRate: args.maintenanceMarginRate });
      return 'ok';
    } catch { return 'refused'; }
  };
  assert.equal(check(usable - 0.05), 'ok', 'just inside the reported ceiling is accepted');
  assert.equal(check(usable + 0.05), 'refused', 'just outside it is refused');
});

test('an account that cannot cover maintenance reports zero, not null', () => {
  // Zero means "nothing is placeable"; null means "could not work it out".
  // Rendering them the same way would hide a real halt.
  const out = usableStopPercent({ equity: 2.03, notionalQuote: 10.23, existingNotional: 280.78,
    maintenanceMarginRate: 0.01, safetyFactor: 0.7 });
  assert.equal(out, 0);
});

test('unusable inputs give null rather than a misleading number', () => {
  assert.equal(usableStopPercent({ equity: 0, notionalQuote: 10 }), null);
  assert.equal(usableStopPercent({ equity: 10, notionalQuote: 0 }), null);
  assert.equal(usableStopPercent({ equity: NaN, notionalQuote: 10 }), null);
});

test('closing exposure widens the ceiling', () => {
  const tight = usableStopPercent({ equity: 7.11, notionalQuote: 10.23, existingNotional: 145.99,
    maintenanceMarginRate: 0.01, safetyFactor: 0.7 });
  const loose = usableStopPercent({ equity: 7.11, notionalQuote: 10.23, existingNotional: 21.71,
    maintenanceMarginRate: 0.01, safetyFactor: 0.7 });
  assert.ok(loose > tight * 2, 'less exposure allows a much wider stop');
});

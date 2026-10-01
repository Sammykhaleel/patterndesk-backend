// Partial close: part of a position closed at a profit target, the rest held
// to the flip. Optional, per symbol, off unless set.
const test = require('node:test');
const assert = require('node:assert/strict');
const { placePartial, cancelPartials, isPartialOrder } = require('../partial');
const { closeReason } = require('../closes');
const { applySettings } = require('../scannerapi');

const quiet = { log() {}, warn() {}, error() {} };

function venue({ positions = [], open = [], createFails = null, min = 0.001 } = {}) {
  const sent = [], cancelled = [];
  return {
    sent, cancelled,
    id: 'bybit',
    market: () => ({ contractSize: 1, limits: { amount: { min } } }),
    amountToPrecision: (_s, a) => String(Math.floor(Number(a) * 1000 + 1e-9) / 1000),
    priceToPrecision: (_s, p) => Number(p).toFixed(2),
    async fetchPositions() { return positions; },
    async fetchOpenOrders() { return open; },
    async cancelOrder(id) { cancelled.push(id); },
    async createOrder(symbol, type, side, amount, price, params) {
      if (createFails) throw new Error(createFails);
      sent.push({ symbol, type, side, amount, price, params });
      return { id: 'p1' };
    },
  };
}
const ZEC = 'ZEC/USDT:USDT';
const longPos = { symbol: ZEC, side: 'long', contracts: 0.03, entryPrice: 1300 };
const shortPos = { symbol: ZEC, side: 'short', contracts: 0.03, entryPrice: 1300 };

test('a long: half of it, as a reduce-only limit 3% above the entry', async () => {
  const ex = venue({ positions: [longPos] });
  const out = await placePartial({ exchange: ex, symbol: ZEC, side: 'buy', partial: { pricePct: 3, sizePct: 50 },
    clientOrderId: 'ZECUSDTUSDT-30m-1p', logger: quiet });
  assert.equal(out.placed, true);
  assert.deepEqual(ex.sent, [{ symbol: ZEC, type: 'limit', side: 'sell', amount: 0.015, price: 1339,
    params: { reduceOnly: true, clientOrderId: 'ZECUSDTUSDT-30m-1p' } }]);
});

test('a short: bought back 3% BELOW the entry, the share chosen', async () => {
  const ex = venue({ positions: [shortPos] });
  await placePartial({ exchange: ex, symbol: ZEC, side: 'sell', partial: { pricePct: 3, sizePct: 30 },
    clientOrderId: 'x-30m-1p', logger: quiet });
  assert.equal(ex.sent[0].side, 'buy');
  assert.equal(ex.sent[0].price, 1261, 'the price moves 3%, not the position');
  assert.equal(ex.sent[0].amount, 0.009, '30% of 0.03');
});

test('sized from the position the exchange holds, not the order report', async () => {
  // Another symbol's long, and a short on this one, are not it.
  const ex = venue({ positions: [{ ...longPos, symbol: 'BTC/USDT:USDT', contracts: 5 }, shortPos,
    { ...longPos, contracts: 0.05, entryPrice: 1310 }] });
  await placePartial({ exchange: ex, symbol: ZEC, side: 'buy', partial: { pricePct: 1, sizePct: 50 }, clientOrderId: 'a-1h-1p', logger: quiet });
  assert.equal(ex.sent[0].amount, 0.025);
  assert.equal(ex.sent[0].price, 1323.1, '1% above its own average entry');
});

test('too small to split: the whole position rides to the flip', async () => {
  const ex = venue({ positions: [{ ...longPos, contracts: 0.01 }], min: 0.01 });
  const out = await placePartial({ exchange: ex, symbol: ZEC, side: 'buy', partial: { pricePct: 3, sizePct: 50 }, clientOrderId: 'a-1h-1p', logger: quiet });
  assert.equal(out.placed, false);
  assert.equal(out.reason, 'below minimum');
  assert.equal(ex.sent.length, 0);
});

test('under the minimum order VALUE, too', async () => {
  const ex = venue({ positions: [{ ...longPos, contracts: 0.006 }] });
  const out = await placePartial({ exchange: ex, symbol: ZEC, side: 'buy', partial: { pricePct: 3, sizePct: 50 },
    clientOrderId: 'a-1h-1p', config: { minOrderNotional: 5 }, logger: quiet });
  assert.equal(out.reason, 'below minimum', '0.003 x 1339 = 4.02, under 5');
});

test('off, a dry run, or hedge mode: nothing is placed', async () => {
  const cases = [[null, {}], [{ pricePct: 3, sizePct: 50 }, { dryRun: true }], [{ pricePct: 3, sizePct: 50 }, { hedgeMode: true }]];
  for (const [partial, config] of cases) {
    const ex = venue({ positions: [longPos] });
    await placePartial({ exchange: ex, symbol: ZEC, side: 'buy', partial, clientOrderId: 'a-1h-1p', config, logger: quiet });
    assert.equal(ex.sent.length, 0, JSON.stringify(config));
  }
});

test('a refused partial close never throws: the entry already happened', async () => {
  const ex = venue({ positions: [longPos], createFails: 'insufficient balance' });
  const out = await placePartial({ exchange: ex, symbol: ZEC, side: 'buy', partial: { pricePct: 3, sizePct: 50 }, clientOrderId: 'a-1h-1p', logger: quiet });
  assert.equal(out.placed, false);
  assert.match(out.reason, /insufficient/);
});

test('cancelling finds only the partial closes', async () => {
  const ex = venue({ open: [
    { id: 'a', clientOrderId: 'ZECUSDTUSDT-30m-1790366400000p' },
    { id: 'b', clientOrderId: 'ZECUSDTUSDT-30m-1790366400000' },      // an entry
    { id: 'c', clientOrderId: 'ZECUSDTUSDT-30m-1790366400000x' },     // a close at a flip
    { id: 'd', clientOrderId: 'pd0a1b2c' },                           // sent from the app
    { id: 'e', info: { orderLinkId: 'ZECUSDTUSDT-4h-1790366400000p' } },
  ] });
  const out = await cancelPartials({ exchange: ex, symbol: ZEC, logger: quiet });
  assert.deepEqual(ex.cancelled, ['a', 'e']);
  assert.equal(out.cancelled, 2);
  assert.equal(isPartialOrder({ clientOrderId: 'something-p' }), false);
});

test('an unreadable order book does not throw either', async () => {
  const ex = venue();
  ex.fetchOpenOrders = async () => { throw new Error('timeout'); };
  const out = await cancelPartials({ exchange: ex, symbol: ZEC, logger: quiet });
  assert.equal(out.error, 'timeout');
});

test('the P&L panel names it', () => {
  assert.equal(closeReason({ orderLinkId: 'ZECUSDTUSDT-30m-1790366400000p' }), 'partial');
  assert.equal(closeReason({ orderLinkId: 'ZECUSDTUSDT-30m-1790366400000x' }), 'flip', 'unchanged');
});

/* ---- the setting ---- */

const live = () => ({ enabled: true, execute: true, strategy: 'supertrend', exchange: 'bybit',
  symbols: [ZEC], timeframe: '1h', timeframes: ['1h'], intervalMs: 60000,
  rules: { minRR: 1.5 }, supertrend: { period: 10, multiplier: 3, rewardRisk: 2, minRR: 1.5 }, overrides: {} });
const exchanges = { bybit: { id: 'bybit', market: () => ({}) } };

test('set per symbol, with both numbers', () => {
  const s = live();
  applySettings(s, { overrides: { [ZEC]: { timeframe: '30m', partial: { pricePct: 3, sizePct: 50 } } } }, { exchanges });
  assert.deepEqual(s.overrides[ZEC].partial, { pricePct: 3, sizePct: 50 });
  applySettings(s, { overrides: { [ZEC]: { partial: { pricePct: 2.5, sizePct: 30 } } } }, { exchanges });
  assert.deepEqual(s.overrides[ZEC], { partial: { pricePct: 2.5, sizePct: 30 } }, 'alone, on an untuned symbol');
});

test('off is null, or simply not there', () => {
  const s = live();
  applySettings(s, { overrides: { [ZEC]: { timeframe: '30m', partial: null } } }, { exchanges });
  assert.equal(s.overrides[ZEC].partial, undefined);
});

test('bounded: never the whole position, never a move inside the spread', () => {
  const bad = [{ pricePct: 3, sizePct: 100 }, { pricePct: 3, sizePct: 0 }, { pricePct: 0.01, sizePct: 50 },
    { pricePct: 80, sizePct: 50 }, { pricePct: 3 }, { pricePct: 3, sizePct: 50, extra: 1 }, 'half'];
  for (const partial of bad) {
    assert.throws(() => applySettings(live(), { overrides: { [ZEC]: { partial } } }, { exchanges }), /partial/,
      JSON.stringify(partial));
  }
});

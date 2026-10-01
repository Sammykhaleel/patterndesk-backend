// Why each position closed — read from Bybit's order history.
//
// The fake below answers like Bybit's /v5/order/history: newest first, 50 a
// page at most, a cursor while more remain, and a refusal for a range over
// seven days. The fields classified are the ones Bybit actually sends on the
// orders this account placed (seen on the live account: KAT's stop-out at
// 22:44 carried stopOrderType "StopLoss"; the scanner's closes carry its own
// orderLinkId ending in "x").
const test = require('node:test');
const assert = require('node:assert/strict');
const { readCloseReasons, closeReason } = require('../closes');
const { createApp } = require('../app');

const quiet = { log() {}, warn() {}, error() {} };
const DAY = 86400000;

function bybit(orders) {
  const calls = [];
  return {
    id: 'bybit',
    calls,
    async privateGetV5OrderHistory(req) {
      calls.push({ ...req });
      if (req.endTime - req.startTime > 7 * DAY) {
        return { retCode: 10001, retMsg: 'The time range cannot exceed 7 days', result: {} };
      }
      const all = orders.filter((o) => o.createdTime >= req.startTime && o.createdTime <= req.endTime)
        .sort((a, b) => b.createdTime - a.createdTime);
      const offset = req.cursor ? Number(req.cursor) : 0;
      const limit = Math.min(Number(req.limit) || 20, 50);
      const list = all.slice(offset, offset + limit).map((o) => ({ ...o, createdTime: String(o.createdTime) }));
      return { retCode: 0, result: { list, nextPageCursor: offset + limit < all.length ? String(offset + limit) : '' } };
    },
  };
}

const order = (id, t, fields = {}) => ({ orderId: id, createdTime: t, orderLinkId: '', createType: 'CreateByUser', stopOrderType: '', ...fields });

test('each kind of close is named from the order itself', () => {
  assert.equal(closeReason({ orderLinkId: 'KATUSDTUSDT-4h-1790366400000x' }), 'flip', 'the scanner at a flip');
  assert.equal(closeReason({ orderLinkId: 'MNTUSDTUSDT-30m-1790366400000x-m1' }), 'flip', 'its limit close too');
  assert.equal(closeReason({ orderLinkId: 'KATUSDTUSDT-4h-1790366400000' }), 'hand',
    'an ENTRY id is not a close at a flip (no x)');
  assert.equal(closeReason({ stopOrderType: 'StopLoss', createType: 'CreateByStopLoss' }), 'stop', "KAT's 22:44");
  assert.equal(closeReason({ stopOrderType: 'TrailingStop' }), 'stop', 'a trailing stop is a stop');
  assert.equal(closeReason({ stopOrderType: 'TakeProfit' }), 'target');
  assert.equal(closeReason({ createType: 'CreateByLiq' }), 'liquidation');
  assert.equal(closeReason({ createType: 'CreateByAdl_PassThrough' }), 'liquidation', 'auto-deleveraging counts with it');
  assert.equal(closeReason({ createType: 'CreateByLiq', orderLinkId: 'pdabc123' }), 'liquidation',
    'the liquidation engine wins over anything else on the order');
  assert.equal(closeReason({ orderLinkId: 'pd0123456789abcdef01' }), 'app', "the Positions panel's Close");
  assert.equal(closeReason({ orderLinkId: '', createType: 'CreateByUser' }), 'hand', 'placed on Bybit itself');
  assert.equal(closeReason(null), null);
});

test('thirty days are read in seven-day windows, every page of each', async () => {
  const now = Date.UTC(2026, 9, 1, 12);
  const orders = [];
  // 130 orders in one week (three pages) and a few in the others.
  for (let i = 0; i < 130; i += 1) orders.push(order(`w${i}`, now - 2 * DAY - i * 60_000, { orderLinkId: `DOTUSDTUSDT-30m-${i}x` }));
  orders.push(order('old-stop', now - 20 * DAY, { stopOrderType: 'StopLoss' }));
  orders.push(order('old-liq', now - 29 * DAY, { createType: 'CreateByLiq' }));
  const ex = bybit(orders);
  const out = await readCloseReasons({ exchange: ex, since: now - 30 * DAY, now, logger: quiet });
  assert.equal(out.supported, true);
  assert.equal(out.truncated, false);
  assert.equal(Object.keys(out.reasons).length, 132, 'every order, the busy week included');
  assert.equal(out.reasons.w129, 'flip');
  assert.equal(out.reasons['old-stop'], 'stop');
  assert.equal(out.reasons['old-liq'], 'liquidation');
  assert.ok(ex.calls.every((c) => c.endTime - c.startTime <= 7 * DAY), 'every request is a range Bybit accepts');
  assert.ok(ex.calls.every((c) => c.category === 'linear' && c.limit === 50));
});

test('a window too busy to read in full says so', async () => {
  const now = Date.UTC(2026, 9, 1, 12);
  const orders = [];
  for (let i = 0; i < 2100; i += 1) orders.push(order(`o${i}`, now - DAY - i * 1000));
  const out = await readCloseReasons({ exchange: bybit(orders), since: now - 3 * DAY, now, logger: quiet });
  assert.equal(out.truncated, true);
});

test('a venue without the order history call is not guessed at', async () => {
  const out = await readCloseReasons({ exchange: { id: 'weex' }, since: 0, now: DAY, logger: quiet });
  assert.deepEqual(out, { supported: false, reasons: {}, truncated: false });
});

test('/api/pnl/closes answers with the reasons, behind the token', async (t) => {
  const now = Date.now();
  const ex = bybit([order('a1', now - DAY, { stopOrderType: 'StopLoss' }), order('a2', now - DAY, { orderLinkId: 'X-1h-1x' })]);
  const app = createApp({
    config: {
      authToken: 'a'.repeat(64), allowedOrigins: [], rateLimitPerMinute: 100, useTestnet: true, dryRun: true,
      tradePercentage: 5, leverage: 3, maxPositionNotional: 1000, stopLossPercent: 2, dedupeTtlMs: 60_000,
      scanner: { enabled: false, execute: false, strategy: 'supertrend', exchange: 'bybit', symbols: ['BTC/USDT:USDT'],
        timeframe: '1h', timeframes: ['1h'], intervalMs: 60_000, rules: { minRR: 1.5 },
        supertrend: { period: 10, multiplier: 3, rewardRisk: 2, minRR: 1.5 } },
    },
    getExchanges: () => ({ bybit: ex }),
    isReady: () => true,
    logger: quiet,
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/pnl/closes`)).status, 401);
  const out = await (await fetch(`${base}/api/pnl/closes?days=7`, { headers: { 'X-Auth-Token': 'a'.repeat(64) } })).json();
  assert.equal(out.success, true);
  assert.deepEqual(out.reasons, { a1: 'stop', a2: 'flip' });
  assert.equal(out.days, 7);
});

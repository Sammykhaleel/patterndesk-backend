// The ledger walk against Bybit, through the REAL ccxt code.
//
// The bug this exists for: the P&L and the daily stop read Bybit's
// transaction log by walking timestamps, and Bybit cannot be read that way.
// It answers with the NEWEST rows of the range asked for, 50 at most, and ccxt
// then re-sorts each page oldest-first — so a page looks oldest-first while
// holding only the newest rows. A request with only a start time covers 24
// hours. Two timestamp walks shipped: one kept ~50 rows a day, the next ~50 a
// week, and both reported themselves complete. A 7-day P&L held four days;
// "+13.97 this week" came from a partial read.
//
// Every earlier test faked ccxt's OUTPUT, and got its ordering wrong. This
// file runs ccxt's own bybit.fetchLedger and fakes only the HTTP endpoint
// underneath it, following Bybit's documented rules, so a wrong assumption
// about either ccxt or Bybit shows up here.

const test = require('node:test');
const assert = require('node:assert/strict');
const ccxt = require('ccxt');
const { walkLedger, readRealisedPnl } = require('../pnl');
const { readLedgerDay } = require('../scanner');

const quiet = { log() {}, warn() {}, error() {} };
const DAY = 86400000;
const HOUR = 3600000;

/**
 * A real ccxt Bybit instance whose transaction-log endpoint is a fake that
 * follows Bybit's v5 rules:
 *   - rows NEWEST first; limit default 20, max 50
 *   - only startTime → startTime .. startTime + 24h
 *   - startTime and endTime → at most 7 days apart
 *   - nextPageCursor when more rows remain
 */
function bybit(rows) {
  const ex = new ccxt.bybit({ apiKey: 'k', secret: 's' });
  const calls = [];
  ex.loadMarkets = async () => ({});
  ex.markets = {};
  ex.isUnifiedEnabled = async () => [false, true];
  ex.currency = (code) => ({ id: code, code });
  ex.privateGetV5AccountTransactionLog = async (req) => {
    calls.push({ ...req });
    const start = req.startTime !== undefined ? Number(req.startTime) : undefined;
    const end = req.endTime !== undefined ? Number(req.endTime)
      : start !== undefined ? start + DAY : Date.now();
    if (start !== undefined && end - start > 7 * DAY) {
      return { retCode: 10001, retMsg: 'The time range cannot exceed 7 days', result: {} };
    }
    const from = start !== undefined ? start : end - DAY;
    const all = rows.filter((r) => r.transactionTime >= from && r.transactionTime <= end)
      .sort((a, b) => b.transactionTime - a.transactionTime);
    const limit = Math.min(Number(req.limit) || 20, 50);
    const offset = req.cursor ? Number(req.cursor) : 0;
    const page = all.slice(offset, offset + limit).map((r) => ({
      ...r, transactionTime: String(r.transactionTime),
    }));
    const more = offset + limit < all.length;
    return { retCode: 0, result: { list: page, nextPageCursor: more ? String(offset + limit) : '' } };
  };
  ex.calls = calls;
  return ex;
}

const raw = (t, id, change, type = 'TRADE') => ({
  id: String(id), transactionTime: t, type, currency: 'USDT', symbol: 'DOTUSDT', category: 'linear',
  change: String(change), cashFlow: type === 'TRADE' ? String(change) : '0', fee: '0', cashBalance: '100',
});

test('thirty busy days are read in full', async () => {
  const now = Date.UTC(2026, 8, 25, 12);
  const rows = [];
  let i = 0;
  for (let d = 0; d < 30; d += 1) {
    for (let k = 0; k < 80; k += 1) rows.push(raw(now - d * DAY - k * 60_000 - 1000, i++, -0.05));
  }
  const ex = bybit(rows);
  const { entries, truncated } = await walkLedger({ exchange: ex, since: now - 30 * DAY, now, logger: quiet });
  assert.equal(entries.length, rows.length, `all ${rows.length} rows (above a real account's 50-65 a day)`);
  assert.equal(truncated, false);
  assert.ok(ex.calls.every((c) => c.endTime !== undefined && c.endTime - c.startTime <= 7 * DAY),
    'every request names a range Bybit accepts');
});

test('every day of the week is in a 7-day read', async () => {
  const now = Date.UTC(2026, 8, 25, 12);
  const rows = [];
  for (let d = 0; d < 7; d += 1) for (let k = 0; k < 55; k += 1) rows.push(raw(now - d * DAY - k * 60_000 - 1, `${d}-${k}`, 0.1));
  const { rows: got } = await readRealisedPnl({ exchange: bybit(rows), since: now - 7 * DAY, now, logger: quiet });
  const days = new Set(got.map((r) => new Date(r.timestamp).toISOString().slice(0, 10)));
  assert.equal(days.size, 7, 'seven days, not four');
  assert.equal(got.length, rows.length);
});

test('the daily stop finds a morning deposit on a day of 120 trades', async () => {
  const midnight = Date.UTC(2026, 8, 25);
  const rows = [raw(midnight + 60_000, 'dep', 27.5, 'TRANSFER_IN')];
  for (let k = 0; k < 120; k += 1) rows.push(raw(midnight + HOUR + k * 60_000, k, -0.05));
  const day = await readLedgerDay({ exchange: bybit(rows), since: midnight, logger: quiet });
  assert.equal(day.complete, true);
  assert.deepEqual(day.cash.map((c) => c.amount), [27.5], 'the deposit is found');
  assert.equal(day.outcomes.length, 120, 'and every trade');
});

test('a window too busy to read in full says so', async () => {
  // Past ccxt's call limit per window it stops following the cursor without
  // saying so; the walk must not present that as complete.
  const now = Date.UTC(2026, 8, 25, 12);
  const rows = [];
  for (let k = 0; k < 2100; k += 1) rows.push(raw(now - HOUR - k * 1000, k, 0.01));
  const { truncated } = await walkLedger({ exchange: bybit(rows), since: now - DAY, now, logger: quiet });
  assert.equal(truncated, true);
});

test('the fake is Bybit, not a convenience', async () => {
  // Pins the two rules the walks got wrong, against ccxt itself: a page is the
  // NEWEST rows of the range, and a bare start time covers 24 hours.
  const now = Date.UTC(2026, 8, 25, 12);
  const rows = [];
  for (let k = 0; k < 100; k += 1) rows.push(raw(now - 3 * DAY + k * HOUR, k, 0.1));
  const ex = bybit(rows);
  const page = await ex.fetchLedger('USDT', now - 3 * DAY, 50);
  assert.equal(page.length, 25, 'startTime alone: the next 24 hours only, both ends included');
  const week = await ex.fetchLedger('USDT', now - 3 * DAY, 50, { endTime: now });
  assert.equal(week.length, 50);
  // Rows 0..72 fall inside the range (hourly, 72 hours); the newest fifty are
  // 23..72, and ccxt hands them back oldest-first — 23 first, not 0.
  assert.equal(Number(week[0].info.id), 23, 'the NEWEST fifty, re-sorted oldest-first by ccxt');
  assert.equal(Number(week[49].info.id), 72);
});

test('each P&L row says how its fill was charged', async () => {
  // Through ccxt: Bybit's feeRate, qty, tradePrice and orderId reach the row,
  // so the panel can say which entries filled as limit orders.
  const now = Date.UTC(2026, 8, 25, 12);
  const rows = [
    { ...raw(now - HOUR, 'a', -0.0057), feeRate: '0.0002', qty: '42.6', tradePrice: '0.6702', orderId: 'lim-1' },
    { ...raw(now - HOUR + 1, 'b', -0.0157), feeRate: '0.00055', qty: '42.6', tradePrice: '0.6702', orderId: 'mkt-1' },
  ];
  const { rows: got } = await readRealisedPnl({ exchange: bybit(rows), since: now - DAY, now, logger: quiet });
  const byOrder = Object.fromEntries(got.map((r) => [r.fill && r.fill.orderId, r.fill]));
  assert.equal(byOrder['lim-1'].maker, true);
  assert.equal(byOrder['mkt-1'].maker, false);
  assert.ok(Math.abs(byOrder['mkt-1'].notional - 28.55) < 0.01);
});

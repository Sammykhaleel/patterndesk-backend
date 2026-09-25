// The ledger walk against a venue that behaves like Bybit's transaction log.
//
// The bug this exists for: Bybit returns rows NEWEST FIRST, at most 50 a page,
// for a range of at most seven days. The walk was written for oldest-first
// venues — after each page it jumped past the newest row it had seen — so on
// Bybit it kept about one page per window and skipped the rest, while
// reporting the read as complete. A 7-day P&L covered four of the seven days;
// a 30-day one had whole days missing and ~50 rows on the rest. Every test
// before this one used an oldest-first fake, which is why none of them saw it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { walkLedger, readRealisedPnl } = require('../pnl');
const { readLedgerDay } = require('../scanner');

const quiet = { log() {}, warn() {}, error() {} };
const DAY = 86400000;

/** Newest first; startTime/endTime honoured; 7-day range cap; 20 default, 50 max. */
function bybit(rows) {
  const calls = [];
  return {
    id: 'bybit', calls, has: { fetchLedger: true },
    async fetchLedger(code, since, limit, params = {}) {
      calls.push({ since, limit, endTime: params.endTime });
      const end = params.endTime !== undefined ? params.endTime : since + 7 * DAY;
      // Treated as a hard ceiling, reached AT seven days: the walk is meant to
      // stay strictly inside it rather than depend on which side of the
      // boundary the venue counts.
      if (end - since >= 7 * DAY) throw new Error('The time range cannot exceed 7 days');
      return rows
        .filter((r) => r.timestamp >= since && r.timestamp <= end)
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, Math.min(limit || 20, 50));
    },
  };
}

const trade = (t, i, amt = 0.1) => ({ id: `t${i}`, timestamp: t, type: 'trade', amount: Math.abs(amt),
  direction: amt < 0 ? 'out' : 'in', info: { cashFlow: String(amt), fee: '0' } });

test('thirty busy days are read in full', async () => {
  const now = Date.UTC(2026, 8, 25, 12);
  const rows = [];
  let i = 0;
  for (let d = 0; d < 30; d += 1) {
    for (let k = 0; k < 80; k += 1) rows.push(trade(now - (d * DAY) - k * 60_000 - 1000, i++));   // above the real 50-65 a day
  }
  const ex = bybit(rows);
  const { entries, truncated } = await walkLedger({ exchange: ex, since: now - 30 * DAY, now, logger: quiet });
  assert.equal(entries.length, rows.length, `all ${rows.length} rows, not a page a window`);
  assert.equal(truncated, false);
  assert.ok(ex.calls.every((c) => c.endTime - c.since <= 7 * DAY), 'no request asks for more than seven days');
  assert.ok(ex.calls.length < 80, `a sensible number of requests (${ex.calls.length})`);
});

test('every day of the week is in a 7-day read', async () => {
  // The shape seen live: rows from four of the seven days.
  const now = Date.UTC(2026, 8, 25, 12);
  const rows = [];
  for (let d = 0; d < 7; d += 1) for (let k = 0; k < 55; k += 1) rows.push(trade(now - d * DAY - k * 60_000 - 1, `${d}-${k}`));
  const { rows: got } = await readRealisedPnl({ exchange: bybit(rows), since: now - 7 * DAY, now, logger: quiet });
  const days = new Set(got.map((r) => new Date(r.timestamp).toISOString().slice(0, 10)));
  assert.equal(days.size, 7, 'seven days, not four');
  assert.equal(got.length, rows.length);
});

test('rows sharing a millisecond across a page boundary are all read', async () => {
  const now = Date.UTC(2026, 8, 25, 12);
  const t = now - DAY;
  const rows = [];
  for (let k = 0; k < 120; k += 1) rows.push(trade(t, `same${k}`));      // 120 rows, one timestamp
  rows.push(trade(t - 5000, 'older'));
  const { entries, truncated } = await walkLedger({ exchange: bybit(rows), since: now - 7 * DAY, now, logger: quiet });
  // Bybit cannot page past 50 rows that share one millisecond by time alone.
  // What matters is that the older row is still reached and the read admits
  // what it could not see rather than calling itself complete.
  assert.ok(entries.some((e) => e.id === 'tolder'), 'the older row is not lost behind them');   // trade() prefixes ids with t
  if (entries.length < rows.length) assert.equal(truncated, true, 'and a partial read says so');
});

test("the daily stop finds a morning deposit on a day of 120 trades", async () => {
  // Yesterday's fix was tested on a 25-row day, under one page. Real days run
  // to 50-65 rows, and the deposit is the oldest of them.
  const midnight = Date.UTC(2026, 8, 25);
  const rows = [{ id: 'dep', timestamp: midnight + 60_000, type: 'transaction', amount: 27.5, direction: 'in' }];
  for (let k = 0; k < 120; k += 1) rows.push(trade(midnight + 3_600_000 + k * 60_000, k, -0.05));
  const ex = bybit(rows);
  const day = await readLedgerDay({ exchange: ex, since: midnight, logger: quiet });
  assert.equal(day.complete, true);
  assert.deepEqual(day.cash.map((c) => c.amount), [27.5], 'the deposit is found');
  assert.equal(day.outcomes.length, 120, 'and every trade');
});

test('a full page that reaches the start of its window ends the window', async () => {
  // Fifty rows, the oldest exactly at the start: the window is read, and
  // asking again for what lies before its start would be a wasted request.
  const S = Date.UTC(2026, 8, 20);
  const rows = [trade(S, 'first')];
  for (let k = 1; k < 50; k += 1) rows.push(trade(S + k * 60_000, k));
  const ex = bybit(rows);
  const { entries, truncated } = await walkLedger({ exchange: ex, since: S, now: S + DAY, logger: quiet });
  assert.equal(entries.length, 50);
  assert.equal(truncated, false);
  assert.equal(ex.calls.length, 1, 'one request');
});

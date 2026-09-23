// The daily loss limit, measured across a deposit or a withdrawal.
//
// The bug this exists for: the baseline is the balance the day opened at, and
// equity is compared against it once a minute. Money transferred INTO the
// account raises equity without anything having been earned, so the day's
// allowance quietly grows by the size of the transfer — $50 funded into a
// $4.23 account left a 50% limit unable to fire until nearly the whole
// deposit was gone. A withdrawal has the mirror problem: it reads as a loss
// and can halt trading on a transfer.
//
// The fix reads the same ledger the losing streak already reads, tells the
// two kinds of row apart with the shared classifier, and adds the transfers
// to the baseline. What is written to disk stays the RAW opening balance —
// persisting an adjusted figure would add the deposit again on restart.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DailyLossBreaker, readLedgerDay } = require('../scanner');

const quiet = { log() {}, warn() {}, error() {} };
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cashflow-'));

// An hour ago, so a transfer can be placed either side of the moment the
// baseline was taken without either one landing in the future.
const OPENED = Date.now() - 3_600_000;

/** A breaker that opened the day at `baseline`, an hour ago. */
function openedAt(baseline, opts = {}) {
  const b = new DailyLossBreaker({ maxDailyLossPercent: 50, failClosed: false, ...opts });
  b.update(baseline, quiet);
  b.baselineAt = OPENED;
  return b;
}

const deposit = (amount, timestamp = OPENED + 1000) => ({ timestamp, amount });
// Balances are compared to the cent: 4.23 + 50 is 54.230000000000004 in
// binary floating point, and that is not what this file is testing.
const money = (n) => Number(Number(n).toFixed(2));

/* ------------------------------------------------------------------ *
 * What the limit is measured against
 * ------------------------------------------------------------------ */

test('a deposit raises the baseline by its own size, not by more', () => {
  const b = openedAt(4.23);
  assert.equal(money(b.effectiveBaseline()), 4.23);

  b.noteCashFlow([deposit(50, OPENED + 1000)], quiet);

  assert.equal(money(b.effectiveBaseline()), 54.23);
  assert.equal(b.baseline, 4.23, 'the opening balance itself is untouched');
});

test('the deposit is not counted as profit, and not as a loss either', () => {
  // The account is funded and nothing is traded. Equity is now 54.23 against
  // an opening balance of 4.23 — a 1,182% gain if the transfer were read as
  // one, and 0% once it is understood.
  const b = openedAt(4.23);
  b.noteCashFlow([deposit(50, OPENED + 1000)], quiet);
  b.update(54.23, quiet);

  assert.equal(b.blocked, false);
  assert.equal(money(b.effectiveBaseline()), 54.23, 'the day is flat, not up');
});

test('the limit fires on half of the funded balance, not half of the old one', () => {
  // This is the behaviour the deposit broke. Before the fix the baseline
  // stayed at 4.23 and a 50% limit halted at 2.12 — the account would have
  // had to lose 96% of itself first.
  const b = openedAt(4.23);
  b.noteCashFlow([deposit(50, OPENED + 1000)], quiet);

  b.update(30, quiet);
  assert.equal(b.blocked, false, '30 of 54.23 is down 45%, inside the limit');

  b.update(27, quiet);
  assert.equal(b.blocked, true, 'but half of the funded balance is a halt');
  assert.match(b.reason, /down 50\.\d\d% today/);
});

test('a withdrawal lowers the baseline, so a transfer out is not a loss', () => {
  const b = openedAt(100);
  b.noteCashFlow([deposit(-60, OPENED + 1000)], quiet);

  assert.equal(money(b.effectiveBaseline()), 40);
  b.update(40, quiet);
  assert.equal(b.blocked, false, 'taking money out is not losing it');

  b.update(19, quiet);
  assert.equal(b.blocked, true, 'while a real loss on what is left still halts');
});

/* ------------------------------------------------------------------ *
 * Counting the same transfer twice
 * ------------------------------------------------------------------ */

test('re-reading the same ledger does not add the deposit again', () => {
  // The sweep reads the whole day every minute. An implementation that added
  // an increment would grow the baseline by $50 a minute forever.
  const b = openedAt(4.23);
  const rows = [deposit(50, OPENED + 1000)];

  for (let i = 0; i < 10; i += 1) b.noteCashFlow(rows, quiet);

  assert.equal(money(b.effectiveBaseline()), 54.23);
});

test('only the first read of a transfer is announced', () => {
  const said = [];
  const b = openedAt(4.23);
  const rows = [deposit(50, OPENED + 1000)];

  assert.equal(b.noteCashFlow(rows, { ...quiet, warn: (m) => said.push(m) }), true);
  assert.equal(b.noteCashFlow(rows, { ...quiet, warn: (m) => said.push(m) }), false);
  assert.equal(said.length, 1, 'a deposit is news once, not once a minute');
  assert.match(said[0], /deposit of 50\.00/);
  assert.match(said[0], /54\.23/, 'and says what the limit now measures against');
});

test('a second deposit adds only the difference', () => {
  const now = OPENED;
  const b = openedAt(10);
  b.noteCashFlow([deposit(50, now + 1000)], quiet);
  b.noteCashFlow([deposit(50, now + 1000), deposit(25, now + 2000)], quiet);
  assert.equal(money(b.effectiveBaseline()), 85);
});

test('the raw baseline is what reaches the disk', () => {
  // Saving the adjusted figure would be the double-count bug in slow motion:
  // restart, re-read the ledger, add the same deposit to a number that
  // already contains it.
  const dir = tmpdir();
  const b = new DailyLossBreaker({ maxDailyLossPercent: 50, failClosed: false, statePath: path.join(dir, 'b.json') });
  b.update(4.23, quiet);
  b.baselineAt = OPENED;
  b.noteCashFlow([deposit(50, OPENED + 1000)], quiet);

  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'b.json'), 'utf8'));
  assert.equal(saved.baseline, 4.23, 'the opening balance, not the adjusted one');
  assert.equal(saved.cashFlow, 50, 'with the adjustment kept separately');
});

test('a restart restores both, and re-reading the ledger changes nothing', () => {
  const dir = tmpdir();
  const statePath = path.join(dir, 'b.json');
  const rows = [deposit(50, OPENED + 1000)];

  const first = new DailyLossBreaker({ maxDailyLossPercent: 50, failClosed: false, statePath });
  first.update(4.23, quiet);
  first.baselineAt = OPENED;
  first.noteCashFlow(rows, quiet);

  const second = new DailyLossBreaker({ maxDailyLossPercent: 50, failClosed: false, statePath });
  second.load(quiet);
  assert.equal(second.baseline, 4.23);
  assert.equal(money(second.effectiveBaseline()), 54.23, 'the adjustment survived');

  second.noteCashFlow(rows, quiet);
  assert.equal(money(second.effectiveBaseline()), 54.23, 'and was not applied twice');
});

test('a restart still knows which transfers were already in the baseline', () => {
  // The restored figure of 54.23 contains the deposit. Without the moment it
  // was taken, a restart cannot tell that transfer from a new one and adds it
  // again — which is the double-count this design exists to avoid, arriving
  // by the back door.
  const dir = tmpdir();
  const statePath = path.join(dir, 'b.json');
  const alreadyIn = [deposit(50, OPENED - 60_000)];

  const first = new DailyLossBreaker({ maxDailyLossPercent: 50, failClosed: false, statePath });
  first.update(54.23, quiet);
  first.baselineAt = OPENED;
  first.save(quiet);
  first.noteCashFlow(alreadyIn, quiet);
  assert.equal(money(first.effectiveBaseline()), 54.23);

  const second = new DailyLossBreaker({ maxDailyLossPercent: 50, failClosed: false, statePath });
  second.load(quiet);
  second.noteCashFlow(alreadyIn, quiet);
  assert.equal(money(second.effectiveBaseline()), 54.23, 'and not on the way back up either');
});

/* ------------------------------------------------------------------ *
 * Transfers already inside the balance that was read
 * ------------------------------------------------------------------ */

test('a transfer from before the baseline was taken is already in it', () => {
  // Equity is read first and the baseline is taken from it. A deposit that
  // landed an hour earlier is part of that reading, so adding it would count
  // it twice.
  const b = openedAt(54.23);
  b.noteCashFlow([deposit(50, OPENED - 60_000)], quiet);
  assert.equal(money(b.effectiveBaseline()), 54.23);
});

test('a transfer stamped at the exact moment of the baseline is inside it', () => {
  // The balance was read at that instant, so the money is already in it.
  // Counting it would add the deposit to a figure that has it.
  const b = openedAt(54.23);
  b.noteCashFlow([deposit(50, OPENED)], quiet);
  assert.equal(money(b.effectiveBaseline()), 54.23);

  // A millisecond later is a different matter.
  b.noteCashFlow([deposit(50, OPENED + 1)], quiet);
  assert.equal(money(b.effectiveBaseline()), 104.23);
});

test('a new UTC day starts the transfer total again', () => {
  const b = openedAt(4.23);
  b.noteCashFlow([deposit(50, OPENED + 1000)], quiet);
  assert.equal(money(b.effectiveBaseline()), 54.23);

  // Rollover: the balance read at midnight already contains the deposit.
  b.day = '1999-01-01';
  b.update(54.23, quiet);

  assert.equal(b.baseline, 54.23);
  assert.equal(b.cashFlow, 0, 'yesterday\'s transfers are not tomorrow\'s');
  assert.equal(money(b.effectiveBaseline()), 54.23, 'and are not added on top of themselves');
});

test('resuming a halt re-bases from the funded balance, once', () => {
  const b = openedAt(100);
  b.update(40, quiet);
  assert.equal(b.blocked, true);

  const rows = [deposit(50, OPENED + 1000)];
  b.noteCashFlow(rows, quiet);
  b.update(90, quiet);                 // equity now includes the deposit
  assert.equal(b.resume(quiet), true);

  assert.equal(b.baseline, 90, 're-based from the reading that has the deposit in it');
  assert.equal(b.cashFlow, 0);
  b.noteCashFlow(rows, quiet);
  assert.equal(money(b.effectiveBaseline()), 90, 'and the same deposit is not added again');
});

/* ------------------------------------------------------------------ *
 * When the ledger cannot be read
 * ------------------------------------------------------------------ */

test('a ledger that cannot be read leaves the last known total alone', () => {
  // "Cannot tell" is not "nothing moved". Dropping a known deposit because
  // one API call failed would put the limit back on the wrong number.
  const b = openedAt(4.23);
  b.noteCashFlow([deposit(50, OPENED + 1000)], quiet);

  assert.equal(b.noteCashFlow(null, quiet), false);
  assert.equal(money(b.effectiveBaseline()), 54.23);
  assert.equal(b.noteCashFlow(undefined, quiet), false);
  assert.equal(money(b.effectiveBaseline()), 54.23);
});

test('a day with no transfers is not a day with an unknown baseline', () => {
  const b = openedAt(4.23);
  assert.equal(b.noteCashFlow([], quiet), false);
  assert.equal(money(b.effectiveBaseline()), 4.23);
});

test('rows with nothing usable in them are skipped, not guessed at', () => {
  const b = openedAt(100);
  b.noteCashFlow([
    { timestamp: OPENED + 1000, amount: null },
    { timestamp: null, amount: 25 },
    // No timestamp at all. There is no way to tell whether this is already
    // inside the baseline, and "assume it is not" adds money to the
    // allowance on the strength of a row we could not read.
    { amount: 25 },
    null,
    deposit(10, OPENED + 1000),
  ], quiet);
  assert.equal(money(b.effectiveBaseline()), 110, 'only the row that said both things');
});

test('no baseline means no adjusted baseline to report', () => {
  const b = new DailyLossBreaker({ maxDailyLossPercent: 50, failClosed: false });
  assert.equal(b.effectiveBaseline(), null);
  b.noteCashFlow([deposit(50)], quiet);
  assert.equal(b.effectiveBaseline(), null, 'a transfer alone is not a baseline');
});

/* ------------------------------------------------------------------ *
 * Telling the two kinds of ledger row apart
 * ------------------------------------------------------------------ */

const ledgerExchange = (entries) => ({
  has: { fetchLedger: true },
  async fetchLedger() { return entries; },
});

test('one ledger read answers both questions, and no row answers both', () => {
  const t = Date.UTC(2026, 8, 23, 12, 0, 0);
  const ex = ledgerExchange([
    { id: '1', timestamp: t + 1, type: 'trade', amount: 2, direction: 'out', info: { cashFlow: '-1.8', fee: '0.2' } },
    { id: '2', timestamp: t + 2, type: 'transaction', amount: 50, direction: 'in' },
    { id: '3', timestamp: t + 3, type: 'funding', amount: -0.01 },
    { id: '4', timestamp: t + 4, type: 'trade', amount: 3, direction: 'in', info: { cashFlow: '3.2', fee: '0.2' } },
    { id: '5', timestamp: t + 5, type: 'transfer_out', amount: 20, direction: 'out' },
  ]);

  return readLedgerDay({ exchange: ex, since: t, logger: quiet }).then((day) => {
    assert.deepEqual(day.outcomes.map((o) => o.amount), [-2, 3], 'the trades, with fees taken');
    assert.deepEqual(day.cash.map((c) => c.amount), [50, -20], 'the transfers, in and out');

    const claimed = [...day.outcomes, ...day.cash].map((r) => r.timestamp);
    assert.equal(new Set(claimed).size, claimed.length, 'no row is both a trade and a transfer');
  });
});

test('funding and fees never reach the baseline', () => {
  // Funding is money genuinely leaving the account and belongs in the day's
  // loss. Treating it as a withdrawal would lower the baseline to match and
  // the charge would become invisible.
  const t = Date.UTC(2026, 8, 23, 12, 0, 0);
  const ex = ledgerExchange([
    { id: '1', timestamp: t + 1, type: 'funding', amount: -0.5 },
    { id: '2', timestamp: t + 2, type: 'fee', amount: -0.1 },
    { id: '3', timestamp: t + 3, type: 'commission', amount: -0.1 },
  ]);
  return readLedgerDay({ exchange: ex, since: t, logger: quiet })
    .then((day) => assert.deepEqual(day.cash, []));
});

test('transfers before the window are not today\'s transfers', () => {
  const t = Date.UTC(2026, 8, 23, 0, 0, 0);
  const ex = ledgerExchange([
    { id: '1', timestamp: t - 1000, type: 'transaction', amount: 500, direction: 'in' },
    { id: '2', timestamp: t + 1000, type: 'transaction', amount: 50, direction: 'in' },
  ]);
  return readLedgerDay({ exchange: ex, since: t, logger: quiet })
    .then((day) => assert.deepEqual(day.cash.map((c) => c.amount), [50]));
});

test('an exchange with no ledger reports nothing rather than zero', () => {
  return readLedgerDay({ exchange: { has: {} }, since: 0, logger: quiet })
    .then((day) => assert.equal(day, null, 'null, so the breaker keeps what it knows'));
});

test('a ledger that answers with something other than a list reports nothing', () => {
  // An error object where an array was expected is not an empty day. Reading
  // it as one would reset the losing streak and drop the day's transfers.
  const ex = { has: { fetchLedger: true }, async fetchLedger() { return { retCode: 10006 }; } };
  return readLedgerDay({ exchange: ex, since: 0, logger: quiet })
    .then((day) => assert.equal(day, null));
});

test('a ledger call that throws twice reports nothing', () => {
  const ex = { has: { fetchLedger: true }, async fetchLedger() { throw new Error('nope'); } };
  return readLedgerDay({ exchange: ex, since: 0, logger: quiet })
    .then((day) => assert.equal(day, null));
});

/* ------------------------------------------------------------------ *
 * Reading the WHOLE day
 * ------------------------------------------------------------------ */

// Behaves like Bybit's transaction log: rows at or after `since`, newest
// first, 20 per call unless a limit is asked for, 50 at most.
function bybitLike(rows) {
  const calls = [];
  return {
    calls,
    has: { fetchLedger: true },
    async fetchLedger(code, since, limit) {
      calls.push({ since, limit });
      const lim = Math.min(limit || 20, 50);
      return rows
        .filter((r) => since === undefined || r.timestamp >= since)
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, lim);
    },
  };
}

const MIDNIGHT = Date.UTC(2026, 8, 23);
function busyDay(trades) {
  const rows = [{ id: 'dep', timestamp: MIDNIGHT + 60_000, type: 'transaction', amount: 27.5, direction: 'in' }];
  for (let i = 0; i < trades; i += 1) {
    rows.push({ id: `t${i}`, timestamp: MIDNIGHT + 3_600_000 + i * 60_000, type: 'trade',
      amount: 0.1, direction: 'out', info: { cashFlow: '-0.08', fee: '0.02' } });
  }
  return rows;
}

test('a deposit made before twenty trades is still found', async () => {
  // The shipped bug: one call, twenty newest rows, and the morning's deposit
  // was the twenty-sixth. The total was recomputed from what was left as
  // zero, and the limit went back to measuring from the pre-deposit balance.
  const ex = bybitLike(busyDay(25));
  const day = await readLedgerDay({ exchange: ex, since: MIDNIGHT, logger: quiet });
  assert.equal(day.complete, true);
  assert.deepEqual(day.cash.map((c) => c.amount), [27.5], 'the deposit is in the day');
  assert.equal(day.outcomes.length, 25, 'and so is every trade');
  assert.ok(ex.calls.every((c) => c.limit === 50), 'asking for full pages, not the default twenty');
});

test('and it reaches the breaker, so the limit stays on the funded balance', async () => {
  const ex = bybitLike(busyDay(25));
  const b = new DailyLossBreaker({ maxDailyLossPercent: 50, failClosed: false });
  b.update(4.23, quiet);
  b.baselineAt = MIDNIGHT;
  const day = await readLedgerDay({ exchange: ex, since: MIDNIGHT, logger: quiet });
  b.noteCashFlow(day.cash, quiet);
  assert.equal(money(b.effectiveBaseline()), 31.73);
});

test('a day that could not be read in full reports no transfer total', async () => {
  // A partial read that happens to miss the deposit would otherwise zero the
  // adjustment. Null tells the breaker to keep what it last knew.
  const ex = bybitLike(busyDay(25));
  ex.fetchLedger = async (code, since) => {
    if (since !== undefined) throw new Error("Parameter 'startTime' is invalid");
    return busyDay(25).slice(-20);                 // one unfiltered page
  };
  const day = await readLedgerDay({ exchange: ex, since: MIDNIGHT, logger: quiet });
  assert.equal(day.complete, false);
  assert.equal(day.cash, null, 'no total from part of a day');
  assert.ok(day.outcomes.length > 0, 'while the trades it did see still count toward the streak');

  const b = openedAt(4.23);
  b.noteCashFlow([deposit(27.5)], quiet);
  b.noteCashFlow(day.cash, quiet);
  assert.equal(money(b.effectiveBaseline()), 31.73, 'the known deposit survives the partial read');
});

test('a walk cut short by its request budget is partial too', async () => {
  // Endless full pages whose timestamps never advance: the walk gives up and
  // says so, and the day it read is not trusted for the transfer total.
  const stuck = [];
  for (let i = 0; i < 50; i += 1) stuck.push({ id: `s${i}`, timestamp: MIDNIGHT + 1000, type: 'trade', amount: 0.1, direction: 'out' });
  const ex = { has: { fetchLedger: true }, async fetchLedger() { return stuck; } };
  const day = await readLedgerDay({ exchange: ex, since: MIDNIGHT, logger: quiet });
  assert.equal(day.complete, false);
  assert.equal(day.cash, null);
});

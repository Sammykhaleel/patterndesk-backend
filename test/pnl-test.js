'use strict';

/**
 * Realised P&L, per symbol.
 *
 * The breaker already reads these rows and keeps only the amount. What is
 * asserted here is mostly about not lying: that a month means a month rather
 * than the last page the venue happened to return, that a row whose symbol
 * cannot be translated is still counted, and that a partial answer says so.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { readRealisedPnl, summarise, ledgerSymbol, signedLedgerAmount, isRealisedPnl } = require('../pnl');
const { RequestError } = require('../trading');

const quiet = { log() {}, warn() {}, error() {} };
const DAY = 86400000;

/** A venue whose ledger honours `since` and pages like a real one. */
function ledgerExchange(entries, { pageSize = 200, markets_by_id = null } = {}) {
  const calls = [];
  return {
    has: { fetchLedger: true },
    markets_by_id,
    calls,
    async fetchLedger(code, since, limit) {
      calls.push({ code, since, limit });
      const size = limit || pageSize;
      return entries
        .filter((e) => !since || e.timestamp >= since)
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(0, size);
    },
  };
}

const pnlRow = (t, symbol, amount) => ({
  id: `${symbol}-${t}`, timestamp: t, type: 'realised_pnl', amount, direction: amount < 0 ? 'out' : 'in',
  info: { symbol },
});

test('rows carry the symbol, which is the whole point', async () => {
  const now = Date.now();
  const ex = ledgerExchange([
    pnlRow(now - DAY, 'MNT/USDT:USDT', 0.4),
    pnlRow(now - 2 * DAY, 'TRX/USDT:USDT', -0.06),
  ]);
  const { rows } = await readRealisedPnl({ exchange: ex, since: now - 7 * DAY, logger: quiet });
  assert.deepEqual(rows.map((r) => r.symbol).sort(), ['MNT/USDT:USDT', 'TRX/USDT:USDT']);
  assert.equal(rows.find((r) => r.symbol.startsWith('MNT')).amount, 0.4);
});

test('fees and funding are not profit', async () => {
  const now = Date.now();
  const ex = ledgerExchange([
    pnlRow(now - DAY, 'MNT/USDT:USDT', 0.4),
    { id: 'f1', timestamp: now - DAY, type: 'funding', amount: -0.01, direction: 'out', info: { symbol: 'MNT/USDT:USDT' } },
    { id: 'f2', timestamp: now - DAY, type: 'commission', amount: -0.02, direction: 'out', info: { symbol: 'MNT/USDT:USDT' } },
  ]);
  const { rows } = await readRealisedPnl({ exchange: ex, since: now - 7 * DAY, logger: quiet });
  assert.equal(rows.length, 1, 'only the closed trade');
  assert.equal(summarise(rows).total, 0.4);
});

test('a month is a month, not the last page', async () => {
  // A venue returns its most recent rows and stops. Taking the first page
  // would report a month of trading from its final days — quietly, and most
  // wrongly for the symbols that trade most.
  const now = Date.now();
  const entries = [];
  for (let i = 0; i < 260; i += 1) entries.push(pnlRow(now - (260 - i) * 3600000, 'DOT/USDT:USDT', 1));

  const ex = ledgerExchange(entries);
  const { rows, truncated } = await readRealisedPnl({
    exchange: ex, since: now - 30 * DAY, pageSize: 50, logger: quiet,
  });
  assert.equal(rows.length, 260, 'every row was read');
  assert.equal(truncated, false, 'and it knows it got them all');
  assert.ok(ex.calls.length > 1, 'which took more than one page');
});

test('the same row seen twice is counted once', async () => {
  // Paging by timestamp re-reads the boundary, and a double-counted win is a
  // report that flatters the account.
  const now = Date.now();
  const shared = now - DAY;
  const entries = [
    pnlRow(shared, 'A/USDT:USDT', 1),
    pnlRow(shared, 'B/USDT:USDT', 1),
    pnlRow(shared + 1000, 'C/USDT:USDT', 1),
  ];
  const ex = {
    has: { fetchLedger: true },
    async fetchLedger(code, since, limit) {
      // Deliberately sloppy: always returns from `since` INCLUSIVE and a full
      // page, the way a venue that pages by time does.
      return entries.filter((e) => !since || e.timestamp >= since).slice(0, limit || 2);
    },
  };
  const { rows } = await readRealisedPnl({ exchange: ex, since: now - 7 * DAY, pageSize: 2, logger: quiet });
  assert.equal(rows.length, 3, 'three rows, not more');
  assert.equal(summarise(rows).total, 3);
});

test('a venue that ignores `since` does not spin for ever', async () => {
  const now = Date.now();
  const ex = {
    has: { fetchLedger: true },
    calls: 0,
    async fetchLedger(code, since, limit) {
      this.calls += 1;
      // Always the same page, whatever it is asked.
      return [pnlRow(now - DAY, 'X/USDT:USDT', 1), pnlRow(now - DAY, 'Y/USDT:USDT', 1)];
    },
  };
  const { rows, truncated } = await readRealisedPnl({
    exchange: ex, since: now - 30 * DAY, pageSize: 2, maxPages: 25, logger: quiet,
  });
  assert.ok(ex.calls <= 3, `stopped quickly, not after 25 pages (made ${ex.calls})`);
  assert.equal(rows.length, 2, 'with what it could read');
  assert.equal(truncated, true, 'and said the answer is partial');
});

test('a later page failing reports what was read, rather than nothing', async () => {
  const now = Date.now();
  let call = 0;
  const ex = {
    has: { fetchLedger: true },
    async fetchLedger(code, since, limit) {
      call += 1;
      if (call === 1) return Array.from({ length: 2 }, (_, i) => pnlRow(now - (10 - i) * 3600000, 'A/USDT:USDT', 1));
      throw new Error('rate limited');
    },
  };
  const { rows, truncated } = await readRealisedPnl({ exchange: ex, since: now - 30 * DAY, pageSize: 2, logger: quiet });
  assert.equal(rows.length, 2, 'the first page survives');
  assert.equal(truncated, true, 'and the gap is admitted');
});

test('a first page that fails is a failure, not an empty report', async () => {
  // Zero rows and "you made nothing this month" must not be the same answer.
  const ex = { has: { fetchLedger: true }, async fetchLedger() { throw new Error('bad token'); } };
  await assert.rejects(
    () => readRealisedPnl({ exchange: ex, since: Date.now() - DAY, logger: quiet }),
    (e) => e instanceof RequestError && /Could not read the ledger/.test(e.message)
  );
});

test('a venue with no ledger says so', async () => {
  const ex = { has: {} };
  await assert.rejects(
    () => readRealisedPnl({ exchange: ex, since: 0, logger: quiet }),
    (e) => /cannot report a ledger/.test(e.message)
  );
});

test('a venue id is translated to the symbol the app uses', () => {
  const ex = { markets_by_id: { MNTUSDT: { symbol: 'MNT/USDT:USDT' } } };
  assert.equal(ledgerSymbol({ info: { symbol: 'MNTUSDT' } }, ex), 'MNT/USDT:USDT',
    'so a row can be matched against a scanner symbol');
  assert.equal(ledgerSymbol({ symbol: 'DOT/USDT:USDT', info: {} }, ex), 'DOT/USDT:USDT',
    'a unified symbol is taken as-is');
});

test('an untranslatable id is kept, not dropped', () => {
  // Dropping the row loses the money it represents; an odd-looking group name
  // is still a group.
  assert.equal(ledgerSymbol({ info: { symbol: 'WEIRDUSDT' } }, { markets_by_id: {} }), 'WEIRDUSDT');
  assert.equal(ledgerSymbol({ info: {} }, {}), null, 'and a row with no symbol at all is honest about it');
});

test('a row with no symbol still counts toward the total', async () => {
  const now = Date.now();
  const ex = ledgerExchange([
    { id: 'n1', timestamp: now - DAY, type: 'realised_pnl', amount: 0.5, direction: 'in', info: {} },
    pnlRow(now - DAY, 'MNT/USDT:USDT', 0.4),
  ]);
  const { rows } = await readRealisedPnl({ exchange: ex, since: now - 7 * DAY, logger: quiet });
  const out = summarise(rows);
  assert.equal(out.total.toFixed(2), '0.90', 'the money is counted');
  assert.ok(out.symbols.some((s) => s.symbol === 'unknown'), 'under a name that admits what it is');
});

test('the summary keeps wins and losses apart as well as netted', () => {
  // +0.02 made of a +4 and a -3.98 is a different animal from a symbol that
  // drifted there, and the net alone cannot tell them apart.
  const now = Date.now();
  const rows = [
    { timestamp: now, symbol: 'A/USDT:USDT', amount: 4 },
    { timestamp: now, symbol: 'A/USDT:USDT', amount: -3.98 },
    { timestamp: now, symbol: 'B/USDT:USDT', amount: 0.02 },
  ];
  const out = summarise(rows);
  const a = out.symbols.find((s) => s.symbol === 'A/USDT:USDT');
  assert.equal(Number(a.net.toFixed(2)), 0.02);
  assert.equal(a.wins, 4);
  assert.equal(Number(a.losses.toFixed(2)), -3.98);
  assert.equal(a.trades, 2);
  assert.equal(a.won, 1);
  assert.equal(a.lost, 1);
  assert.equal(Number(out.total.toFixed(2)), 0.04, 'and the combined figure is the sum of everything');
});

test('symbols are ranked by what they made', () => {
  const rows = [
    { timestamp: 1, symbol: 'LOSER/USDT:USDT', amount: -5 },
    { timestamp: 2, symbol: 'WINNER/USDT:USDT', amount: 9 },
    { timestamp: 3, symbol: 'MIDDLE/USDT:USDT', amount: 1 },
  ];
  assert.deepEqual(summarise(rows).symbols.map((s) => s.symbol),
    ['WINNER/USDT:USDT', 'MIDDLE/USDT:USDT', 'LOSER/USDT:USDT']);
});

test('an empty ledger is zero, not an error', () => {
  const out = summarise([]);
  assert.equal(out.total, 0);
  assert.equal(out.trades, 0);
  assert.deepEqual(out.symbols, []);
});

test('the signed amount agrees with the breaker on what a loss is', () => {
  // Two readings of "was this a loss" that disagree would be worse than
  // either, since one of them halts the account.
  assert.equal(signedLedgerAmount({ amount: 5, direction: 'out' }), -5);
  assert.equal(signedLedgerAmount({ amount: 5, direction: 'in' }), 5);
  assert.equal(signedLedgerAmount({ amount: -3 }), -3, 'a negative amount is unambiguous');
  assert.equal(signedLedgerAmount({ amount: 2, before: 10, after: 12 }), 2, 'balances settle the rest');
  assert.equal(signedLedgerAmount({ amount: 2 }), null, 'and an unsigned positive is not guessed at');
});

test('what counts as a realised row', () => {
  assert.equal(isRealisedPnl({ type: 'realised_pnl' }), true);
  assert.equal(isRealisedPnl({ type: 'CLOSE' }), true);
  assert.equal(isRealisedPnl({ type: 'settlement' }), true);
  assert.equal(isRealisedPnl({ type: 'funding' }), false);
  assert.equal(isRealisedPnl({ type: 'trading_fee' }), false);
  assert.equal(isRealisedPnl({ type: 'transfer' }), false);
  assert.equal(isRealisedPnl({}), false);
});

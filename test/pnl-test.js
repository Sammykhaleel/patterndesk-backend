'use strict';

/**
 * Realised P&L, per symbol.
 *
 * The first version of this file had sixteen passing tests and the feature
 * reported zero on a live account that had been trading for weeks. Every
 * fixture used a row of type 'realised_pnl' — a shape Bybit never sends. ccxt
 * normalises every v5 trading row to 'trade', so the filter discarded
 * everything, and the tests agreed with the code because they were built from
 * the same wrong assumption.
 *
 * So the fixtures here are copied from the row shape in ccxt's own bybit.js,
 * comments and all, rather than invented to match what the code expects.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  readRealisedPnl, summarise, ledgerSymbol, signedLedgerAmount, isRealisedPnl, classifyLedgerRow,
} = require('../pnl');
const { RequestError } = require('../trading');

const quiet = { log() {}, warn() {}, error() {} };
const DAY = 86400000;

/**
 * A Bybit v5 transaction-log row, as ccxt hands it over.
 *
 * `change` is the balance delta and reconciles: change = cashFlow - fee.
 * ccxt turns that into an unsigned `amount` plus a direction, and keeps the
 * raw row in `info` — which is the only place the decomposition survives.
 */
function bybitRow({ t, symbol, cashFlow = 0, fee = 0, funding = 0, type = 'TRADE', id }) {
  const change = cashFlow - fee + funding;
  return {
    id: id || `${symbol}-${t}`,
    timestamp: t,
    type: 'trade',                       // <- what ccxt normalises TRADE to
    amount: Math.abs(change),
    direction: change < 0 ? 'out' : 'in',
    symbol: undefined,                   // ccxt does not set this on a ledger row
    info: {
      symbol, type, cashFlow: String(cashFlow), fee: String(fee),
      funding: String(funding), change: String(change), currency: 'USDT', category: 'linear',
    },
  };
}

/**
 * A venue that behaves the way Bybit documents: given only a start time, it
 * answers the SEVEN DAYS from there and nothing beyond, whatever you asked for.
 *
 * This is the fixture that was missing. Every earlier test used a ledger that
 * honoured "everything since", so a month-long read looked fine here and came
 * back empty against the real exchange.
 */
function windowedExchange(entries, { windowMs = 7 * 86400000, pageSize = 50, markets_by_id = null } = {}) {
  const calls = [];
  return {
    has: { fetchLedger: true },
    markets_by_id,
    calls,
    async fetchLedger(code, since, limit) {
      calls.push({ code, since, limit });
      if (limit !== undefined && limit > 50) throw new Error(`limit ${limit} exceeds the maximum of 50`);
      const from = since || 0;
      const to = from + windowMs;
      return entries
        .filter((e) => e.timestamp >= from && e.timestamp < to)
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(0, limit || pageSize);
    },
  };
}

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

/* ------------------------------------------------------------------ *
 * The bug this feature shipped with
 * ------------------------------------------------------------------ */

test('a real Bybit closed trade is counted', async () => {
  // The regression. Type 'trade', the P&L in info.cashFlow — the shape that
  // produced a confident "+0.00 USDT, 0 closed trades" on a live account.
  const now = Date.now();
  const ex = ledgerExchange([
    bybitRow({ t: now - DAY, symbol: 'MNTUSDT', cashFlow: 0.41, fee: 0.011 }),
  ], { markets_by_id: { MNTUSDT: { symbol: 'MNT/USDT:USDT' } } });

  const { rows } = await readRealisedPnl({ exchange: ex, since: now - 7 * DAY, logger: quiet });
  assert.equal(rows.length, 1, 'the trade is there');
  assert.equal(rows[0].symbol, 'MNT/USDT:USDT');
  assert.equal(summarise(rows).trades, 1);
});

test('a month is read from a venue that will only answer a week at a time', async () => {
  // The second half of the same bug. Bybit returns startTime → startTime+7d,
  // so a 30-day read answered the week that ended 23 days ago: empty, no
  // error, and a confident "0 closed trades" on an account that had closed
  // several that morning.
  const now = Date.now();
  const entries = [
    bybitRow({ id: 'old', t: now - 26 * DAY, symbol: 'AUSDT', cashFlow: 1 }),
    bybitRow({ id: 'mid', t: now - 12 * DAY, symbol: 'BUSDT', cashFlow: 2 }),
    bybitRow({ id: 'new', t: now - 1 * DAY, symbol: 'CUSDT', cashFlow: 4 }),
    bybitRow({ id: 'today', t: now - 3600000, symbol: 'DUSDT', cashFlow: 8 }),
  ];
  const ex = windowedExchange(entries);

  const { rows, truncated } = await readRealisedPnl({
    exchange: ex, since: now - 30 * DAY, now, logger: quiet,
  });

  assert.equal(summarise(rows).total, 15, 'every week of the month was asked for');
  assert.equal(rows.length, 4);
  assert.equal(truncated, false, 'and the answer is complete');
  assert.ok(ex.calls.length >= 4, `which took several windows (made ${ex.calls.length})`);
});

test('an empty week does not end the month', async () => {
  // The precise failure: the old reader treated an empty page as "the venue
  // has no more" and stopped. The first window of a quiet month is empty for
  // an account that only traded recently.
  const now = Date.now();
  const ex = windowedExchange([
    bybitRow({ id: 'recent', t: now - 2 * DAY, symbol: 'AUSDT', cashFlow: 0.5 }),
  ]);
  const { rows } = await readRealisedPnl({ exchange: ex, since: now - 30 * DAY, now, logger: quiet });
  assert.equal(rows.length, 1, 'the trade three weeks after the window we started in');
  assert.equal(summarise(rows).total, 0.5);
});

test('it does not ask for more rows than the venue allows', async () => {
  // Bybit documents limit as [1, 50]. The first version asked for 200.
  const now = Date.now();
  const ex = windowedExchange([bybitRow({ id: 'a', t: now - DAY, symbol: 'AUSDT', cashFlow: 1 })]);
  await readRealisedPnl({ exchange: ex, since: now - 30 * DAY, now, logger: quiet });
  for (const call of ex.calls) assert.ok(call.limit <= 50, `asked for ${call.limit}`);
});

test('a week with more rows than one page is paged through', async () => {
  const now = Date.now();
  const entries = [];
  for (let i = 0; i < 120; i += 1) {
    entries.push(bybitRow({ id: `r${i}`, t: now - 6 * DAY + i * 60000, symbol: 'AUSDT', cashFlow: 1 }));
  }
  const ex = windowedExchange(entries);
  const { rows, truncated } = await readRealisedPnl({
    exchange: ex, since: now - 30 * DAY, now, logger: quiet,
  });
  assert.equal(rows.length, 120, 'all of them, not just the first fifty');
  assert.equal(truncated, false);
});

test('the walk does not re-ask for windows it has already passed', async () => {
  // A full page mid-month advances the cursor beyond the window it was asked
  // for. Without noticing that, the walk keeps fetching inside a window it has
  // already read past — and a panel that quietly makes a dozen extra calls on
  // every open is how the scanner got itself rate-limited before.
  const now = Date.now();
  const entries = [];
  for (let i = 0; i < 50; i += 1) {   // a full page, spanning the first window
    entries.push(bybitRow({ id: `w1-${i}`, t: now - 30 * DAY + i * 3 * 3600000, symbol: 'AUSDT', cashFlow: 0.1 }));
  }
  entries.push(bybitRow({ id: 'late', t: now - 2 * DAY, symbol: 'BUSDT', cashFlow: 1 }));

  const ex = windowedExchange(entries);
  const { rows } = await readRealisedPnl({ exchange: ex, since: now - 30 * DAY, now, logger: quiet });
  assert.equal(rows.length, 51, 'everything is still read');
  assert.ok(ex.calls.length <= 7, `one request per window, give or take (made ${ex.calls.length})`);
});

test('rows from before the period asked for are not counted', async () => {
  // A venue that returns everything it has, whatever start time it was given.
  // Last month's winner must not appear in this week's figure.
  const now = Date.now();
  const ex = {
    has: { fetchLedger: true },
    async fetchLedger() {
      return [
        bybitRow({ id: 'ancient', t: now - 60 * DAY, symbol: 'OLD', cashFlow: 99 }),
        bybitRow({ id: 'recent', t: now - 2 * DAY, symbol: 'NEW', cashFlow: 1 }),
      ];
    },
  };
  const { rows } = await readRealisedPnl({ exchange: ex, since: now - 7 * DAY, now, logger: quiet });
  assert.equal(rows.length, 1, 'only the row inside the period');
  assert.equal(summarise(rows).total, 1, 'and last month is not in this week');
});

test('running out of the request budget is admitted, not hidden', async () => {
  // A long period against a busy account can cost more requests than the
  // budget allows. Stopping is fine; stopping silently is not.
  const now = Date.now();
  let served = 0;
  const ex = {
    has: { fetchLedger: true },
    calls: 0,
    async fetchLedger(code, since, limit) {
      this.calls += 1;
      // Always a full page, always moving forward, so it never runs out.
      return Array.from({ length: limit }, (_, i) => {
        served += 1;
        return bybitRow({ id: `s${served}`, t: since + i * 1000, symbol: 'AUSDT', cashFlow: 0.01 });
      });
    },
  };
  const { rows, truncated } = await readRealisedPnl({
    exchange: ex, since: now - 120 * DAY, now, maxRequests: 5, logger: quiet,
  });
  assert.equal(ex.calls, 5, 'it stopped at the budget');
  assert.ok(rows.length > 0, 'with what it had read');
  assert.equal(truncated, true, 'and said the figure is partial');
});

test('the walk is bounded even against a venue that answers nothing useful', async () => {
  const now = Date.now();
  const ex = {
    has: { fetchLedger: true },
    calls: 0,
    async fetchLedger() {
      this.calls += 1;
      return Array.from({ length: 50 }, (_, i) =>
        bybitRow({ id: `same${i}`, t: now - 29 * DAY, symbol: 'AUSDT', cashFlow: 1 }));
    },
  };
  const { truncated } = await readRealisedPnl({
    exchange: ex, since: now - 30 * DAY, now, maxRequests: 40, logger: quiet,
  });
  assert.ok(ex.calls <= 3, `stopped quickly rather than once per window (made ${ex.calls})`);
  assert.equal(truncated, true, 'and said the answer is partial');
});

test("ccxt's normalised 'trade' is a trade result", () => {
  // Stated on its own, because this single omission disabled both this panel
  // and the consecutive-loss breaker.
  assert.equal(isRealisedPnl({ type: 'trade' }), true);
});

/* ------------------------------------------------------------------ *
 * Fees
 * ------------------------------------------------------------------ */

test('the decomposition reconciles to the money that actually moved', () => {
  // gross - fee + funding must equal net, or the lines on screen add up to
  // something other than the balance and none of them can be trusted.
  const row = classifyLedgerRow(bybitRow({ t: 1, symbol: 'DOTUSDT', cashFlow: 0.9, fee: 0.012, funding: -0.003 }));
  assert.equal(Number((row.gross - row.fee + row.funding).toFixed(10)), Number(row.net.toFixed(10)));
  assert.equal(row.gross, 0.9);
  assert.equal(row.fee, 0.012);
  assert.equal(Number(row.funding.toFixed(4)), -0.003);
});

test('funding is derived from the balance, not trusted from the row', async () => {
  // A settlement row whose `funding` field the venue left empty, while the
  // balance plainly moved. Reading the field gives zero and the decomposition
  // stops adding up to the money; deriving it from `change` cannot.
  const row = classifyLedgerRow({
    id: 's1', timestamp: 1, type: 'trade',
    amount: 0.004, direction: 'out',
    info: { symbol: 'AUSDT', type: 'SETTLEMENT', cashFlow: '0', fee: '0', funding: '', change: '-0.004' },
  });
  assert.equal(Number(row.funding.toFixed(4)), -0.004, 'the charge is seen');
  assert.equal(Number((row.gross - row.fee + row.funding).toFixed(6)), Number(row.net.toFixed(6)),
    'and the pieces still sum to what moved');
  assert.equal(row.closed, false, 'without becoming a trade');
});

test('fees are reported, not quietly netted away', async () => {
  // On a $10 order — the exchange minimum, and most of this account's orders —
  // a round trip of taker fees is a real share of the move being traded for.
  const now = Date.now();
  const ex = ledgerExchange([
    bybitRow({ t: now - DAY, symbol: 'AUSDT', cashFlow: 0, fee: 0.006, id: 'open' }),   // entry
    bybitRow({ t: now - DAY + 100, symbol: 'AUSDT', cashFlow: 0.5, fee: 0.006, id: 'close' }), // exit
  ]);
  const out = summarise((await readRealisedPnl({ exchange: ex, since: now - 7 * DAY, logger: quiet })).rows);

  assert.equal(out.gross, 0.5, 'the trade made this');
  assert.equal(Number(out.fees.toFixed(3)), 0.012, 'and cost this in fees, both legs');
  assert.equal(Number(out.total.toFixed(3)), 0.488, 'leaving this in the account');
});

test('the opening leg is a cost, not a second trade', async () => {
  // Otherwise six round trips read as twelve trades and the hit rate halves.
  const now = Date.now();
  const ex = ledgerExchange([
    bybitRow({ t: now - DAY, symbol: 'AUSDT', cashFlow: 0, fee: 0.006, id: 'open' }),
    bybitRow({ t: now - DAY + 100, symbol: 'AUSDT', cashFlow: 0.5, fee: 0.006, id: 'close' }),
  ]);
  const out = summarise((await readRealisedPnl({ exchange: ex, since: now - 7 * DAY, logger: quiet })).rows);
  assert.equal(out.trades, 1, 'one trade');
  assert.equal(out.symbols[0].won, 1);
  assert.equal(out.symbols[0].lost, 0);
});

test('a gross win that fees turn into a loss is reported as a loss of money', async () => {
  // The case that matters most at this account size, and the one a
  // before-fees figure would present as a win.
  const now = Date.now();
  const ex = ledgerExchange([
    bybitRow({ t: now - DAY, symbol: 'AUSDT', cashFlow: 0, fee: 0.012, id: 'open' }),
    bybitRow({ t: now - DAY + 100, symbol: 'AUSDT', cashFlow: 0.01, fee: 0.012, id: 'close' }),
  ]);
  const out = summarise((await readRealisedPnl({ exchange: ex, since: now - 7 * DAY, logger: quiet })).rows);
  assert.ok(out.gross > 0, 'the trade itself went the right way');
  assert.ok(out.total < 0, 'and the account still lost money');
  assert.equal(out.symbols[0].won, 1, 'the hit rate says the setting was right');
});

test('funding is its own line, not a trade result', async () => {
  // Funding is charged every eight hours on an open position. Counted as a
  // trade result it would be a stream of tiny losing "trades".
  const now = Date.now();
  const ex = ledgerExchange([
    bybitRow({ t: now - DAY, symbol: 'AUSDT', type: 'SETTLEMENT', cashFlow: 0, fee: 0, funding: -0.004 }),
    bybitRow({ t: now - DAY + 10, symbol: 'AUSDT', cashFlow: 0.3, fee: 0.005 }),
  ]);
  const out = summarise((await readRealisedPnl({ exchange: ex, since: now - 7 * DAY, logger: quiet })).rows);
  assert.equal(out.trades, 1, 'one trade, not two');
  assert.equal(Number(out.funding.toFixed(4)), -0.004, 'and the funding is shown for what it is');
  assert.equal(Number(out.total.toFixed(4)), 0.291, 'both come out of the net');
});

test('a deposit is not a profitable day', async () => {
  // Adding funds must not read as the account making money.
  const now = Date.now();
  const ex = ledgerExchange([
    { id: 'd1', timestamp: now - DAY, type: 'transaction', amount: 50, direction: 'in', info: { type: 'TRANSFER_IN' } },
    bybitRow({ t: now - DAY + 10, symbol: 'AUSDT', cashFlow: 0.2, fee: 0.004 }),
  ]);
  const out = summarise((await readRealisedPnl({ exchange: ex, since: now - 7 * DAY, logger: quiet })).rows);
  assert.equal(Number(out.total.toFixed(3)), 0.196, 'the $50 is not profit');
  assert.equal(out.trades, 1);
});

/* ------------------------------------------------------------------ *
 * Reading the whole period
 * ------------------------------------------------------------------ */

test('a month is a month, not the last page', async () => {
  // A venue returns its most recent rows and stops. Taking the first page
  // would report a month of trading from its final days — quietly, and most
  // wrongly for the symbols that trade most.
  const now = Date.now();
  const entries = [];
  for (let i = 0; i < 260; i += 1) {
    entries.push(bybitRow({ t: now - (260 - i) * 3600000, symbol: 'DOTUSDT', cashFlow: 1, id: `r${i}` }));
  }

  const ex = ledgerExchange(entries);
  const { rows, truncated } = await readRealisedPnl({
    exchange: ex, since: now - 30 * DAY, pageSize: 50, logger: quiet,
  });
  assert.equal(rows.length, 260, 'every row was read');
  assert.equal(truncated, false, 'and it knows it got them all');
  assert.ok(ex.calls.length > 1, 'which took more than one page');
  // A venue that honours "everything since" runs ahead of the window it was
  // asked for. If each window restarted the cursor at its own beginning, this
  // whole history would be re-read once per week of the period — the same
  // rows, five times over, for nothing. Dedupe would hide it; the request
  // count is the only place it shows.
  assert.ok(ex.calls.length <= 12, `without re-reading it once per window (made ${ex.calls.length})`);
});

test('the same row seen twice is counted once', async () => {
  // Paging by timestamp re-reads the boundary, and a double-counted win is a
  // report that flatters the account.
  const now = Date.now();
  const shared = now - DAY;
  const entries = [
    bybitRow({ t: shared, symbol: 'AUSDT', cashFlow: 1, id: 'a' }),
    bybitRow({ t: shared, symbol: 'BUSDT', cashFlow: 1, id: 'b' }),
    bybitRow({ t: shared + 1000, symbol: 'CUSDT', cashFlow: 1, id: 'c' }),
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
    async fetchLedger() {
      this.calls += 1;
      return [bybitRow({ t: now - DAY, symbol: 'XUSDT', cashFlow: 1, id: 'x' }),
              bybitRow({ t: now - DAY, symbol: 'YUSDT', cashFlow: 1, id: 'y' })];
    },
  };
  const { rows, truncated } = await readRealisedPnl({
    exchange: ex, since: now - 30 * DAY, pageSize: 2, now, logger: quiet,
  });
  assert.ok(ex.calls <= 3, `stopped quickly rather than once per window (made ${ex.calls})`);
  assert.equal(rows.length, 2, 'with what it could read');
  assert.equal(truncated, true, 'and said the answer is partial');
});

test('a later page failing reports what was read, rather than nothing', async () => {
  const now = Date.now();
  let call = 0;
  const ex = {
    has: { fetchLedger: true },
    async fetchLedger() {
      call += 1;
      if (call === 1) {
        return [bybitRow({ t: now - 10 * 3600000, symbol: 'AUSDT', cashFlow: 1, id: 'p1' }),
                bybitRow({ t: now - 9 * 3600000, symbol: 'AUSDT', cashFlow: 1, id: 'p2' })];
      }
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

/* ------------------------------------------------------------------ *
 * Naming the rows
 * ------------------------------------------------------------------ */

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
    bybitRow({ t: now - DAY, symbol: 'MNTUSDT', cashFlow: 0.4 }),
  ]);
  const { rows } = await readRealisedPnl({ exchange: ex, since: now - 7 * DAY, logger: quiet });
  const out = summarise(rows);
  assert.equal(out.total.toFixed(2), '0.90', 'the money is counted');
  assert.ok(out.symbols.some((s) => s.symbol === 'unknown'), 'under a name that admits what it is');
});

/* ------------------------------------------------------------------ *
 * The summary
 * ------------------------------------------------------------------ */

test('the summary keeps wins and losses apart as well as netted', () => {
  // +0.02 made of a +4 and a -3.98 is a different animal from a symbol that
  // drifted there, and the net alone cannot tell them apart.
  const now = Date.now();
  const rows = [
    { timestamp: now, symbol: 'A/USDT:USDT', gross: 4, fee: 0, funding: 0, net: 4, closed: true },
    { timestamp: now, symbol: 'A/USDT:USDT', gross: -3.98, fee: 0, funding: 0, net: -3.98, closed: true },
    { timestamp: now, symbol: 'B/USDT:USDT', gross: 0.02, fee: 0, funding: 0, net: 0.02, closed: true },
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
  const r = (symbol, net) => ({ timestamp: 1, symbol, gross: net, fee: 0, funding: 0, net, closed: true });
  const rows = [r('LOSER/USDT:USDT', -5), r('WINNER/USDT:USDT', 9), r('MIDDLE/USDT:USDT', 1)];
  assert.deepEqual(summarise(rows).symbols.map((s) => s.symbol),
    ['WINNER/USDT:USDT', 'MIDDLE/USDT:USDT', 'LOSER/USDT:USDT']);
});

test('ranking is by money kept, not by money made', () => {
  // A symbol that trades constantly can out-gross another and still be the
  // worse holding once its fees are paid. The ranking answers "what should I
  // keep", so it ranks on what survived.
  const rows = [
    { timestamp: 1, symbol: 'CHURN/USDT:USDT', gross: 3, fee: 2.8, funding: 0, net: 0.2, closed: true },
    { timestamp: 2, symbol: 'QUIET/USDT:USDT', gross: 1, fee: 0.05, funding: 0, net: 0.95, closed: true },
  ];
  assert.deepEqual(summarise(rows).symbols.map((s) => s.symbol),
    ['QUIET/USDT:USDT', 'CHURN/USDT:USDT']);
});

test('an empty ledger is zero, not an error', () => {
  const out = summarise([]);
  assert.equal(out.total, 0);
  assert.equal(out.trades, 0);
  assert.equal(out.fees, 0);
  assert.deepEqual(out.symbols, []);
});

/* ------------------------------------------------------------------ *
 * Classification
 * ------------------------------------------------------------------ */

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
  assert.equal(isRealisedPnl({ type: 'trade' }), true, "ccxt's name for every Bybit trading row");
  assert.equal(isRealisedPnl({ type: 'realised_pnl' }), true);
  assert.equal(isRealisedPnl({ type: 'REALIZED_PNL' }), true);
  assert.equal(isRealisedPnl({ type: 'settlement' }), true);
  assert.equal(isRealisedPnl({ info: { type: 'CLOSE_PNL' } }), true);
  assert.equal(isRealisedPnl({ type: 'funding' }), false);
  assert.equal(isRealisedPnl({ type: 'trading_fee' }), false);
  assert.equal(isRealisedPnl({ type: 'transaction' }), false, 'a deposit is not a trade');
  assert.equal(isRealisedPnl({ type: 'transfer' }), false);
  assert.equal(isRealisedPnl({}), false);
});

test('a funding payment that mentions pnl is still not a trade', () => {
  // Or every eight-hourly funding charge counts as a losing trade and the
  // breaker halts the account on a quiet day.
  assert.equal(isRealisedPnl({ type: 'funding_pnl' }), false);
});

test('a Bybit opening order is not a closed trade', () => {
  // Same type, no trade result: judged on the decomposition rather than the
  // name, or every round trip counts twice.
  assert.equal(isRealisedPnl(bybitRow({ t: 1, symbol: 'AUSDT', cashFlow: 0, fee: 0.006 })), false);
  assert.equal(isRealisedPnl(bybitRow({ t: 1, symbol: 'AUSDT', cashFlow: 0.4, fee: 0.006 })), true);
});

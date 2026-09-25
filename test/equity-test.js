// What "account value" means, and which one the daily loss limit watches.
//
// The bug this exists for: ccxt reports Bybit's `walletBalance` as `total`,
// and walletBalance is cash only. An open position's unrealised profit or loss
// is not in it. Bybit's own "Total Assets" is equity — cash plus unrealised —
// so the app said 50.72 where Bybit said 49.10, and the day opened at 34.84 by
// the wallet but 37.53 by equity.
//
// The display was the visible half. The daily loss limit measured the wallet
// too, so a position could sit deep underwater without counting toward the
// day's loss until it was closed.

const test = require('node:test');
const assert = require('node:assert/strict');

const { venueEquity, breakerEquity, readAccountEquity, DedupeCache } = require('../trading');
const { DailyLossBreaker, runScan } = require('../scanner');
const { readAccounts, venueMargins } = require('../positions');

const quiet = { log() {}, warn() {}, error() {} };

/** A fetchBalance result shaped like ccxt's for a Bybit unified account. */
function bybitBalance({ wallet, equity, free = wallet / 2, available = null, inUse = null }) {
  return {
    info: { retCode: 0, result: { list: [{ accountType: 'UNIFIED', totalEquity: String(equity),
      ...(available !== null ? { totalAvailableBalance: String(available), totalInitialMargin: String(inUse) } : {}),
      coin: [
        { coin: 'USDC', equity: '0', walletBalance: '0' },
        { coin: 'USDT', equity: String(equity), walletBalance: String(wallet),
          unrealisedPnl: String(equity - wallet) },
      ] }] } },
    USDT: { free, used: wallet - free, total: wallet },
    free: { USDT: free }, used: { USDT: wallet - free }, total: { USDT: wallet },
  };
}

/* ------------------------------------------------------------------ *
 * Reading it
 * ------------------------------------------------------------------ */

test('equity is read from the venue, not the wallet', () => {
  const b = bybitBalance({ wallet: 50.72, equity: 49.10 });
  assert.equal(venueEquity(b, 'USDT'), 49.10, 'what Bybit calls Total Assets');
  assert.equal(breakerEquity(b), 49.10, 'and what the daily limit watches');
  assert.equal(readAccountEquity(b, 'USDT'), 49.10, 'and what size ceilings are a percentage of');
});

test('the right coin, not the first one listed', () => {
  // USDC comes first in Bybit's list, at zero. Taking it would read an
  // account with money in it as empty.
  const b = bybitBalance({ wallet: 50, equity: 48 });
  assert.equal(venueEquity(b, 'USDT'), 48);
  assert.equal(venueEquity(b, 'BTC'), null, 'a coin the account does not hold has no figure');
});

test('a venue that reports no equity falls back to what was read before', () => {
  const plain = { total: { USDT: 70 }, free: { USDT: 40 } };
  assert.equal(venueEquity(plain, 'USDT'), null, 'nothing invented');
  assert.equal(breakerEquity(plain), 70, 'the breaker keeps its old reading');
  assert.equal(readAccountEquity(plain, 'USDT'), 70, 'and so do the ceilings');
});

test('a garbled equity field is not believed', () => {
  const b = bybitBalance({ wallet: 50, equity: 48 });
  b.info.result.list[0].coin[1].equity = '';
  assert.equal(venueEquity(b, 'USDT'), null);
  assert.equal(breakerEquity(b), 50, 'the wallet, rather than zero or NaN');
});

test('the breaker never falls back to the free balance', () => {
  // Free drops whenever a position opens. A loss limit measured against it
  // would trip on opening trades rather than on losing them.
  const onlyFree = { free: { USDT: 20 } };
  assert.ok(!(breakerEquity(onlyFree) > 0), 'no figure rather than the free balance');
});

/* ------------------------------------------------------------------ *
 * The daily limit sees a loss while the position is still open
 * ------------------------------------------------------------------ */

test('an unrealised loss counts toward the day before anything is closed', async () => {
  // The day opened at 100. Nothing has closed, so the wallet still says 100,
  // but the open positions are down 60. The old reading saw a flat day.
  const breaker = new DailyLossBreaker({ maxDailyLossPercent: 50, maxConsecutiveLosses: null, failClosed: false });
  breaker.update(100, quiet);

  let fetchedCandles = false;
  const exchange = {
    id: 'bybit', has: { fetchPositions: true }, parseTimeframe: () => 3600,
    async fetchBalance() { return bybitBalance({ wallet: 100, equity: 40 }); },
    async fetchOHLCV() { fetchedCandles = true; return []; },
  };
  await runScan({
    exchanges: { bybit: exchange },
    config: { scanner: { enabled: true, execute: false, symbols: ['BTC/USDT:USDT'], timeframe: '1h',
      exchange: 'bybit', strategy: 'supertrend', supertrend: { period: 10, multiplier: 3 } } },
    dedupe: new DedupeCache(0), lastBar: new Map(), breaker, logger: quiet,
  });

  assert.equal(breaker.blocked, true, 'down 60% by equity is a halt');
  assert.match(breaker.reason, /down 60\.00%/);
  assert.equal(fetchedCandles, false, 'and nothing new was looked for');
});

test('an unrealised gain is not a loss either', () => {
  const b = new DailyLossBreaker({ maxDailyLossPercent: 50, maxConsecutiveLosses: null, failClosed: false });
  b.update(100, quiet);
  b.update(breakerEquity(bybitBalance({ wallet: 40, equity: 120 })), quiet);
  assert.equal(b.blocked, false, 'the wallet alone would have read a 60% loss');
});

/* ------------------------------------------------------------------ *
 * What the account panel is sent
 * ------------------------------------------------------------------ */

test('the account figures carry both, named', async () => {
  const out = await readAccounts({ bybit: { async fetchBalance() { return bybitBalance({ wallet: 50.72, equity: 49.10, free: 38.06 }); } } }, { logger: quiet });
  assert.equal(out.bybit.equity, 49.10, 'equity, as the exchange shows it');
  assert.equal(out.bybit.total, 50.72, 'the wallet, unchanged, for anything that read it before');
  assert.equal(out.bybit.free, 38.06);
});

test('a venue with no equity figure sends none', async () => {
  const out = await readAccounts({ weex: { async fetchBalance() { return { total: { USDT: 12 }, free: { USDT: 5 }, used: { USDT: 7 } }; } } }, { logger: quiet });
  assert.equal(out.weex.equity, null, 'not a copy of the wallet dressed up as equity');
  assert.equal(out.weex.total, 12);
});

test("Bybit's own Available and In use are sent, as its app shows them", async () => {
  // Seen: Bybit 41.56 available / 10.69 in use; the app 37.46 / 11.83.
  const out = await readAccounts({ bybit: { async fetchBalance() {
    return bybitBalance({ wallet: 49.29, equity: 52.25, free: 37.46, available: 41.56, inUse: 10.69 });
  } } }, { logger: quiet });
  assert.equal(out.bybit.available, 41.56, 'Available, as Bybit shows it');
  assert.equal(out.bybit.inUse, 10.69, 'In use, as Bybit shows it');
  assert.equal(out.bybit.free, 37.46, 'the withdrawable figure is still sent, for sizing');
});

test('a venue that sends no margins sends nulls, not zeros', () => {
  assert.deepEqual(venueMargins({ total: { USDT: 5 } }), { available: null, inUse: null });
  const blank = { info: { result: { list: [{ totalAvailableBalance: '', totalInitialMargin: '' }] } } };
  assert.deepEqual(venueMargins(blank), { available: null, inUse: null }, 'an empty string is not zero');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveSignal,
  dropFormingCandle,
  toCandles,
  signalId,
  scanSymbol,
  loadDetectors,
  runScan,
} = require('../scanner');
const { DedupeCache } = require('../trading');

const HOUR = 3_600_000;
const quiet = { log() {}, warn() {}, error() {} };

test.before(async () => { await loadDetectors(quiet); });

/* ---------------- candle handling ---------------- */

test('the forming candle is dropped, closed ones are kept', () => {
  const now = Date.now();
  const closed = { t: now - 2 * HOUR, o: 1, h: 2, l: 0, c: 1, v: 1 };
  const forming = { t: now - 0.5 * HOUR, o: 1, h: 2, l: 0, c: 1, v: 1 };

  assert.equal(dropFormingCandle([closed, forming], HOUR, now).length, 1);
  assert.equal(dropFormingCandle([closed], HOUR, now).length, 1);
  assert.equal(dropFormingCandle([], HOUR, now).length, 0);
});

test('a candle that closed exactly now is treated as closed', () => {
  const now = Date.now();
  const bar = { t: now - HOUR, o: 1, h: 2, l: 0, c: 1, v: 1 };
  assert.equal(dropFormingCandle([bar], HOUR, now).length, 1);
});

test('ccxt OHLCV rows convert to the shape the app modules expect', () => {
  const [c] = toCandles([[1000, 10, 12, 9, 11, 500]]);
  assert.deepEqual(c, { t: 1000, o: 10, h: 12, l: 9, c: 11, v: 500 });
});

test('the signal id is deterministic, bar-scoped and within length limits', () => {
  const a = signalId('BTC/USDT:USDT', '1h', 1700000000000);
  const b = signalId('BTC/USDT:USDT', '1h', 1700000000000);
  const next = signalId('BTC/USDT:USDT', '1h', 1700003600000);
  assert.equal(a, b, 'same bar must produce the same id');
  assert.notEqual(a, next, 'a new bar must produce a new id');
  assert.ok(a.length <= 36 && /^[A-Za-z0-9_-]+$/.test(a), 'must satisfy clientOrderId validation');
});

/* ---------------- signal rules ---------------- */

function series(n, shape) {
  const cs = [];
  for (let i = 0; i < n; i += 1) {
    const p = shape(i);
    const o = p - 0.4, c = p + 0.4;
    cs.push({ t: Date.now() - (n - i) * HOUR, o, h: Math.max(o, c) + 0.8, l: Math.min(o, c) - 0.8, c, v: 1000 });
  }
  return cs;
}

const permissive = { requireConfirmed: false, requireFirm: false, requireTrendAgreement: false, minRR: null };

test('flat noise produces no signal', () => {
  const cs = series(220, (i) => 100 + Math.sin(i / 3) * 0.2);
  assert.equal(deriveSignal(cs, permissive, quiet), null);
});

test('a forming pattern is rejected when confirmation is required', () => {
  const cs = series(220, (i) => 100 + Math.sin(i / 9) * 6 + Math.sin(i / 23) * 10 + (i > 190 ? (i - 190) * 0.35 : 0));
  const loose = deriveSignal(cs, permissive, quiet);
  const strict = deriveSignal(cs, { ...permissive, requireConfirmed: true }, quiet);
  if (loose && loose.status === 'forming') {
    assert.equal(strict, null, 'requireConfirmed must filter out a forming pattern');
  }
});

test('the risk:reward floor filters weak setups', () => {
  const cs = series(220, (i) => 100 + Math.sin(i / 9) * 6 + Math.sin(i / 23) * 10 + (i > 190 ? (i - 190) * 0.35 : 0));
  const any = deriveSignal(cs, permissive, quiet);
  if (any && any.rr !== null) {
    const impossible = deriveSignal(cs, { ...permissive, minRR: any.rr + 100 }, quiet);
    assert.equal(impossible, null, 'a floor above the actual rr must reject the signal');
  }
});

test('a signal, when produced, has a usable shape', () => {
  const cs = series(220, (i) => 100 + Math.sin(i / 9) * 6 + Math.sin(i / 23) * 10 + (i > 190 ? (i - 190) * 0.35 : 0));
  const s = deriveSignal(cs, permissive, quiet);
  if (s) {
    assert.ok(['buy', 'sell'].includes(s.side), 'side must be tradeable as-is');
    assert.ok(typeof s.pattern === 'string' && s.pattern.length > 0);
    assert.ok(Number.isFinite(s.entry) && Number.isFinite(s.stop));
  }
});

/* ---------------- scan loop ---------------- */

function fakeExchange(candles) {
  return {
    id: 'bybit',
    has: { fetchPositions: true },
    parseTimeframe: () => 3600,
    async fetchOHLCV() {
      return candles.map((c) => [c.t, c.o, c.h, c.l, c.c, c.v]);
    },
    market: () => ({
      symbol: 'BTC/USDT:USDT', base: 'BTC', quote: 'USDT', settle: 'USDT',
      linear: true, inverse: false, contractSize: 1, active: true,
      limits: { amount: { min: 0.001 }, cost: { min: 5 } },
    }),
    markets: { 'BTC/USDT:USDT': {} },
    async fetchBalance() { return { USDT: { free: 100000 } }; },
    async fetchTicker() { return { last: 100 }; },
    async fetchPositions() { return []; },
    async setLeverage() {},
    amountToPrecision: (_s, a) => Number(a).toFixed(3),
    priceToPrecision: (_s, p) => Number(p).toFixed(2),
    async createOrder() { throw new Error('createOrder must not be reached in these tests'); },
  };
}

const scanConfig = (over = {}) => ({
  dryRun: true,
  tradeFraction: 0.05,
  leverage: 3,
  maxPositionNotional: null,
  stopLossPercent: 2,
  dedupeTtlMs: 60_000,
  scanner: {
    enabled: true, execute: true, exchange: 'bybit',
    symbols: ['BTC/USDT:USDT'], timeframe: '1h',
    intervalMs: 60_000, candleLimit: 300, minCandles: 120,
    rules: permissive,
    ...over,
  },
});

test('a bar is evaluated once, not on every poll', async () => {
  const cs = series(220, (i) => 100 + Math.sin(i / 9) * 6 + Math.sin(i / 23) * 10 + (i > 190 ? (i - 190) * 0.35 : 0));
  const exchange = fakeExchange(cs);
  const lastBar = new Map();
  const args = { exchange, symbol: 'BTC/USDT:USDT', config: scanConfig(), dedupe: new DedupeCache(60_000), lastBar, logger: quiet };

  await scanSymbol(args);
  const second = await scanSymbol(args);
  assert.equal(second, null, 'the same bar must not be re-evaluated');
  assert.equal(lastBar.size, 1);
});

test('too few closed candles is skipped, not crashed on', async () => {
  const cs = series(40, (i) => 100 + i);
  const result = await scanSymbol({
    exchange: fakeExchange(cs), symbol: 'BTC/USDT:USDT',
    config: scanConfig(), dedupe: new DedupeCache(0), lastBar: new Map(), logger: quiet,
  });
  assert.equal(result, null);
});

test('with SCANNER_EXECUTE false a signal is logged but never sent', async () => {
  const cs = series(220, (i) => 100 + Math.sin(i / 9) * 6 + Math.sin(i / 23) * 10 + (i > 190 ? (i - 190) * 0.35 : 0));
  const result = await scanSymbol({
    exchange: fakeExchange(cs), symbol: 'BTC/USDT:USDT',
    config: scanConfig({ execute: false }), dedupe: new DedupeCache(0), lastBar: new Map(), logger: quiet,
  });
  if (result) assert.equal(result.sent, false);
});

test('a refused trade does not throw out of the scan', async () => {
  const cs = series(220, (i) => 100 + Math.sin(i / 9) * 6 + Math.sin(i / 23) * 10 + (i > 190 ? (i - 190) * 0.35 : 0));
  const config = scanConfig();
  config.maxPositionNotional = 0.01; // every order breaches this
  const result = await scanSymbol({
    exchange: fakeExchange(cs), symbol: 'BTC/USDT:USDT',
    config, dedupe: new DedupeCache(0), lastBar: new Map(), logger: quiet,
  });
  if (result) {
    assert.equal(result.sent, false);
    assert.match(result.error, /cap/);
  }
});

/* ------------------------------------------------------------------ *
 * Circuit breaker
 * ------------------------------------------------------------------ */

const { DailyLossBreaker } = require('../scanner');

test('the breaker trips at the daily loss limit and stays tripped', () => {
  const b = new DailyLossBreaker({ maxDailyLossPercent: 5, maxConsecutiveLosses: null });
  b.update(1000, quiet);
  assert.equal(b.blocked, false, 'the first reading sets the baseline');

  b.update(980, quiet);
  assert.equal(b.blocked, false, '2% down is within the limit');

  b.update(940, quiet);
  assert.equal(b.blocked, true, '6% down exceeds it');
  assert.match(b.reason, /down 6\.00% today/);

  // A recovery must not silently re-arm it. The day is over.
  b.update(1000, quiet);
  assert.equal(b.blocked, true);
});

// One losing CLOSED TRADE, at time t.
const loss = (t, amount = -1) => ({ timestamp: t, amount });
const win = (t, amount = 1) => ({ timestamp: t, amount });

/* ------------------------------------------------------------------ *
 * Reading closed-trade results from the ledger
 *
 * The consecutive-loss limit is about TRADES. Funding, fees and transfers
 * all move equity without a trade having finished, and counting them was
 * what made the old counter fire on drift.
 * ------------------------------------------------------------------ */

const { readClosedTradeOutcomes, isRealisedPnl } = require('../scanner');

test('funding and fees are not trade outcomes', () => {
  assert.equal(isRealisedPnl({ type: 'funding' }), false);
  assert.equal(isRealisedPnl({ type: 'fee' }), false);
  assert.equal(isRealisedPnl({ type: 'commission' }), false);
  assert.equal(isRealisedPnl({ type: 'transfer' }), false);
  assert.equal(isRealisedPnl({ type: 'deposit' }), false);
});

test('a realised profit or loss is', () => {
  assert.equal(isRealisedPnl({ type: 'realised_pnl' }), true);
  assert.equal(isRealisedPnl({ type: 'REALIZED_PNL' }), true);
  assert.equal(isRealisedPnl({ type: 'settlement' }), true);
  assert.equal(isRealisedPnl({ info: { type: 'CLOSE_PNL' } }), true);
});

test('a funding payment that mentions pnl is still not a trade', () => {
  // "funding" wins over a loose pnl match, or every eight-hourly funding
  // charge would count as a losing trade and trip the breaker on a quiet day.
  assert.equal(isRealisedPnl({ type: 'funding_pnl' }), false);
});

const ledgerVenue = (entries, over = {}) => ({
  id: 'bybit',
  has: { fetchLedger: true },
  async fetchLedger() { return entries; },
  ...over,
});

test('only realised entries come back, oldest first', async () => {
  const out = await readClosedTradeOutcomes({
    exchange: ledgerVenue([
      { type: 'realised_pnl', timestamp: 30, amount: -2, direction: 'out' },
      { type: 'funding', timestamp: 20, amount: -0.01, direction: 'out' },
      { type: 'realised_pnl', timestamp: 10, amount: 5, direction: 'in' },
    ]),
    since: 0, logger: quiet,
  });
  assert.deepEqual(out.map((o) => o.timestamp), [10, 30], 'funding dropped, order restored');
  assert.equal(out[0].amount, 5);
  assert.equal(out[1].amount, -2);
});

test('entries before the window are excluded', async () => {
  const out = await readClosedTradeOutcomes({
    exchange: ledgerVenue([
      { type: 'realised_pnl', timestamp: 5, amount: -9, direction: 'out' },
      { type: 'realised_pnl', timestamp: 50, amount: -1, direction: 'out' },
    ]),
    since: 10, logger: quiet,
  });
  assert.deepEqual(out.map((o) => o.timestamp), [50], 'yesterday does not count against today');
});

test('a venue with no ledger returns null, not an empty list', async () => {
  // Empty would read as "no losing trades" and reset a real streak.
  const ex = ledgerVenue([]);
  ex.has = { fetchLedger: false };
  assert.equal(await readClosedTradeOutcomes({ exchange: ex, since: 0, logger: quiet }), null);
});

test('a ledger call that fails every way returns null', async () => {
  const ex = ledgerVenue([], { async fetchLedger() { throw new Error('nope'); } });
  assert.equal(await readClosedTradeOutcomes({ exchange: ex, since: 0, logger: quiet }), null);
});

test('a venue that rejects the since argument is retried without it', async () => {
  // Weex refuses a startTime; Bybit is happy with one. Rather than guess, the
  // call falls back rather than giving up on the whole limit.
  let calls = 0;
  const ex = ledgerVenue([], {
    async fetchLedger(code, since) {
      calls += 1;
      if (since !== undefined) throw new Error("Parameter 'startTime' is invalid");
      return [{ type: 'realised_pnl', timestamp: 99, amount: -3, direction: 'out' }];
    },
  });
  const out = await readClosedTradeOutcomes({ exchange: ex, since: 1, logger: quiet });
  assert.equal(calls, 2, 'it tried again without the timestamp');
  assert.equal(out.length, 1);
});

test('a zero-amount entry is not an outcome', async () => {
  const out = await readClosedTradeOutcomes({
    exchange: ledgerVenue([{ type: 'realised_pnl', timestamp: 10, amount: 0, direction: 'in' }]),
    since: 0, logger: quiet,
  });
  assert.deepEqual(out, [], 'a flat close is neither a win nor a loss');
});

test('equity drifting down is NOT a losing trade', () => {
  // This is the bug the counter had: equity sampled once a minute meant one
  // position drifting against you for half an hour counted as thirty losses,
  // and a limit of 30 halted a whole day of trading on a slow tick down.
  const b = new DailyLossBreaker({ maxDailyLossPercent: null, maxConsecutiveLosses: 3 });
  b.update(1000, quiet);
  b.update(995, quiet);
  b.update(990, quiet);
  b.update(985, quiet);
  b.update(980, quiet);
  assert.equal(b.consecutiveLosses, 0, 'no trade closed, so nothing was lost yet');
  assert.equal(b.blocked, false);
});

test('consecutive losing trades trip the breaker', () => {
  const b = new DailyLossBreaker({ maxDailyLossPercent: null, maxConsecutiveLosses: 3 });
  b.recordOutcomes([loss(1), loss(2)], quiet);
  assert.equal(b.blocked, false);
  b.recordOutcomes([loss(3)], quiet);
  assert.equal(b.blocked, true);
  assert.match(b.reason, /consecutive losing trades/);
});

test('a winning trade resets the losing streak', () => {
  const b = new DailyLossBreaker({ maxDailyLossPercent: null, maxConsecutiveLosses: 3 });
  b.recordOutcomes([loss(1), loss(2), win(3), loss(4)], quiet);
  assert.equal(b.blocked, false, 'the streak restarted at the win');
  assert.equal(b.consecutiveLosses, 1);
});

test('the same ledger entry is never counted twice', () => {
  // Each sweep re-reads the day's ledger. Without this, a single bad trade
  // would trip the breaker given enough scans.
  const b = new DailyLossBreaker({ maxDailyLossPercent: null, maxConsecutiveLosses: 3 });
  const page = [loss(1), loss(2)];
  b.recordOutcomes(page, quiet);
  b.recordOutcomes(page, quiet);
  b.recordOutcomes(page, quiet);
  assert.equal(b.consecutiveLosses, 2, 're-reading the same page changes nothing');
  assert.equal(b.blocked, false);
});

test('"cannot tell" leaves the streak alone rather than clearing it', () => {
  // A venue that cannot report closed trades must not look like a venue
  // reporting no losses.
  const b = new DailyLossBreaker({ maxDailyLossPercent: null, maxConsecutiveLosses: 3 });
  b.recordOutcomes([loss(1), loss(2)], quiet);
  b.recordOutcomes(null, quiet);
  assert.equal(b.consecutiveLosses, 2, 'the streak survives an unreadable ledger');
});

test('a new UTC day re-baselines and clears the breaker', () => {
  const b = new DailyLossBreaker({ maxDailyLossPercent: 5, maxConsecutiveLosses: null });
  b.update(1000, quiet);
  b.update(900, quiet);
  assert.equal(b.blocked, true);

  b.day = '1999-01-01'; // simulate the date rolling over
  b.update(900, quiet);
  assert.equal(b.blocked, false, 'a new day starts fresh');
  assert.equal(b.baseline, 900, 'and re-baselines at the current equity');
});

test('unreadable equity is ignored rather than trusted', () => {
  const b = new DailyLossBreaker({ maxDailyLossPercent: 5, maxConsecutiveLosses: null });
  b.update(1000, quiet);
  for (const bad of [undefined, null, NaN, 0, -5, 'x']) b.update(bad, quiet);
  assert.equal(b.blocked, false, 'a bad reading must not fake a 100% loss');
  assert.equal(b.baseline, 1000);
});

test('the sweep feeds closed trades to the breaker, and halts when they trip it', async () => {
  // The pieces are tested on their own above; this proves the scan actually
  // calls them. Without the wiring the breaker would sit at zero forever and
  // the consecutive-loss limit would never fire at all.
  await loadDetectors(quiet);
  let fetched = false;
  const now = Date.now();
  const exchange = {
    id: 'bybit',
    has: { fetchPositions: true, fetchLedger: true },
    parseTimeframe: () => 3600,
    async fetchBalance() { return { total: { USDT: 1000 } }; },
    async fetchLedger() {
      return [
        { type: 'realised_pnl', timestamp: now - 3000, amount: -1, direction: 'out' },
        { type: 'realised_pnl', timestamp: now - 2000, amount: -1, direction: 'out' },
        { type: 'realised_pnl', timestamp: now - 1000, amount: -1, direction: 'out' },
        // Funding must not count, or the limit fires on a quiet day.
        { type: 'funding', timestamp: now - 500, amount: -0.02, direction: 'out' },
      ];
    },
    async fetchOHLCV() { fetched = true; return []; },
  };

  const breaker = new DailyLossBreaker({ maxDailyLossPercent: null, maxConsecutiveLosses: 3 });
  breaker.update(1000, quiet);

  const said = [];
  await runScan({
    exchanges: { bybit: exchange },
    config: scanConfig(),
    dedupe: new DedupeCache(0), lastBar: new Map(), breaker,
    logger: { log: (m) => said.push(m), warn: (m) => said.push(m), error: (m) => said.push(m) },
  });

  assert.equal(breaker.consecutiveLosses, 3, 'three losing trades were counted, and funding was not');
  assert.equal(breaker.blocked, true, 'which trips the limit');
  assert.equal(fetched, false, 'and the sweep stops before fetching a single candle');
  assert.match(said.join(' | '), /halted by circuit breaker/);
});

test('a tripped breaker stops the scan before any order is considered', async () => {
  let fetched = false;
  const exchange = {
    id: 'bybit',
    has: { fetchPositions: true },
    parseTimeframe: () => 3600,
    async fetchBalance() { return { total: { USDT: 500 } }; },
    async fetchOHLCV() { fetched = true; return []; },
  };
  const breaker = new DailyLossBreaker({ maxDailyLossPercent: 5, maxConsecutiveLosses: null });
  breaker.update(1000, quiet); // baseline
  breaker.update(500, quiet);  // 50% down -> tripped

  await require('../scanner').runScan({
    exchanges: { bybit: exchange }, config: scanConfig(),
    dedupe: new DedupeCache(0), lastBar: new Map(), breaker, logger: quiet,
  });
  assert.equal(fetched, false, 'no candles fetched, so no signal can be produced');
});

test('a failed equity read skips the scan rather than trading blind', async () => {
  let fetched = false;
  const exchange = {
    id: 'bybit',
    has: { fetchPositions: true },
    parseTimeframe: () => 3600,
    async fetchBalance() { throw new Error('exchange unreachable'); },
    async fetchOHLCV() { fetched = true; return []; },
  };
  await require('../scanner').runScan({
    exchanges: { bybit: exchange }, config: scanConfig(),
    dedupe: new DedupeCache(0), lastBar: new Map(),
    breaker: new DailyLossBreaker({ maxDailyLossPercent: 5, maxConsecutiveLosses: 4 }),
    logger: quiet,
  });
  assert.equal(fetched, false);
});

test('the breaker follows a runtime exchange change, not the one it booted with', async () => {
  // The exchange is a live setting now. A breaker bound at construction would
  // keep measuring the daily loss of the venue the scanner used to trade —
  // reading one account's drawdown while placing orders on another. Here weex
  // is tripped and bybit is not, and the scan runs on weex.
  let fetched = false;
  const venue = (id) => ({
    id,
    has: { fetchPositions: true },
    parseTimeframe: () => 3600,
    async fetchBalance() { return { total: { USDT: 500 } }; },
    async fetchOHLCV() { fetched = true; return []; },
  });

  // Baseline 500 against the same 500 equity, so bybit is flat and the scan
  // would proceed if the wrong breaker were consulted.
  const bybitBreaker = new DailyLossBreaker({ maxDailyLossPercent: 5, maxConsecutiveLosses: null });
  bybitBreaker.update(500, quiet);
  const weexBreaker = new DailyLossBreaker({ maxDailyLossPercent: 5, maxConsecutiveLosses: null });
  weexBreaker.update(1000, quiet);
  weexBreaker.update(500, quiet); // weex is 50% down -> tripped

  const breakers = { for: (id) => (id === 'weex' ? weexBreaker : bybitBreaker) };

  await runScan({
    exchanges: { bybit: venue('bybit'), weex: venue('weex') },
    config: scanConfig(),
    // The running settings say weex; the boot config said bybit.
    settings: { ...scanConfig().scanner, exchange: 'weex' },
    dedupe: new DedupeCache(0), lastBar: new Map(), breakers, logger: quiet,
  });
  assert.equal(fetched, false, 'weex is halted, so its scan must not fetch candles');
});

test('the breaker reaches the order, not just the start of the sweep', async () => {
  // runScan checks the breaker once before a sweep begins. A sweep then fires
  // an entry per symbol per timeframe, so without the breaker on the order
  // call itself the trades after the one that broke the limit still went out.
  // The scanner is the one thing placing orders with nobody watching, which
  // makes this the path that needs the per-entry check most, not least.
  await loadDetectors(quiet);

  const breaker = new DailyLossBreaker({ maxDailyLossPercent: 5, maxConsecutiveLosses: null });
  breaker.update(1000, quiet);   // baseline
  breaker.update(500, quiet);    // 50% down -> tripped
  assert.equal(breaker.blocked, true, 'the fixture starts tripped');

  const said = [];
  const logger = { log: (m) => said.push(m), warn: (m) => said.push(m), error: (m) => said.push(m) };

  await scanSymbol({
    exchange: fakeExchange(flipUpSeries()),
    symbol: 'BTC/USDT:USDT',
    timeframe: '1h',
    config: scanConfig({ strategy: 'supertrend', execute: true, minCandles: 20, supertrend: stOpts }),
    dedupe: new DedupeCache(0),
    lastBar: new Map(),
    breaker,
    logger,
  });

  const transcript = said.join(' | ');
  assert.match(transcript, /SIGNAL BUY/, 'the flip did produce a signal to act on');
  assert.match(transcript, /circuit breaker/i,
    'and the order was refused by the breaker rather than sent');
});

/* ------------------------------------------------------------------ *
 * Circuit breaker persistence
 *
 * The breaker is the one guard that cannot be re-derived from the exchange
 * on the next scan. If it does not outlive the process, a crash-restart
 * loop turns a daily loss limit into a per-restart loss limit.
 * ------------------------------------------------------------------ */

const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');

function tmpState() {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'pd-breaker-'));
  return nodePath.join(dir, 'breaker-state.json');
}

test('a tripped breaker is still tripped after a restart', () => {
  const statePath = tmpState();
  const opts = { maxDailyLossPercent: 5, maxConsecutiveLosses: null, statePath, logger: quiet };

  const before = new DailyLossBreaker(opts);
  before.update(1000, quiet);
  before.update(900, quiet); // 10% down -> tripped
  assert.equal(before.blocked, true);

  // The process dies and the supervisor brings it back.
  const after = new DailyLossBreaker(opts);
  assert.equal(after.blocked, true, 'the trip must survive the restart');
  assert.equal(after.baseline, 1000, 'and it must keep the ORIGINAL baseline');

  // Without persistence this next reading would re-baseline at 900 and allow
  // another 5% of what is left to be lost on the same day.
  after.update(880, quiet);
  assert.equal(after.blocked, true);
  assert.equal(after.baseline, 1000);
});

test('consecutive-loss counting resumes rather than restarting', () => {
  const statePath = tmpState();
  const opts = { maxDailyLossPercent: null, maxConsecutiveLosses: 3, statePath, logger: quiet };

  const before = new DailyLossBreaker(opts);
  before.update(1000, quiet);
  before.recordOutcomes([{ timestamp: 1, amount: -1 }, { timestamp: 2, amount: -1 }], quiet);
  assert.equal(before.blocked, false);

  const after = new DailyLossBreaker(opts);
  assert.equal(after.consecutiveLosses, 2, 'the count carries over');
  // And so does how far the ledger was read, or the restart would re-count
  // the same two losses and trip on trades already accounted for.
  after.recordOutcomes([{ timestamp: 1, amount: -1 }, { timestamp: 2, amount: -1 }], quiet);
  assert.equal(after.consecutiveLosses, 2, 'already-seen entries are not re-counted');
  after.recordOutcomes([{ timestamp: 3, amount: -1 }], quiet);
  assert.equal(after.blocked, true, 'the third loss trips it, not the fifth');
});

test('state from a previous UTC day is discarded, not restored', () => {
  const statePath = tmpState();
  fs.writeFileSync(statePath, JSON.stringify({
    day: '2001-01-01',
    baseline: 1000,
    tripped: true,
    reason: 'ancient history',
    consecutiveLosses: 9,
    lastEquity: 500,
  }));

  const b = new DailyLossBreaker({
    maxDailyLossPercent: 5, maxConsecutiveLosses: 3, statePath, logger: quiet,
  });
  assert.equal(b.blocked, false, 'yesterday\'s trip must not halt today');
  assert.equal(b.consecutiveLosses, 0);
  assert.equal(b.baseline, null, 'today re-baselines from the first live reading');
});

test('an unreadable state file starts cold instead of throwing', () => {
  const statePath = tmpState();
  fs.writeFileSync(statePath, '{ this is not json');

  let b;
  assert.doesNotThrow(() => {
    b = new DailyLossBreaker({
      maxDailyLossPercent: 5, maxConsecutiveLosses: null, statePath, logger: quiet,
    });
  });
  assert.equal(b.blocked, false);
  b.update(1000, quiet);
  assert.equal(b.baseline, 1000, 'and it recovers by overwriting the bad file');
});

test('an unwritable state path is reported once, and does not stop trading', () => {
  // A directory that does not exist stands in for a disk that failed to mount.
  const statePath = nodePath.join(os.tmpdir(), 'pd-no-such-dir-' + Date.now(), 'state.json');
  const errors = [];
  const logger = { log() {}, warn() {}, error(m) { errors.push(m); } };

  const b = new DailyLossBreaker({
    maxDailyLossPercent: 5, maxConsecutiveLosses: null, statePath, logger,
  });
  b.update(1000, logger);
  b.update(999, logger);
  b.update(998, logger);

  assert.equal(errors.length, 1, 'warned once, not once per scan');
  assert.match(errors[0], /CANNOT PERSIST/);
  assert.equal(b.baseline, 1000, 'the in-memory breaker still works');
});

test('no statePath means no file is written at all', () => {
  // Existing callers construct the breaker without persistence; that must
  // stay a pure in-memory object with no side effects on disk.
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'pd-breaker-none-'));
  const b = new DailyLossBreaker({ maxDailyLossPercent: 5, maxConsecutiveLosses: null });
  b.update(1000, quiet);
  b.update(900, quiet);
  assert.equal(b.blocked, true);
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing written');
});

/* ------------------------------------------------------------------ *
 * Baseline reconstruction
 *
 * The disk-based fix assumes a disk. On an ephemeral host there isn't one,
 * so the exchange's own ledger is the fallback source of truth for what the
 * day has already done.
 * ------------------------------------------------------------------ */

const { reconstructBaseline } = require('../scanner');

function ledgerExchange(entries) {
  return {
    has: { fetchLedger: true },
    async fetchLedger() { return entries; },
  };
}

const todayAt = (h) => Date.parse(new Date().toISOString().slice(0, 10) + `T${String(h).padStart(2, '0')}:00:00Z`);

test('the day\'s baseline is backed out of the ledger', async () => {
  // Down 30 on the day, currently at 970 -> the day opened at 1000.
  const ex = ledgerExchange([
    { timestamp: todayAt(1), type: 'trade', direction: 'out', amount: 25 },
    { timestamp: todayAt(2), type: 'fee', direction: 'out', amount: 5 },
  ]);
  const baseline = await reconstructBaseline({ exchange: ex, equity: 970, logger: quiet });
  assert.equal(baseline, 1000);
});

test('deposits and withdrawals are not mistaken for trading results', async () => {
  // A 500 deposit must not read as a 500 gain, which would raise the
  // baseline and let the breaker tolerate a much larger real loss.
  const ex = ledgerExchange([
    { timestamp: todayAt(1), type: 'deposit', direction: 'in', amount: 500 },
    { timestamp: todayAt(2), type: 'trade', direction: 'out', amount: 20 },
    { timestamp: todayAt(3), type: 'withdrawal', direction: 'out', amount: 100 },
  ]);
  const baseline = await reconstructBaseline({ exchange: ex, equity: 1380, logger: quiet });
  assert.equal(baseline, 1400, 'only the 20 loss counts');
});

test('entries from before midnight are ignored', async () => {
  const ex = ledgerExchange([
    { timestamp: todayAt(0) - 3_600_000, type: 'trade', direction: 'out', amount: 900 },
    { timestamp: todayAt(2), type: 'trade', direction: 'out', amount: 10 },
  ]);
  const baseline = await reconstructBaseline({ exchange: ex, equity: 990, logger: quiet });
  assert.equal(baseline, 1000, 'yesterday\'s loss is not today\'s');
});

test('a failed ledger fetch reconstructs nothing rather than guessing', async () => {
  const ex = {
    has: { fetchLedger: true },
    async fetchLedger() { throw new Error('permission denied'); },
  };
  assert.equal(await reconstructBaseline({ exchange: ex, equity: 900, logger: quiet }), null);

  const noLedger = { has: { fetchLedger: false } };
  assert.equal(await reconstructBaseline({ exchange: noLedger, equity: 900, logger: quiet }), null);
});

test('an armed breaker halts when the baseline cannot be established', () => {
  // The failure this whole path exists to prevent: a restart mid-day handing
  // back the full daily loss allowance.
  const b = new DailyLossBreaker({
    maxDailyLossPercent: 5, maxConsecutiveLosses: null, failClosed: true, logger: quiet,
  });
  assert.equal(b.needsBaseline(900), true, 'a cold start needs one');
  b.adoptBaseline(null, quiet, 900);
  assert.equal(b.blocked, true, 'no baseline means no trading');
  assert.match(b.reason, /could not be established/);
});

test('an unarmed breaker carries on so dry runs stay observable', () => {
  const b = new DailyLossBreaker({
    maxDailyLossPercent: 5, maxConsecutiveLosses: null, failClosed: false, logger: quiet,
  });
  b.adoptBaseline(null, quiet, 900);
  assert.equal(b.blocked, false);
  assert.equal(b.baseline, 900);
});

test('a day that rolls over while running does not trigger a ledger fetch', () => {
  const b = new DailyLossBreaker({ maxDailyLossPercent: 5, maxConsecutiveLosses: null });
  b.update(1000, quiet);
  assert.equal(b.needsBaseline(1000), false, 'today is already baselined');

  b.day = '2001-01-01'; // pretend the clock rolled past midnight
  assert.equal(
    b.needsBaseline(1000), false,
    'current equity IS the new day\'s opening balance — nothing to reconstruct'
  );
});

test('a reconstructed baseline is used, not the reduced equity', () => {
  const b = new DailyLossBreaker({
    maxDailyLossPercent: 5, maxConsecutiveLosses: null, failClosed: true, logger: quiet,
  });
  b.adoptBaseline(1000, quiet, 900); // restarted after a 10% drawdown
  assert.equal(b.baseline, 1000);
  b.update(900, quiet);
  assert.equal(b.blocked, true, 'already past the 5% limit for the day, so it stays halted');
});

/* ------------------------------------------------------------------ *
 * Supertrend strategy
 *
 * A different shape from the pattern detector: no formation to wait on, no
 * "forming" state. The indicator either flipped on the last closed bar or it
 * did not, and its own line is the invalidation.
 * ------------------------------------------------------------------ */

const { deriveSupertrendSignal } = require('../scanner');

const stOpts = { period: 10, multiplier: 3, rewardRisk: 2, minRR: 1.5 };

// A series that trends down long enough for Supertrend to settle short, then
// rips upward hard enough to flip it long on the final bar.
function flipUpSeries() {
  const cs = [];
  let p = 100;
  for (let i = 0; i < 40; i++) { p -= 1; cs.push({ t: i * 3600e3, o: p + 1, h: p + 1.2, l: p - 1.2, c: p, v: 10 }); }
  // One sharp up bar, and STOP. deriveSupertrendSignal fires only when the
  // LAST closed bar flips, so a fixture that runs on past the turn is just a
  // continuing trend and produces nothing.
  p += 9;
  cs.push({ t: 40 * 3600e3, o: p - 9, h: p + 0.5, l: p - 9.5, c: p, v: 30 });
  return cs;
}

test('a tuned symbol is scanned on its own timeframe, not the global one', async () => {
  await loadDetectors(quiet);
  const asked = [];
  const ex = fakeExchange(flipUpSeries());
  ex.fetchOHLCV = async (symbol, timeframe) => {
    asked.push(`${symbol}@${timeframe}`);
    return flipUpSeries().map((c) => [c.t, c.o, c.h, c.l, c.c, c.v]);
  };

  const config = scanConfig({
    strategy: 'supertrend', execute: false, minCandles: 20,
    symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT'],
    timeframes: ['1h'],
    supertrend: { period: 10, multiplier: 3, rewardRisk: 0, minRR: 0 },
    overrides: { 'ETH/USDT:USDT': { timeframe: '15m' } },
  });

  await runScan({
    exchanges: { bybit: ex }, config,
    dedupe: new DedupeCache(0), lastBar: new Map(), logger: quiet,
  });

  assert.ok(asked.includes('BTC/USDT:USDT@1h'), 'the untuned symbol uses the global timeframe');
  assert.ok(asked.includes('ETH/USDT:USDT@15m'), 'the tuned one uses its own');
  assert.ok(!asked.includes('ETH/USDT:USDT@1h'),
    'and is NOT also scanned on the global timeframe — that would double its trades');
});

test('a tuned symbol uses its own Supertrend parameters', async () => {
  // Same candles, different parameters: 10/3 flips on this series and 40/12
  // does not. If the override were ignored, both symbols would signal.
  await loadDetectors(quiet);
  const seen = [];
  const ex = fakeExchange(flipUpSeries());
  const config = scanConfig({
    strategy: 'supertrend', execute: false, minCandles: 20,
    symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT'],
    timeframes: ['1h'],
    supertrend: { period: 10, multiplier: 3, rewardRisk: 0, minRR: 0 },
    overrides: { 'ETH/USDT:USDT': { supertrend: { period: 40, multiplier: 12 } } },
  });

  await runScan({
    exchanges: { bybit: ex }, config,
    dedupe: new DedupeCache(0), lastBar: new Map(),
    logger: { log: (m) => seen.push(m), warn: (m) => seen.push(m), error: (m) => seen.push(m) },
  });

  const transcript = seen.join(' | ');
  assert.match(transcript, /BTC\/USDT:USDT[\s\S]*SIGNAL/, 'the global parameters still fire');
  assert.doesNotMatch(
    transcript.split('ETH/USDT:USDT')[1] || '',
    /SIGNAL/,
    'the tuned symbol, on parameters that do not flip here, does not'
  );
});

test('tuning one symbol does not change what the others use', async () => {
  await loadDetectors(quiet);
  const asked = [];
  const ex = fakeExchange(flipUpSeries());
  ex.fetchOHLCV = async (symbol, timeframe) => {
    asked.push(`${symbol}@${timeframe}`);
    return flipUpSeries().map((c) => [c.t, c.o, c.h, c.l, c.c, c.v]);
  };
  const config = scanConfig({
    strategy: 'supertrend', execute: false, minCandles: 20,
    symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT'],
    timeframes: ['1h', '4h'],
    supertrend: { period: 10, multiplier: 3, rewardRisk: 0, minRR: 0 },
    overrides: { 'ETH/USDT:USDT': { timeframe: '5m' } },
  });
  await runScan({
    exchanges: { bybit: ex }, config,
    dedupe: new DedupeCache(0), lastBar: new Map(), logger: quiet,
  });

  assert.ok(asked.includes('BTC/USDT:USDT@1h') && asked.includes('BTC/USDT:USDT@4h'),
    'an untuned symbol still sweeps every global timeframe');
  assert.ok(asked.includes('SOL/USDT:USDT@1h') && asked.includes('SOL/USDT:USDT@4h'));
  assert.deepEqual(asked.filter((a) => a.startsWith('ETH')), ['ETH/USDT:USDT@5m'],
    'and the tuned one is scanned exactly once, on its own timeframe');
});

/* ------------------------------------------------------------------ *
 * Always-in reversal
 *
 * A Supertrend flip means the trend the open position was trading has
 * ended. Without reversing, the first flip opens a position and every
 * later one is refused while it is still open, so a symbol trades once
 * and then goes quiet until its stop is hit.
 * ------------------------------------------------------------------ */

// An exchange holding one open position, recording every order it is sent.
function reversibleExchange(candles, position) {
  const ex = fakeExchange(candles);
  ex.orders = [];
  // Models a real venue: once the reduceOnly order fills, the position is
  // gone from the book. staleReads lets a test hold the old position visible
  // for a few reads, which is what a lagging exchange looks like.
  let open = position;
  let stale = 0;
  ex.setStaleReads = (n) => { stale = n; };
  ex.fetchPositions = async () => {
    const showing = open || (stale > 0 ? position : null);
    if (!open && stale > 0) stale -= 1;
    return showing ? [{
      symbol: 'BTC/USDT:USDT',
      side: showing.side,
      contracts: showing.contracts,
      notional: showing.contracts * 100,
      entryPrice: 100,
    }] : [];
  };
  ex.createOrder = async (symbol, type, side, amount, price, params) => {
    const reduceOnly = !!(params && params.reduceOnly);
    ex.orders.push({ side, amount, reduceOnly, clientOrderId: params && params.clientOrderId });
    if (reduceOnly) open = null;
    return { id: String(ex.orders.length), status: 'closed', filled: amount, average: 100 };
  };
  return ex;
}

const reverseConfig = (over = {}) => scanConfig({
  strategy: 'supertrend', execute: true, minCandles: 20, reverse: true,
  supertrend: { period: 10, multiplier: 3, rewardRisk: 0, minRR: 0 },
  ...over,
});

test('a flip against an open position closes it, then enters the other way', async () => {
  await loadDetectors(quiet);
  // Short open, Supertrend flips long: close the short, open the long.
  const ex = reversibleExchange(flipUpSeries(), { side: 'short', contracts: 2 });
  await scanSymbol({
    exchange: ex, symbol: 'BTC/USDT:USDT', timeframe: '1h',
    config: { ...reverseConfig(), dryRun: false },
    dedupe: new DedupeCache(60_000), lastBar: new Map(), logger: quiet,
  });

  assert.equal(ex.orders.length, 2, 'two orders: the close and the entry');
  assert.equal(ex.orders[0].reduceOnly, true, 'the close goes first');
  assert.equal(ex.orders[0].side, 'buy', 'buying closes a short');
  assert.equal(ex.orders[0].amount, 2, 'and closes the whole position');
  assert.equal(ex.orders[1].reduceOnly, false, 'the entry follows');
  assert.equal(ex.orders[1].side, 'buy', 'on the side the flip called for');
});

test('the two legs of a reversal carry different order ids', async () => {
  // The dedupe cache keys on clientOrderId. Reusing the entry's id would make
  // the entry look like a repeat of the close it follows and drop it silently,
  // leaving the account FLAT after a flip rather than reversed — the one
  // outcome that looks like nothing went wrong.
  await loadDetectors(quiet);
  const ex = reversibleExchange(flipUpSeries(), { side: 'short', contracts: 2 });
  await scanSymbol({
    exchange: ex, symbol: 'BTC/USDT:USDT', timeframe: '1h',
    config: { ...reverseConfig(), dryRun: false },
    dedupe: new DedupeCache(60_000), lastBar: new Map(), logger: quiet,
  });
  assert.equal(ex.orders.length, 2, 'the entry survived the dedupe cache');
  assert.notEqual(ex.orders[0].clientOrderId, ex.orders[1].clientOrderId);
});

test('with nothing open, a flip just enters — no phantom close', async () => {
  await loadDetectors(quiet);
  const ex = reversibleExchange(flipUpSeries(), null);
  await scanSymbol({
    exchange: ex, symbol: 'BTC/USDT:USDT', timeframe: '1h',
    config: { ...reverseConfig(), dryRun: false },
    dedupe: new DedupeCache(60_000), lastBar: new Map(), logger: quiet,
  });
  assert.equal(ex.orders.length, 1, 'one order only');
  assert.equal(ex.orders[0].reduceOnly, false, 'and it is the entry');
});

test('reverse off leaves the old refusal in place', async () => {
  // The opt-in has to actually gate it, or upgrading would silently start
  // closing positions the operator opened by hand.
  await loadDetectors(quiet);
  const ex = reversibleExchange(flipUpSeries(), { side: 'short', contracts: 2 });
  const said = [];
  await scanSymbol({
    exchange: ex, symbol: 'BTC/USDT:USDT', timeframe: '1h',
    config: { ...reverseConfig({ reverse: false }), dryRun: false },
    dedupe: new DedupeCache(60_000), lastBar: new Map(),
    logger: { log: (m) => said.push(m), warn: (m) => said.push(m), error: (m) => said.push(m) },
  });
  assert.equal(ex.orders.length, 0, 'nothing was sent');
  assert.match(said.join(" | "), /opposite (short|sell) position is open/i, "the entry was refused as before");
});

test('a position book that lags the fill does not leave the account flat', async () => {
  // A reversal reads positions twice: to size the close, then to check the
  // entry is not fighting an open position. If the exchange has not yet
  // registered the fill between those reads, the entry is refused and the
  // flip ends with NOTHING open — the failure that looks like success.
  await loadDetectors(quiet);
  const ex = reversibleExchange(flipUpSeries(), { side: 'short', contracts: 2 });
  ex.setStaleReads(1);   // one read still shows the position after it closed

  const said = [];
  await scanSymbol({
    exchange: ex, symbol: 'BTC/USDT:USDT', timeframe: '1h',
    config: { ...reverseConfig(), dryRun: false },
    dedupe: new DedupeCache(60_000), lastBar: new Map(),
    logger: { log: (m) => said.push(m), warn: (m) => said.push(m), error: (m) => said.push(m) },
  });

  assert.equal(ex.orders.length, 2, 'the entry went in after the book caught up');
  assert.equal(ex.orders[1].reduceOnly, false, 'and it is a real entry, not another close');
  assert.match(said.join(' | '), /retrying the entry/i, 'the wait was reported rather than silent');
});

test('a book that never catches up gives up instead of retrying forever', async () => {
  await loadDetectors(quiet);
  const ex = reversibleExchange(flipUpSeries(), { side: 'short', contracts: 2 });
  ex.setStaleReads(99);

  const said = [];
  await scanSymbol({
    exchange: ex, symbol: 'BTC/USDT:USDT', timeframe: '1h',
    config: { ...reverseConfig(), dryRun: false },
    dedupe: new DedupeCache(60_000), lastBar: new Map(),
    logger: { log: (m) => said.push(m), warn: (m) => said.push(m), error: (m) => said.push(m) },
  });

  assert.equal(ex.orders.length, 1, 'only the close was sent');
  assert.equal(ex.orders[0].reduceOnly, true);
  assert.match(said.join(' | '), /not executed/i, 'and the failure is on the record');
});

test('an ordinary flip refusal is not retried', async () => {
  // With reverse off the guard is a correct answer, not a stale read. Retrying
  // it would be arguing with the exchange three times over on every scan.
  await loadDetectors(quiet);
  const ex = reversibleExchange(flipUpSeries(), { side: 'short', contracts: 2 });
  const said = [];
  await scanSymbol({
    exchange: ex, symbol: 'BTC/USDT:USDT', timeframe: '1h',
    config: { ...reverseConfig({ reverse: false }), dryRun: false },
    dedupe: new DedupeCache(60_000), lastBar: new Map(),
    logger: { log: (m) => said.push(m), warn: (m) => said.push(m), error: (m) => said.push(m) },
  });
  assert.doesNotMatch(said.join(' | '), /retrying the entry/i);
});

test('a reversal that could not enter does not close either', async () => {
  // The reported failure: the position was closed and the opposite side never
  // opened, leaving the account flat after a signal that asked to be reversed
  // — out of the market with nothing on screen saying so. The entry is now
  // checked BEFORE the close, so a refusal costs nothing.
  await loadDetectors(quiet);
  const ex = reversibleExchange(flipUpSeries(), { side: 'short', contracts: 2 });
  // Refuse anything that is not a close: the shape of every entry-side guard.
  ex.fetchBalance = async () => ({ USDT: { free: 0 }, total: { USDT: 0 } });

  const said = [];
  await scanSymbol({
    exchange: ex, symbol: 'BTC/USDT:USDT', timeframe: '1h',
    config: { ...reverseConfig(), dryRun: false },
    dedupe: new DedupeCache(60_000), lastBar: new Map(),
    logger: { log: (m) => said.push(m), warn: (m) => said.push(m), error: (m) => said.push(m) },
  });

  assert.equal(ex.orders.length, 0, 'nothing was sent — the position is still open');
  assert.match(said.join(' | '), /NOT reversing/, 'and the refusal is on the record');
  assert.match(said.join(' | '), /left alone rather than closed into nothing/);
});

test('the preflight evaluates rather than reading a cached result', async () => {
  // The preflight carries no clientOrderId, so its dedupe key is the generic
  // one a HAND-SENT trade also uses. Reading the cache there would hand back
  // a previous manual order's success as the answer to "could I enter?", and
  // the reversal would close a position on the strength of it.
  await loadDetectors(quiet);
  const ex = reversibleExchange(flipUpSeries(), { side: 'short', contracts: 2 });
  ex.fetchBalance = async () => ({ USDT: { free: 0 }, total: { USDT: 0 } });

  const dedupe = new DedupeCache(60_000);
  // Exactly what a manual buy on this symbol would have left behind.
  dedupe.set('sig:bybit:BTC/USDT:USDT:buy:open', { success: true, status: 'closed' });

  const said = [];
  await scanSymbol({
    exchange: ex, symbol: 'BTC/USDT:USDT', timeframe: '1h',
    config: { ...reverseConfig(), dryRun: false },
    dedupe, lastBar: new Map(),
    logger: { log: (m) => said.push(m), warn: (m) => said.push(m), error: (m) => said.push(m) },
  });

  assert.equal(ex.orders.length, 0, 'the stale cache did not authorise a close');
  assert.match(said.join(' | '), /NOT reversing/);
});

test('a viable reversal still closes and enters', async () => {
  // The guard must not become a blanket refusal: the ordinary path is
  // unchanged, and both legs still go.
  await loadDetectors(quiet);
  const ex = reversibleExchange(flipUpSeries(), { side: 'short', contracts: 2 });
  await scanSymbol({
    exchange: ex, symbol: 'BTC/USDT:USDT', timeframe: '1h',
    config: { ...reverseConfig(), dryRun: false },
    dedupe: new DedupeCache(60_000), lastBar: new Map(), logger: quiet,
  });
  assert.equal(ex.orders.length, 2, 'close then entry');
  assert.equal(ex.orders[0].reduceOnly, true);
  assert.equal(ex.orders[1].reduceOnly, false);
});

test('the check itself never places an order', async () => {
  // A preflight that sent something would double every reversal.
  await loadDetectors(quiet);
  const ex = reversibleExchange(flipUpSeries(), { side: 'short', contracts: 2 });
  await scanSymbol({
    exchange: ex, symbol: 'BTC/USDT:USDT', timeframe: '1h',
    config: { ...reverseConfig(), dryRun: false },
    dedupe: new DedupeCache(60_000), lastBar: new Map(), logger: quiet,
  });
  assert.equal(ex.orders.filter((o) => !o.reduceOnly).length, 1,
    'exactly one entry, not one per attempt');
});

test('a close that fails abandons the entry rather than stacking a position', async () => {
  // If the old position may still be there, opening the opposite would either
  // be refused as a flip or, in a hedge account, leave both directions on at
  // once. Neither is what the signal asked for.
  await loadDetectors(quiet);
  const ex = reversibleExchange(flipUpSeries(), { side: 'short', contracts: 2 });
  ex.createOrder = async (symbol, type, side, amount, price, params) => {
    if (params && params.reduceOnly) throw new Error('exchange rejected the close');
    ex.orders.push({ side, reduceOnly: false });
    return { id: '1', status: 'closed', filled: amount, average: 100 };
  };
  const said = [];
  await scanSymbol({
    exchange: ex, symbol: 'BTC/USDT:USDT', timeframe: '1h',
    config: { ...reverseConfig(), dryRun: false },
    dedupe: new DedupeCache(60_000), lastBar: new Map(),
    logger: { log: (m) => said.push(m), warn: (m) => said.push(m), error: (m) => said.push(m) },
  });
  assert.equal(ex.orders.length, 0, 'no entry was opened on top of a position that may still be open');
  assert.match(said.join(' | '), /entry skipped/i);
});

test('rewardRisk 0 means no target — the Supertrend line is the only exit', () => {
  // A fixed multiple of risk caps a trend follower at exactly the moment it is
  // working. Turning it off lets the position run until the stop is hit.
  const cs = flipUpSeries();
  const sig = deriveSupertrendSignal(cs, { ...stOpts, rewardRisk: 0 }, quiet);
  assert.ok(sig, 'the flip still produces a signal');
  assert.equal(sig.target, null, 'with no take-profit attached');
  assert.ok(Number.isFinite(sig.stop), 'but the stop is still there');
  assert.equal(sig.side, 'buy');
});

test('with no target the R:R floor is skipped, not failed against zero', () => {
  // R:R is reward divided by risk. With no reward there is no ratio, and
  // reporting it as 0 would make minRR reject every signal — which reads as
  // the strategy being broken rather than as the target being switched off.
  const cs = flipUpSeries();
  const sig = deriveSupertrendSignal(cs, { ...stOpts, rewardRisk: 0, minRR: 1.5 }, quiet);
  assert.ok(sig, 'a signal survives a minRR that nothing could satisfy');
  assert.equal(sig.rr, null, 'and R:R is reported as absent rather than as zero');
});

test('a target that is set is still held to the R:R floor', () => {
  // The escape hatch must not become a way past the filter for trades that
  // DO have a target.
  const cs = flipUpSeries();
  const sig = deriveSupertrendSignal(cs, { ...stOpts, rewardRisk: 1, minRR: 1.5 }, quiet);
  assert.equal(sig, null, 'a 1:1 target is still rejected under a 1.5 floor');
});

test('a Supertrend flip up is a long, stopped at the indicator line', async () => {
  await loadDetectors(quiet);
  const cs = flipUpSeries();
  const sig = deriveSupertrendSignal(cs, stOpts, quiet);
  assert.ok(sig, 'the flip produces a signal');
  assert.equal(sig.side, 'buy');
  assert.equal(sig.status, 'flip', 'not "forming" — a flip either happened or it did not');
  assert.equal(sig.entry, cs[cs.length - 1].c, 'entry is the close of the bar that flipped');
  assert.ok(sig.stop < sig.entry, 'the stop sits below a long');
  assert.ok(sig.target > sig.entry, 'and the target above it');
});

test('the target is a multiple of the indicator’s own risk', () => {
  const cs = flipUpSeries();
  for (const rr of [1, 2, 3.5]) {
    const sig = deriveSupertrendSignal(cs, { ...stOpts, rewardRisk: rr, minRR: 0 }, quiet);
    const risk = Math.abs(sig.entry - sig.stop);
    assert.ok(Math.abs((sig.target - sig.entry) - risk * rr) < 1e-9,
      `reward should be ${rr}x the risk`);
    assert.equal(sig.rr, rr);
  }
});

test('no flip means no signal, however strong the trend', () => {
  // Firing while the trend merely CONTINUES would re-enter the same position
  // on every scan for as long as it lasted.
  const cs = flipUpSeries();
  const held = cs.slice(0, cs.length - 1);   // stop before the turn
  assert.equal(deriveSupertrendSignal(held, stOpts, quiet), null);
});

test('a signal below SIGNAL_MIN_RR is refused', () => {
  const cs = flipUpSeries();
  assert.equal(deriveSupertrendSignal(cs, { ...stOpts, rewardRisk: 1, minRR: 1.5 }, quiet), null,
    '1:1 does not clear a 1.5 floor');
  assert.ok(deriveSupertrendSignal(cs, { ...stOpts, rewardRisk: 2, minRR: 1.5 }, quiet),
    'but 2:1 does');
});

test('too little history is no signal, not a crash', () => {
  assert.equal(deriveSupertrendSignal([], stOpts, quiet), null);
  assert.equal(deriveSupertrendSignal([{ t: 0, o: 1, h: 1, l: 1, c: 1, v: 1 }], stOpts, quiet), null);
});


test('a stop that cannot stop the trade is refused', () => {
  // Supertrend's construction puts the line on the correct side of the bar
  // that flips, so this is unreachable through the indicator itself. Testing
  // it through a generated series only proved the altered bar stopped
  // flipping, which is a different thing — so the rule is tested directly.
  const { usableStop } = require('../scanner');

  assert.equal(usableStop('buy', 100, 95), true, 'a long stops below');
  assert.equal(usableStop('buy', 100, 105), false, 'never above');
  assert.equal(usableStop('buy', 100, 100), false, 'and not at the entry, which cannot fill');

  assert.equal(usableStop('sell', 100, 105), true, 'a short stops above');
  assert.equal(usableStop('sell', 100, 95), false, 'never below');

  for (const bad of [NaN, Infinity, null, undefined, 'x']) {
    assert.equal(usableStop('buy', 100, bad), false, `stop ${String(bad)} is not usable`);
    assert.equal(usableStop('buy', bad, 95), false, `entry ${String(bad)} is not usable`);
  }
});

test('a sweep visits every symbol on every timeframe', async () => {
  // The per-bar dedupe keys on symbol AND timeframe, so BTC on 15m and BTC on
  // 1h are independent signals rather than one shadowing the other.
  await loadDetectors(quiet);
  const asked = [];
  const exchange = {
    id: 'fake',
    parseTimeframe: (tf) => ({ '15m': 900, '1h': 3600, '4h': 14400 }[tf]),
    async fetchOHLCV(symbol, timeframe) {
      asked.push(`${symbol}@${timeframe}`);
      return [];   // too few candles; the sweep should carry on regardless
    },
    async fetchBalance() { return { total: { USDT: 1000 } }; },
    has: { fetchPositions: true },
    async fetchPositions() { return []; },
  };
  const settings = {
    enabled: true, execute: false, strategy: 'supertrend',
    exchange: 'fake', symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT'],
    timeframe: '1h', timeframes: ['15m', '1h', '4h'],
    intervalMs: 60_000, candleLimit: 300, minCandles: 120,
    supertrend: { period: 10, multiplier: 3, rewardRisk: 2, minRR: 1.5 },
    rules: {},
  };

  await runScan({
    exchanges: { fake: exchange }, config: { scanner: settings, marginMode: 'cross' },
    settings, dedupe: new DedupeCache(0), lastBar: new Map(), breaker: null, logger: quiet,
  });

  assert.equal(asked.length, 6, 'two symbols x three timeframes');
  assert.deepEqual(asked.sort(), [
    'BTC/USDT:USDT@15m', 'BTC/USDT:USDT@1h', 'BTC/USDT:USDT@4h',
    'ETH/USDT:USDT@15m', 'ETH/USDT:USDT@1h', 'ETH/USDT:USDT@4h',
  ]);
});

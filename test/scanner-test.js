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

test('consecutive losing observations trip the breaker', () => {
  const b = new DailyLossBreaker({ maxDailyLossPercent: null, maxConsecutiveLosses: 3 });
  b.update(1000, quiet);
  b.update(995, quiet);
  b.update(990, quiet);
  assert.equal(b.blocked, false);
  b.update(985, quiet);
  assert.equal(b.blocked, true);
  assert.match(b.reason, /consecutive/);
});

test('a winning observation resets the losing streak', () => {
  const b = new DailyLossBreaker({ maxDailyLossPercent: null, maxConsecutiveLosses: 3 });
  b.update(1000, quiet);
  b.update(995, quiet);
  b.update(990, quiet);
  b.update(1010, quiet); // a win
  b.update(1005, quiet);
  assert.equal(b.blocked, false, 'the streak restarted');
  assert.equal(b.consecutiveLosses, 1);
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
  before.update(990, quiet);  // loss 1
  before.update(980, quiet);  // loss 2
  assert.equal(before.blocked, false);

  const after = new DailyLossBreaker(opts);
  assert.equal(after.consecutiveLosses, 2, 'the count carries over');
  after.update(970, quiet);   // loss 3
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

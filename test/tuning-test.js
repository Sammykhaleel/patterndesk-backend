// The tuning check on the server: every scanned symbol's setting measured on
// a timer, the last two measurements kept, and nothing traded.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTuningMonitor, measureSymbol, runningSetting, lastClosed, loadModules } = require('../tuning');
const { createApp } = require('../app');

const quiet = { log() {}, warn() {}, error() {} };
const HOUR = 3600000;

// The server measures with a COPY of the app's code. If the two drift, the
// Auto-trader and the Lineup would score the same setting differently.
test('the vendored backtest is the app\'s, line for line', () => {
  const root = path.resolve(__dirname, '..', '..');
  const app = fs.readFileSync(path.join(root, 'src', 'indicators', 'supertrend-backtest.js'), 'utf8')
    .replace("from './index.js'", "from './indicators.js'");
  const copy = fs.readFileSync(path.join(__dirname, '..', 'vendor', 'supertrend-backtest.js'), 'utf8');
  assert.equal(copy.split('\r\n').join('\n'), app.split('\r\n').join('\n'), 're-copy src/indicators/supertrend-backtest.js into server/vendor');
  const ind = fs.readFileSync(path.join(root, 'src', 'indicators', 'index.js'), 'utf8');
  const indCopy = fs.readFileSync(path.join(__dirname, '..', 'vendor', 'indicators.js'), 'utf8');
  assert.equal(indCopy.split('\r\n').join('\n'), ind.split('\r\n').join('\n'), 'and src/indicators/index.js');
});

/** Trending in long stretches, with wicks, so the supertrend flips often enough to score. */
function series(seed, n, tfMs, end) {
  let x = seed >>> 0;
  const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const out = [];
  let c = 100, drift = 0;
  for (let i = 0; i < n; i++) {
    if (i % 40 === 0) drift = (rnd() - 0.5) * 0.012;
    const o = c;
    c = o * (1 + drift + (rnd() - 0.5) * 0.02);
    out.push([end - (n - i) * tfMs, o, Math.max(o, c) * (1 + rnd() * 0.008), Math.min(o, c) * (1 - rnd() * 0.008), c, 1]);
  }
  return out;
}

const TF_MS = { '1h': HOUR, '4h': 4 * HOUR, '30m': HOUR / 2 };
function venue({ failOn = [], calls = [] } = {}) {
  const NOW = Date.UTC(2026, 9, 2, 12);
  return {
    NOW, calls,
    parseTimeframe: (tf) => TF_MS[tf] / 1000,
    async fetchOHLCV(symbol, tf, since, limit) {
      calls.push({ symbol, tf, limit, since });
      if (failOn.includes(tf)) throw new Error('timeframe not served');
      return series(symbol.length * 7 + tf.length, 600, TF_MS[tf], NOW);
    },
  };
}

const SETTINGS = () => ({
  symbols: ['ZEC/USDT:USDT', 'DOT/USDT:USDT'], timeframes: ['1h'], supertrend: { period: 10, multiplier: 3 },
  overrides: {
    'ZEC/USDT:USDT': { timeframe: '4h', supertrend: { period: 14, multiplier: 3 } },
    'DOT/USDT:USDT': { partial: { pricePct: 3, sizePct: 50 } },        // a partial close is not a tuning
  },
});

test('the setting a symbol runs', () => {
  const s = SETTINGS();
  assert.deepEqual(runningSetting(s, 'ZEC/USDT:USDT'), { timeframe: '4h', period: 14, mult: 3 });
  assert.deepEqual(runningSetting(s, 'DOT/USDT:USDT'), { timeframe: '1h', period: 10, mult: 3 }, 'the global one');
  assert.equal(runningSetting({ ...s, timeframes: ['1h', '4h'], overrides: {} }, 'DOT/USDT:USDT'), null,
    'several timeframes: nothing single to measure');
});

test('the last CLOSED bar: the forming one is not a signal', () => {
  const c = [{ t: 0 }, { t: HOUR }];
  assert.equal(lastClosed(c, HOUR, HOUR + 10), 0, 'still forming');
  assert.equal(lastClosed(c, HOUR, 2 * HOUR), 1, 'closed');
});

test('one symbol: every timeframe\'s best, its own setting, and the partial close on it', async () => {
  const ex = venue();
  const m = await measureSymbol({ exchange: ex, symbol: 'ZEC/USDT:USDT', setting: { timeframe: '4h', period: 14, mult: 3 },
    timeframes: ['30m', '1h', '4h'], now: () => ex.NOW });
  assert.deepEqual(ex.calls.map((c) => c.tf), ['30m', '1h', '4h']);
  assert.ok(ex.calls.every((c) => c.limit === 1000), 'a page at a time');
  assert.ok(ex.calls.every((c) => c.since === ex.NOW - 4000 * TF_MS[c.tf]), '4,000 bars back: the deep history');
  assert.equal(m.key, '4h 14/3');
  assert.equal(m.rows.length, 3, 'a best setting per timeframe');
  assert.ok(m.rows.every((r) => Number.isFinite(r.score) && (r.dir === 1 || r.dir === -1) && r.stopPct > 0));
  assert.equal(m.running.tf, '4h');
  assert.equal(m.running.period, 14);
  assert.ok(m.running.dir === 1 || m.running.dir === -1, 'its side');
  assert.deepEqual(m.partials.rows.map((r) => r.pricePct), [1, 2, 3], 'price targets only');
  assert.equal(m.partials.frac, 0.5);
  assert.equal(m.partials.n, m.running.n, 'measured on the same flips');
});

test('a timeframe the exchange will not serve is skipped, not fatal', async () => {
  const ex = venue({ failOn: ['30m'] });
  const m = await measureSymbol({ exchange: ex, symbol: 'ZEC/USDT:USDT', setting: null, timeframes: ['30m', '1h'], now: () => ex.NOW, logger: quiet });
  assert.deepEqual(m.rows.map((r) => r.tf), ['1h']);
  assert.equal(m.running, null);
});

test('the monitor keeps two measurements, and when the setting started', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tuning-'));
  const ex = venue();
  let t = ex.NOW;
  const settings = SETTINGS();
  const make = () => createTuningMonitor({ getExchange: () => ex, getSettings: () => settings, stateDir: dir,
    timeframes: ['1h', '4h'], now: () => t, pauseMs: 0, logger: quiet });
  const mon = make();
  await mon.runOnce();
  let zec = mon.snapshot().symbols['ZEC/USDT:USDT'];
  assert.equal(zec.previous, null, 'one measurement so far');
  assert.equal(zec.since, 0, 'first sight is not a change: no day of grace');

  t += 2 * HOUR;
  await mon.runOnce();
  zec = mon.snapshot().symbols['ZEC/USDT:USDT'];
  assert.equal(zec.previous.at, ex.NOW, 'the first is now the previous');
  assert.equal(zec.current.at, ex.NOW + 2 * HOUR);
  assert.equal(zec.since, 0, 'same setting: still none');

  // Switched setting: its own day starts now.
  settings.overrides['ZEC/USDT:USDT'] = { timeframe: '1h', supertrend: { period: 7, multiplier: 2 } };
  t += 2 * HOUR;
  await mon.runOnce();
  zec = mon.snapshot().symbols['ZEC/USDT:USDT'];
  assert.equal(zec.current.key, '1h 7/2');
  assert.equal(zec.since, t, 'a new setting starts again');

  // Dropped from the scanner: dropped here.
  settings.symbols = ['ZEC/USDT:USDT'];
  await mon.runOnce();
  assert.deepEqual(Object.keys(mon.snapshot().symbols), ['ZEC/USDT:USDT']);

  // Survives a restart.
  const again = make();
  assert.equal(again.snapshot().symbols['ZEC/USDT:USDT'].current.key, '1h 7/2');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('one run at a time', async () => {
  const ex = venue();
  let release;
  ex.fetchOHLCV = async () => { await new Promise((r) => { release = r; }); return []; };
  const mon = createTuningMonitor({ getExchange: () => ex, getSettings: SETTINGS, timeframes: ['1h'], pauseMs: 0, logger: quiet });
  const first = mon.runOnce();
  assert.equal(mon.busy, true);
  assert.deepEqual(await mon.runOnce(), { skipped: 'already running' });
  release(); await new Promise((r) => setTimeout(r, 0)); release && release();
  await first.catch(() => {});
});

test('it never trades', async () => {
  const ex = venue();
  ex.createOrder = () => { throw new Error('the tuning check placed an order'); };
  ex.cancelOrder = ex.createOrder;
  const mon = createTuningMonitor({ getExchange: () => ex, getSettings: SETTINGS, timeframes: ['1h'], pauseMs: 0, logger: quiet });
  await mon.runOnce();
  assert.ok(Object.keys(mon.snapshot().symbols).length > 0);
});

test('/api/tuning reports it, behind the token; a run can be started', async (t) => {
  const AUTH = 'a'.repeat(64);
  let runs = 0;
  const app = createApp({
    config: { authToken: AUTH, allowedOrigins: [], rateLimitPerMinute: 100, useTestnet: true, dryRun: true,
      tradePercentage: 5, leverage: 3, maxPositionNotional: 1000, stopLossPercent: 2, dedupeTtlMs: 60_000,
      scanner: { enabled: false, execute: false, strategy: 'supertrend', exchange: 'bybit', symbols: ['BTC/USDT:USDT'],
        timeframe: '1h', timeframes: ['1h'], intervalMs: 60_000, rules: { minRR: 1.5 },
        supertrend: { period: 10, multiplier: 3, rewardRisk: 2, minRR: 1.5 } } },
    getExchanges: () => ({}), isReady: () => true, logger: quiet,
  });
  app.locals.tuning = { busy: false, snapshot: () => ({ everyMs: 7200000, lastRunAt: 5, symbols: { X: { current: { key: '1h 7/2' } } } }),
    runOnce: async () => { runs += 1; } };
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/tuning`)).status, 401);
  const out = await (await fetch(`${base}/api/tuning`, { headers: { 'X-Auth-Token': AUTH } })).json();
  assert.equal(out.running, true);
  assert.equal(out.symbols.X.current.key, '1h 7/2');
  const go = await (await fetch(`${base}/api/tuning/run`, { method: 'POST', headers: { 'X-Auth-Token': AUTH } })).json();
  assert.equal(go.started, true);
  assert.equal(runs, 1);
});

test('/api/tuning carries the scanner\'s live sides', async (t) => {
  const AUTH = 'a'.repeat(64);
  const app = createApp({
    config: { authToken: AUTH, allowedOrigins: [], rateLimitPerMinute: 100, useTestnet: true, dryRun: true,
      tradePercentage: 5, leverage: 3, maxPositionNotional: 1000, stopLossPercent: 2, dedupeTtlMs: 60_000,
      scanner: { enabled: false, execute: false, strategy: 'supertrend', exchange: 'bybit', symbols: ['BTC/USDT:USDT'],
        timeframe: '1h', timeframes: ['1h'], intervalMs: 60_000, rules: { minRR: 1.5 },
        supertrend: { period: 10, multiplier: 3, rewardRisk: 2, minRR: 1.5 } } },
    getExchanges: () => ({}), isReady: () => true, logger: quiet,
  });
  app.locals.scanner = { directions: () => [{ symbol: 'MSTR/USDT:USDT', timeframe: '30m', period: 20, mult: 3, dir: -1, bar: 1, at: 2 }] };
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => server.close());
  const out = await (await fetch(`http://127.0.0.1:${server.address().port}/api/tuning`, { headers: { 'X-Auth-Token': AUTH } })).json();
  assert.equal(out.directions[0].dir, -1, 'served even when the tuning check is off');
  assert.equal(out.running, false);
});

test('asked for at once, the timeframes are fetched a few at a time — same result', async () => {
  const ex = venue();
  let inFlight = 0, peak = 0;
  const base = ex.fetchOHLCV.bind(ex);
  ex.fetchOHLCV = async (...a) => { inFlight += 1; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 5)); try { return await base(...a); } finally { inFlight -= 1; } };
  const setting = { timeframe: '4h', period: 14, mult: 3 };
  const fast = await measureSymbol({ exchange: ex, symbol: 'ZEC/USDT:USDT', setting, timeframes: ['30m', '1h', '4h'], parallel: 4, now: () => ex.NOW });
  assert.ok(peak > 1 && peak <= 4, `fetched in parallel, at most 4 (${peak})`);
  peak = 0;
  const slow = await measureSymbol({ exchange: ex, symbol: 'ZEC/USDT:USDT', setting, timeframes: ['30m', '1h', '4h'], now: () => ex.NOW });
  assert.equal(peak, 1, 'the scheduled check stays one at a time');
  assert.deepEqual(fast, slow, 'and the answer is the same');
});

test('each measured row says how much history it rests on, and what holding did', async () => {
  const ex = venue();
  const m = await measureSymbol({ exchange: ex, symbol: 'ZEC/USDT:USDT', setting: { timeframe: '4h', period: 14, mult: 3 },
    timeframes: ['1h', '4h'], now: () => ex.NOW });
  for (const r of [...m.rows, m.running]) {
    assert.ok(Number.isFinite(r.from) && r.from < ex.NOW, `${r.tf}: where its history starts`);
    assert.equal(r.bars, 600, 'and how many bars');
    assert.ok('buyHold' in r, 'and buy-and-hold over the same bars');
  }
});

test('rows also carry the last 60 days alone, where the history reaches that far', async () => {
  const ex = venue();
  const m = await measureSymbol({ exchange: ex, symbol: 'ZEC/USDT:USDT', setting: { timeframe: '4h', period: 14, mult: 3 },
    timeframes: ['1h', '4h'], now: () => ex.NOW });
  const h4 = m.rows.find((r) => r.tf === '4h'), h1 = m.rows.find((r) => r.tf === '1h');
  assert.ok(h4.recent && h4.recent.days === 60 && Number.isFinite(h4.recent.totalPct) && Number.isFinite(h4.recent.buyHold),
    '600 bars of 4h is 100 days: a 60-day figure');
  assert.equal(h1 && h1.recent, null, '600 bars of 1h is 25 days: none, rather than a shorter window passed off as 60 days');
  assert.ok(m.running.recent, 'and the running setting too');
});

test('recentResult counts only trades entered inside the window, and holds from its start', async () => {
  const { recentResult, backtestSupertrend } = await loadModules();
  const DAY = 86400000, T0 = Date.UTC(2026, 0, 1);
  // 200 days of daily bars swinging up and down on a rising trend.
  const c = Array.from({ length: 200 }, (_, i) => {
    const leg = Math.floor(i / 10), k = i % 10;
    const px = 100 + i + (leg % 2 ? 10 - k : k) * 6;
    return { t: T0 + i * DAY, o: px, h: px * 1.01, l: px * 0.99, c: px, v: 1 };
  });
  const all = backtestSupertrend(c, 7, 1.5);
  const r = recentResult(c, 7, 1.5);
  assert.equal(r.days, 60);
  assert.ok(r.n < all.n, `fewer trades than the whole history (${r.n} < ${all.n})`);
  const start = c.find((k) => k.t >= c.at(-1).t - 60 * DAY);
  assert.ok(Math.abs(r.buyHold - (c.at(-1).c - start.c) / start.c * 100) < 1e-9, 'hold measured from the window start');
  assert.equal(recentResult(c.slice(150), 7, 1.5), null, '50 days of history: no 60-day figure');
});

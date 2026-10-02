// Best TF and ST Test on the server: one request, the same numbers the app
// would have computed on the phone from the same candles.
const test = require('node:test');
const assert = require('node:assert/strict');
const { bestTimeframes, stTest, _cache } = require('../backtestapi');
const { loadModules } = require('../tuning');
const { createApp } = require('../app');

const quiet = { log() {}, warn() {}, error() {} };
const HOUR = 3600000;
const TF_MS = { '1h': HOUR, '4h': 4 * HOUR, '30m': HOUR / 2, '1d': 24 * HOUR };

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

function venue({ failOn = [] } = {}) {
  const calls = [];
  const NOW = Date.UTC(2026, 9, 2, 12);
  return {
    id: 'bybit', calls, NOW,
    has: { fetchOHLCV: true },
    market: (s) => { if (!/USDT/.test(s)) throw new Error('no'); return { symbol: s }; },
    async fetchOHLCV(symbol, tf, since, limit) {
      calls.push({ tf, limit });
      if (failOn.includes(tf)) throw new Error('not served');
      return series(symbol.length * 3 + tf.length, 600, TF_MS[tf], NOW);
    },
  };
}
const toCandles = (rows) => rows.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));

test('Best TF: every timeframe in one call, the same numbers the app computes', async () => {
  _cache.clear();
  const ex = venue();
  const out = await bestTimeframes({ exchange: ex, symbol: 'VVV/USDT:USDT', timeframes: ['30m', '1h', '4h'] });
  assert.deepEqual(out.results.map((r) => r.tf), ['30m', '1h', '4h'], 'in the order asked');
  assert.ok(ex.calls.every((c) => c.limit === 1000), 'the 1,000 bars the app fetches');
  const { sweepSupertrend } = await loadModules();
  for (const r of out.results) {
    const local = sweepSupertrend(toCandles(series('VVV/USDT:USDT'.length * 3 + r.tf.length, 600, TF_MS[r.tf], ex.NOW)));
    assert.deepEqual(r.best, local[0], `${r.tf}: identical to the app's sweep`);
    assert.ok(r.stopPct > 0);
  }
});

test('Best TF: cached, so a second look costs nothing', async () => {
  _cache.clear();
  const ex = venue();
  await bestTimeframes({ exchange: ex, symbol: 'A/USDT:USDT', timeframes: ['1h'] });
  const again = await bestTimeframes({ exchange: ex, symbol: 'A/USDT:USDT', timeframes: ['1h'] });
  assert.equal(ex.calls.length, 1);
  assert.equal(again.cached, true);
});

test('Best TF: a timeframe the exchange will not serve is a row with its reason', async () => {
  _cache.clear();
  const out = await bestTimeframes({ exchange: venue({ failOn: ['4h'] }), symbol: 'B/USDT:USDT', timeframes: ['1h', '4h'] });
  assert.ok(out.results[0].best);
  assert.equal(out.results[1].best, null);
  assert.match(out.results[1].error, /could not serve 4h/);
});

test('an unlisted symbol is refused', async () => {
  await assert.rejects(bestTimeframes({ exchange: venue(), symbol: 'AAPL', timeframes: ['1h'] }), /not listed/);
});

test('ST Test: the current setting, the ranking and the partial-close table, as the app computes them', async () => {
  _cache.clear();
  const ex = venue();
  const out = await stTest({ exchange: ex, symbol: 'VVV/USDT:USDT', timeframe: '4h', period: '10', mult: '4' });
  const { backtestSupertrend, sweepSupertrend, comparePartials } = await loadModules();
  const c = toCandles(series('VVV/USDT:USDT'.length * 3 + 2, 600, TF_MS['4h'], ex.NOW));
  assert.deepEqual(out.cur, backtestSupertrend(c, 10, 4));
  assert.deepEqual(out.sweep, sweepSupertrend(c).slice(0, 10));
  assert.deepEqual(out.partials, comparePartials(c, 10, 4));
  assert.equal(out.bars, 600);
  assert.equal(out.first, c[0].t);
});

test('ST Test: the inputs are checked', async () => {
  const ex = venue();
  await assert.rejects(stTest({ exchange: ex, symbol: 'V/USDT', timeframe: '2y', period: 10, mult: 3 }), /timeframe/);
  await assert.rejects(stTest({ exchange: ex, symbol: 'V/USDT', timeframe: '1h', period: 1, mult: 3 }), /period/);
  await assert.rejects(stTest({ exchange: ex, symbol: 'V/USDT', timeframe: '1h', period: 10, mult: 0 }), /mult/);
});

test('/api/besttf and /api/sttest, behind the token', async (t) => {
  _cache.clear();
  const AUTH = 'a'.repeat(64);
  const ex = venue();
  const app = createApp({
    config: { authToken: AUTH, allowedOrigins: [], rateLimitPerMinute: 100, useTestnet: true, dryRun: true,
      tradePercentage: 5, leverage: 3, maxPositionNotional: 1000, stopLossPercent: 2, dedupeTtlMs: 60_000,
      scanner: { enabled: false, execute: false, strategy: 'supertrend', exchange: 'bybit', symbols: ['BTC/USDT:USDT'],
        timeframe: '1h', timeframes: ['1h'], intervalMs: 60_000, rules: { minRR: 1.5 },
        supertrend: { period: 10, multiplier: 3, rewardRisk: 2, minRR: 1.5 } } },
    getExchanges: () => ({ bybit: ex }), isReady: () => true, logger: quiet,
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/besttf?exchange=bybit&symbol=VVV/USDT:USDT`)).status, 401);
  const h = { headers: { 'X-Auth-Token': AUTH } };
  const bt = await (await fetch(`${base}/api/besttf?exchange=bybit&symbol=${encodeURIComponent('VVV/USDT:USDT')}`, h)).json();
  assert.equal(bt.success, true);
  assert.equal(bt.results.length, 11, 'every timeframe the app sweeps');
  const st = await (await fetch(`${base}/api/sttest?exchange=bybit&symbol=${encodeURIComponent('VVV/USDT:USDT')}&timeframe=4h&period=10&mult=4`, h)).json();
  assert.equal(st.success, true);
  assert.ok(st.cur && st.sweep.length && st.partials);
  const bad = await fetch(`${base}/api/sttest?exchange=bybit&symbol=AAPL&timeframe=4h&period=10&mult=4`, h);
  assert.equal(bad.status, 400);
});

test('more than one page: paged forward, joined without gaps or repeats, the last N kept', async () => {
  const { candlesFor } = require('../backtestapi');
  const NOW = Date.UTC(2026, 9, 2, 12);
  const all = series(9, 5000, HOUR, NOW);                  // what the exchange holds
  const calls = [];
  const ex = {
    parseTimeframe: () => 3600,
    async fetchOHLCV(symbol, tf, since, limit) {
      calls.push({ since, limit });
      // Like Bybit: from \`since\` forward, at most \`limit\`, and the page boundary overlaps by one bar.
      const from = all.findIndex((r) => r[0] >= since);
      return from < 0 ? [] : all.slice(Math.max(0, from - 1), from - 1 + limit);
    },
  };
  const c = await candlesFor(ex, 'BTC/USDT:USDT', '1h', 4000, NOW);
  assert.equal(c.length, 4000);
  assert.equal(c[c.length - 1].t, all[all.length - 1][0], 'up to the latest bar');
  assert.ok(c.every((x, i) => i === 0 || x.t - c[i - 1].t === HOUR), 'contiguous, no repeats');
  assert.ok(calls.length >= 4 && calls.length <= 6, `paged: ${calls.length} requests`);
  assert.ok(calls.every((x) => x.limit === 1000));
});

test('a page or less: one request, as before', async () => {
  const { candlesFor } = require('../backtestapi');
  const calls = [];
  const ex = { async fetchOHLCV(s, tf, since, limit) { calls.push({ since, limit }); return series(1, limit, HOUR, Date.UTC(2026, 9, 2)); } };
  const c = await candlesFor(ex, 'X/USDT:USDT', '1h', 1000);
  assert.equal(c.length, 1000);
  assert.deepEqual(calls, [{ since: undefined, limit: 1000 }]);
});

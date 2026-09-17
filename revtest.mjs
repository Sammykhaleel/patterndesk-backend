// Does a mean-reversion rule do better than a trend rule on this venue?
//
// The trend result pointed here rather than away: across 58 liquid Weex perps
// the most "trending" symbol scored 0.136 on Kaufman efficiency — for every $1
// of net movement there was $7.35 of thrash. A trend-following tool in an
// environment like that loses by construction, which is what a 0.03
// correlation and a negative mean in every bucket look like.
//
// Two things make this test honest rather than a fishing trip:
//
//   1. A CONTROL. Every rule is compared against buy-and-hold over the same
//      bars. If the whole venue fell, a short-biased rule "wins" for a reason
//      that has nothing to do with the rule. Without the control there is no
//      way to tell skill from a falling market.
//   2. A SPLIT. Rules are ranked on the first half and the ranking is then
//      applied to the second. Picking the best rule over all the bars and
//      quoting its return is how a backtest becomes a story.
//
// Every trade pays maker fees both ways. Nothing is netted out.
import ccxt from 'ccxt';
import { rsi, bollinger, stochastic } from './vendor/indicators.js';

const MAKER_BPS = 2;
const TF = '1h';
const COST = (2 * MAKER_BPS) / 10000;

/**
 * Run a signal function over the bars.
 *
 * `signal(i)` returns +1 to be long, -1 short, 0 flat, computed only from data
 * up to and including bar i. Position is taken at that bar's close, which is
 * the earliest price a live system could get.
 */
function run(candles, signal) {
  let side = 0, entry = 0, equity = 1, trades = 0, wins = 0;
  let bars = 0, exposedBars = 0;
  for (let i = 1; i < candles.length; i += 1) {
    bars += 1;
    if (side !== 0) exposedBars += 1;
    const want = signal(i);
    if (want === side) continue;
    const price = candles[i].c;
    if (side !== 0) {
      const g = side === 1 ? (price - entry) / entry : (entry - price) / entry;
      const n = g - COST;
      equity *= 1 + n;
      trades += 1;
      if (n > 0) wins += 1;
    }
    side = want;
    entry = price;
  }
  return {
    ret: equity - 1, trades, winRate: trades ? wins / trades : NaN,
    exposure: bars ? exposedBars / bars : 0,
  };
}

/** The rules under test. Each returns a signal function bound to the bars. */
function rules(c) {
  const r = rsi(c, 14);
  const b = bollinger(c, 20, 2);
  const st = stochastic(c, 14, 3, 3);

  return {
    // Fade an extreme, go flat when it has reverted to the middle.
    'rsi 30/70': (i) => {
      const v = r[i]; if (v == null) return 0;
      if (v < 30) return 1;
      if (v > 70) return -1;
      return 0;
    },
    // Same, but hold until the middle rather than releasing at the band.
    'rsi hold-to-50': (() => {
      let held = 0;
      return (i) => {
        const v = r[i]; if (v == null) return held = 0;
        if (held === 1 && v >= 50) held = 0;
        else if (held === -1 && v <= 50) held = 0;
        else if (held === 0 && v < 30) held = 1;
        else if (held === 0 && v > 70) held = -1;
        return held;
      };
    })(),
    'bollinger 2sd': (i) => {
      const up = b.up[i], lo = b.lo[i]; if (up == null || lo == null) return 0;
      const px = c[i].c;
      if (px < lo) return 1;
      if (px > up) return -1;
      return 0;
    },
    'bollinger to-mid': (() => {
      let held = 0;
      return (i) => {
        const up = b.up[i], lo = b.lo[i], mid = b.mid[i];
        if (up == null || lo == null || mid == null) return held = 0;
        const px = c[i].c;
        if (held === 1 && px >= mid) held = 0;
        else if (held === -1 && px <= mid) held = 0;
        else if (held === 0 && px < lo) held = 1;
        else if (held === 0 && px > up) held = -1;
        return held;
      };
    })(),
    'stoch 20/80': (i) => {
      const k = st.k ? st.k[i] : (Array.isArray(st) ? st[i] : null);
      if (k == null) return 0;
      if (k < 20) return 1;
      if (k > 80) return -1;
      return 0;
    },
  };
}

const ex = new ccxt.weex({ enableRateLimit: true, timeout: 25000, options: { defaultType: 'swap' } });
await ex.loadMarkets();
const tickers = await ex.fetchTickers(undefined, { type: 'swap' });
const liquid = Object.values(tickers)
  .filter((t) => ex.markets[t.symbol]?.swap && ex.markets[t.symbol]?.linear)
  .filter((t) => Number(t.quoteVolume) > 5_000_000)
  .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
  .slice(0, 60).map((t) => t.symbol);

const data = [];
const queue = [...liquid];
async function worker() {
  for (;;) {
    const s = queue.shift(); if (!s) return;
    try {
      const raw = await ex.fetchOHLCV(s, TF, undefined, 1000);
      const c = raw.map(([t, o, h, l, cl, v]) => ({ t, o, h, l, c: cl, v }));
      if (c.length >= 600) data.push({ symbol: s, c });
    } catch { /* not served; it simply does not appear */ }
  }
}
await Promise.all([worker(), worker(), worker()]);
console.log(`${data.length} symbols, ${TF}, maker ${MAKER_BPS}bp/side\n`);

const names = Object.keys(rules(data[0].c));
const agg = {};
for (const n of names) agg[n] = { first: [], second: [], all: [] };
const hold = { first: [], second: [], all: [] };

for (const { c } of data) {
  const half = Math.floor(c.length / 2);
  const parts = { first: c.slice(0, half), second: c.slice(half), all: c };
  for (const [part, bars] of Object.entries(parts)) {
    hold[part].push((bars[bars.length - 1].c - bars[0].c) / bars[0].c);
    const rs = rules(bars);                       // rebuilt per slice: no state leaks across
    for (const n of names) agg[n][part].push(run(bars, rs[n]).ret);
  }
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const medianOf = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const winPct = (a) => (a.filter((v) => v > 0).length / a.length) * 100;
const p = (v) => `${(v * 100).toFixed(1)}%`;

console.log('rule               1st half              2nd half              whole');
console.log('                 mean  med   win%     mean  med   win%     mean  med   win%');
for (const n of names) {
  const f = agg[n].first, s = agg[n].second, a = agg[n].all;
  console.log(`${n.padEnd(17)}${p(mean(f)).padStart(6)}${p(medianOf(f)).padStart(6)}${winPct(f).toFixed(0).padStart(5)}%  ` +
    `${p(mean(s)).padStart(7)}${p(medianOf(s)).padStart(6)}${winPct(s).toFixed(0).padStart(5)}%  ` +
    `${p(mean(a)).padStart(7)}${p(medianOf(a)).padStart(6)}${winPct(a).toFixed(0).padStart(5)}%`);
}
console.log(`${'BUY & HOLD'.padEnd(17)}${p(mean(hold.first)).padStart(6)}${p(medianOf(hold.first)).padStart(6)}` +
  `${winPct(hold.first).toFixed(0).padStart(5)}%  ${p(mean(hold.second)).padStart(7)}${p(medianOf(hold.second)).padStart(6)}` +
  `${winPct(hold.second).toFixed(0).padStart(5)}%  ${p(mean(hold.all)).padStart(7)}${p(medianOf(hold.all)).padStart(6)}` +
  `${winPct(hold.all).toFixed(0).padStart(5)}%`);

// The split test: does the rule that led in the first half lead in the second?
const rank = (part) => names.map((n) => [n, mean(agg[n][part])]).sort((a, b) => b[1] - a[1]);
console.log(`\nbest rule in the 1st half : ${rank('first')[0][0]}  (${p(rank('first')[0][1])})`);
const winner = rank('first')[0][0];
console.log(`that same rule in the 2nd : ${p(mean(agg[winner].second))}  vs buy-and-hold ${p(mean(hold.second))}`);
console.log(`best rule in the 2nd half : ${rank('second')[0][0]}  (${p(rank('second')[0][1])})  <- only visible afterwards`);
console.log(`\nread at ${new Date().toISOString()}`);

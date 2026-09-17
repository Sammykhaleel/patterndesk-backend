// Which symbols are trending rather than chopping — and does knowing that
// IN ADVANCE actually help?
//
// Supertrend is a trend-following rule, so testing it across chop was testing
// it where it is built to fail. The fair question is whether trendiness can be
// measured before the fact and whether that measurement predicts profit after
// it.
//
// Trendiness here is Kaufman's efficiency ratio: how far price travelled net,
// divided by how far it travelled in total. A symbol that goes straight up
// scores near 1. One that ends where it started after thrashing scores near 0.
//
// The experiment that matters is the SPLIT one. Measuring efficiency and
// profit over the same bars proves nothing — a symbol that trended is
// obviously one where a trend rule made money, and that is a description of
// the past, not a way to choose tomorrow. So efficiency is measured on the
// first half and profit on the second half, which is the only version of the
// question that could ever be traded.
import ccxt from 'ccxt';
import { supertrend } from './vendor/indicators.js';

const MAKER_BPS = 2;
const PERIOD = 10;
const MULT = 3;
const TF = '1h';

/** Kaufman efficiency ratio: net displacement over total path length. */
function efficiencyRatio(candles) {
  if (candles.length < 2) return NaN;
  let path = 0;
  for (let i = 1; i < candles.length; i += 1) path += Math.abs(candles[i].c - candles[i - 1].c);
  if (path <= 0) return NaN;
  return Math.abs(candles[candles.length - 1].c - candles[0].c) / path;
}

function stReturn(candles, costBps) {
  const st = supertrend(candles, PERIOD, MULT);
  const cost = (2 * costBps) / 10000;
  let side = 0, entry = 0, equity = 1, n = 0;
  for (let i = 1; i < candles.length; i += 1) {
    const now = st[i], prev = st[i - 1];
    if (!now || !prev || now.dir === prev.dir) continue;
    const price = candles[i].c;
    if (side !== 0) {
      const g = side === 1 ? (price - entry) / entry : (entry - price) / entry;
      equity *= 1 + (g - cost);
      n += 1;
    }
    side = now.dir;
    entry = price;
  }
  return { ret: equity - 1, trades: n };
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : NaN;
}

// defaultType matters: fetchTickers() with no options returns SPOT on this
// venue — 1,924 of them, and not one perp. The scan was silently empty.
const ex = new ccxt.weex({ enableRateLimit: true, timeout: 25000, options: { defaultType: 'swap' } });
await ex.loadMarkets();

// The liquid end of the venue: illiquid symbols can post a spectacular
// efficiency ratio on a book nobody can trade through.
const tickers = await ex.fetchTickers(undefined, { type: 'swap' });
const liquid = Object.values(tickers)
  .filter((t) => ex.markets[t.symbol]?.swap && ex.markets[t.symbol]?.linear)
  .filter((t) => Number(t.quoteVolume) > 5_000_000)
  .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
  .slice(0, 60)
  .map((t) => t.symbol);

console.log(`scanning ${liquid.length} liquid Weex perps on ${TF}…\n`);

const rows = [];
const queue = [...liquid];
async function worker() {
  for (;;) {
    const symbol = queue.shift();
    if (!symbol) return;
    try {
      const raw = await ex.fetchOHLCV(symbol, TF, undefined, 1000);
      const c = raw.map(([t, o, h, l, cl, v]) => ({ t, o, h, l, c: cl, v }));
      if (c.length < 600) continue;
      const half = Math.floor(c.length / 2);
      const first = c.slice(0, half);
      const second = c.slice(half);
      rows.push({
        symbol,
        erAll: efficiencyRatio(c),
        erFirst: efficiencyRatio(first),
        erSecond: efficiencyRatio(second),
        retAll: stReturn(c, MAKER_BPS),
        retSecond: stReturn(second, MAKER_BPS),
        vol: Number(tickers[symbol].quoteVolume),
      });
    } catch { /* a symbol the venue would not serve; it simply does not appear */ }
  }
}
await Promise.all([worker(), worker(), worker()]);

rows.sort((a, b) => b.erAll - a.erAll);
console.log('MOST TRENDING (whole 41 days), supertrend net after maker fees');
console.log('symbol      ER    net%   trades   24h vol');
for (const r of rows.slice(0, 12)) {
  console.log(`${r.symbol.split('/')[0].padEnd(10)} ${r.erAll.toFixed(3)} ${(r.retAll.ret * 100).toFixed(1).padStart(7)} ` +
    `${String(r.retAll.trades).padStart(6)}   $${(r.vol / 1e6).toFixed(0)}M`);
}
console.log('\nMOST CHOPPY');
for (const r of rows.slice(-6)) {
  console.log(`${r.symbol.split('/')[0].padEnd(10)} ${r.erAll.toFixed(3)} ${(r.retAll.ret * 100).toFixed(1).padStart(7)} ` +
    `${String(r.retAll.trades).padStart(6)}   $${(r.vol / 1e6).toFixed(0)}M`);
}

// --- same window: a description of the past ---
const cSame = pearson(rows.map((r) => r.erAll), rows.map((r) => r.retAll.ret));
// --- split window: the only version you could trade ---
const cSplit = pearson(rows.map((r) => r.erFirst), rows.map((r) => r.retSecond.ret));

console.log(`\nn = ${rows.length} symbols`);
console.log(`correlation, efficiency vs profit OVER THE SAME BARS : ${cSame.toFixed(3)}  (hindsight)`);
console.log(`correlation, efficiency FIRST half vs profit SECOND  : ${cSplit.toFixed(3)}  (tradeable)`);

const top = [...rows].sort((a, b) => b.erFirst - a.erFirst).slice(0, 10);
const bot = [...rows].sort((a, b) => a.erFirst - b.erFirst).slice(0, 10);
const mean = (a) => a.reduce((s, r) => s + r.retSecond.ret, 0) / a.length;
console.log(`\nPicking by first-half trendiness, then trading the second half:`);
console.log(`  top 10 most trending  -> mean second-half return ${(mean(top) * 100).toFixed(2)}%`);
console.log(`  bottom 10 choppiest   -> mean second-half return ${(mean(bot) * 100).toFixed(2)}%`);
console.log(`  all ${rows.length} symbols        -> mean second-half return ${(mean(rows) * 100).toFixed(2)}%`);
console.log(`\nread at ${new Date().toISOString()}`);

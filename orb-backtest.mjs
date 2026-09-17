// One crypto symbol a day, traded intraday, flat by the close.
//
// The rules were fixed BEFORE any result was seen:
//
//   universe   liquid crypto perps listed on both OKX and Weex
//   data       OKX 5m bars (Weex will not page history back), Weex fees
//   anchors    13:30 UTC and 00:00 UTC
//   range      the first 15, 30 or 60 minutes after the anchor
//   selection  highest opening-range volume relative to its previous 10 days
//   entry      the first break of the range high (long) or low (short)
//   stop       the opposite side of the range
//   exit       the stop, or the close of the bar 6.5 hours after the anchor
//   costs      taker both ways (ORB_SLIP_BPS adds stop-order overshoot)
//
// The logic lives in orb-core.mjs and is shared with orb-stocks.mjs.
//
// Result on 49 days (2026-07/09): no variant beat its controls, and the one
// that looked significant (00:00, 15m, t = -3.2) is what this harness
// produces from pure noise in a third of six-variant batches.
import fs from 'fs';
import ccxt from 'ccxt';
import {
  BAR, makeCosts, indexBars, runVariant, stats, fmt, nullDistribution,
} from './orb-core.mjs';

const CACHE = process.env.ORB_CACHE || './.orb-cache.json';
const DAYS = Number(process.env.ORB_DAYS || 60);
const cost = makeCosts({ takerBps: 8, slipBps: Number(process.env.ORB_SLIP_BPS || 0) });

const CANDIDATES = [
  'BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'DOT', 'LTC',
  'BNB', 'TRX', 'SUI', 'APT', 'ARB', 'OP', 'NEAR', 'TON', 'AAVE', 'UNI',
  'FIL', 'ATOM', 'INJ', 'ENA', 'WIF', 'TIA', 'SEI', 'CRV', 'ETC', 'BCH',
];

async function loadBars() {
  if (fs.existsSync(CACHE)) {
    const cached = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    if (cached.days === DAYS) return cached;
  }
  const okx = new ccxt.okx({ enableRateLimit: true, timeout: 25000, options: { defaultType: 'swap' } });
  const weex = new ccxt.weex({ enableRateLimit: true, timeout: 25000, options: { defaultType: 'swap' } });
  await okx.loadMarkets();
  await weex.loadMarkets();
  const symbols = CANDIDATES.map((b) => `${b}/USDT:USDT`)
    .filter((s) => okx.markets[s]?.swap && weex.markets[s]?.swap);
  const start = Date.now() - DAYS * 86400000;
  const bars = {};
  for (const symbol of symbols) {
    const rows = [];
    let since = start;
    for (let guard = 0; guard < 200; guard += 1) {
      const page = await okx.fetchOHLCV(symbol, '5m', since, 300);
      if (!page.length) break;
      for (const r of page) if (!rows.length || r[0] > rows[rows.length - 1][0]) rows.push(r);
      const next = page[page.length - 1][0] + BAR;
      if (next <= since || next > Date.now() - BAR) break;
      since = next;
    }
    while (rows.length && rows[rows.length - 1][0] + BAR > Date.now()) rows.pop();
    bars[symbol] = rows;
    process.stdout.write(`  ${symbol.split('/')[0]} ${rows.length} bars\n`);
  }
  const out = { days: DAYS, fetchedAt: Date.now(), bars };
  fs.writeFileSync(CACHE, JSON.stringify(out));
  return out;
}

const raw = await loadBars();
const bars = Object.fromEntries(Object.entries(raw.bars).filter(([, r]) => r.length > 1000));

const firstBar = Math.min(...Object.values(bars).map((r) => r[0][0]));
const today0 = Math.floor(Date.now() / 86400000) * 86400000;
const days = [];
for (let d = Math.ceil(firstBar / 86400000) * 86400000; d < today0; d += 86400000) days.push(d);

const ANCHORS = [13 * 60 + 30, 0];
const RANGES = [15, 30, 60];
const anchorFor = (anchorMin) => (day) => day + anchorMin * 60000;

console.log(`${Object.keys(bars).length} symbols · ${days.length - 10} trading days · ` +
  `taker ${cost.takerBps}bp/side · slippage ${cost.slipBps}bp per stop fill\n`);

if (process.env.ORB_SEEDS) {
  const nd = nullDistribution({
    bars, days, anchors: ANCHORS, ranges: RANGES, anchorFor, cost, seeds: Number(process.env.ORB_SEEDS),
  });
  console.log(`NULL — ${nd.seeds} random walks × ${nd.variantsPerBatch} variants`);
  console.log(`  mean ${(nd.mean * 10000).toFixed(1)}bp (costs alone would be about −${(cost.fee * 10000).toFixed(0)}bp plus slippage)`);
  console.log(`  |t|>2 ${nd.over2.toFixed(0)}% · |t|>2.5 ${nd.over25.toFixed(0)}% · |t|>3 ${nd.over3.toFixed(0)}%`);
  console.log(`  batches where some variant reaches |t|>3: ${nd.batchHits}/${nd.seeds}`);
  process.exit(0);
}

const idx = {};
for (const [s, rows] of Object.entries(bars)) idx[s] = indexBars(rows);
const data = { idx, days };
const halfDay = days[10 + Math.floor((days.length - 10) / 2)];

for (const a of ANCHORS) {
  for (const orMin of RANGES) {
    const af = anchorFor(a);
    const main = runVariant(data, af, orMin, 'in-play', 7, cost);
    console.log(`=== ${a ? '13:30' : '00:00'} UTC · ${orMin}m range`);
    console.log(`  in-play breakout   ${fmt(stats(main.trades, cost))}`);
    console.log(`    1st half         ${fmt(stats(main.trades.filter((t) => t.day < halfDay), cost))}`);
    console.log(`    2nd half         ${fmt(stats(main.trades.filter((t) => t.day >= halfDay), cost))}`);
    console.log(`  random symbol      ${fmt(stats(runVariant(data, af, orMin, 'random-symbol', 7, cost).trades, cost))}`);
    console.log(`  coin-flip dir      ${fmt(stats(runVariant(data, af, orMin, 'coin-flip', 7, cost).trades, cost))}`);
    console.log(`  drift (long)       ${fmt(stats(runVariant(data, af, orMin, 'drift', 7, cost).trades, cost))}`);
    const skips = Object.entries(main.skipped).map(([k, v]) => `${k} ${v}`).join(', ');
    console.log(`  skipped: ${skips || 'none'}\n`);
  }
}
console.log(`read at ${new Date().toISOString()}`);

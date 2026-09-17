// One stock perp a day, opening-range breakout at the New York open.
//
// This is the form of the strategy with an actual track record: US stocks,
// the cash open, the name that is unusually active today. The crypto version
// found nothing, but crypto has no opening bell. Stock perps do.
//
// The rules were fixed BEFORE any stock result was seen:
//
//   universe   the stock perps listed on both Bitget and Weex
//   data       Bitget 5m, US session only, about a year (fetched by
//              orb-stocks-fetch.mjs, anchored to 09:30 New York so daylight
//              saving is handled)
//   sessions   New York weekdays, minus the NYSE full-day holidays below —
//              the perps print flat bars on those days and nobody trades them
//   range      the first 5, 15 or 30 minutes after 09:30
//   selection  highest opening-range volume relative to its previous 10
//              sessions
//   entry      the first break of the range high (long) or low (short)
//   stop       the opposite side of the range
//   exit       the stop, or the 16:00 close
//   costs      Weex taker 8bp a side; a second run adds 4bp of stop-order
//              overshoot to every stop-type fill
//
// JUDGING — amended before any real stock result was looked at.
//
// The plan was to judge against the random-walk null's t-statistics. Run on
// these sessions, that null showed |t| > 2 in 62-91% of noise runs: with ~250
// trades a strategy with no edge loses its costs, reliably, and the t-test
// against zero detects the FEES, not luck. It was measuring the wrong thing.
// (The crypto comparison was apples to apples — same n, both against zero —
// and stands.)
//
// The replacement is stricter and uses the real bars, so volatility is real
// rather than a guessed synthetic level:
//
//   coin-flip   the same days and entries, direction drawn at random, 200 times
//   random pick the same days, a random candidate instead of the hottest, 200 times
//   bar         the real mean must beat at least 98% of BOTH sets, and still
//               be positive after 4bp slippage. Three variants, so 98% rather
//               than 95%.
import fs from 'fs';
import {
  makeCosts, indexBars, runVariant, stats, fmt, nullDistribution,
  candidatesFor, runOnCandidates,
} from './orb-core.mjs';
import nytime from './nytime.js';

const CACHE = process.env.ORB_STOCK_CACHE || './.orb-stocks-cache.json';

// NYSE full-day closures inside the fetched year. Half-days are not removed:
// their last three hours are flat bars, which cost a time exit nothing.
const HOLIDAYS = new Set([
  '2025-11-27', '2025-12-25', '2026-01-01', '2026-01-19', '2026-02-16',
  '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07',
]);

const RANGES = [5, 15, 30];

const cache = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
const bars = {};
for (const [s, v] of Object.entries(cache.bars)) if (v.rows?.length > 1000) bars[s] = v.rows;

// Sessions: every New York weekday that any symbol traded, minus holidays.
const daySet = new Set();
for (const rows of Object.values(bars)) {
  for (const [t] of rows) daySet.add(Math.floor(t / 86400000) * 86400000);
}
const days = [...daySet].sort((a, b) => a - b)
  .filter((d) => nytime.isNyWeekday(d))
  .filter((d) => !HOLIDAYS.has(new Date(d).toISOString().slice(0, 10)));

const anchorFor = () => (day) => nytime.nyOpenUtc(day);
const first = new Date(days[0]).toISOString().slice(0, 10);
const last = new Date(days[days.length - 1]).toISOString().slice(0, 10);
console.log(`${Object.keys(bars).length} stock perps · ${days.length} sessions (${first} → ${last}) · ` +
  `${days.length - 10} tradeable after the 10-session lookback\n`);

if (process.env.ORB_SEEDS) {
  const cost = makeCosts({ takerBps: 8, slipBps: Number(process.env.ORB_SLIP_BPS || 0) });
  const nd = nullDistribution({
    bars, days, anchors: [0], ranges: RANGES, anchorFor, cost,
    seeds: Number(process.env.ORB_SEEDS), barSdBps: 12,
  });
  console.log(`NULL — ${nd.seeds} random walks × ${nd.variantsPerBatch} variants, slippage ${cost.slipBps}bp`);
  console.log(`  mean ${(nd.mean * 10000).toFixed(1)}bp`);
  console.log(`  |t|>2 ${nd.over2.toFixed(0)}% · |t|>2.5 ${nd.over25.toFixed(0)}% · |t|>3 ${nd.over3.toFixed(0)}%`);
  console.log(`  batches where some variant reaches |t|>3: ${nd.batchHits}/${nd.seeds}`);
  process.exit(0);
}

const idx = {};
for (const [s, rows] of Object.entries(bars)) idx[s] = indexBars(rows);
const data = { idx, days };
const halfDay = days[10 + Math.floor((days.length - 10) / 2)];

const PERMS = Number(process.env.ORB_PERMS || 200);
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const bpf = (v) => `${(v * 10000).toFixed(1)}bp`;

console.log(`PERMUTATION TEST — ${PERMS} draws each, real bars, bar = beat 98% of both\n`);
const verdicts = [];
for (const orMin of RANGES) {
  const cands = candidatesFor(data, anchorFor(), orMin);
  for (const slipBps of [0, 4]) {
    const cost = makeCosts({ takerBps: 8, slipBps });
    const real = stats(runOnCandidates(data, cands, orMin, 'in-play', 7, cost).trades, cost);
    const flips = [], picks = [];
    for (let k = 0; k < PERMS; k += 1) {
      flips.push(stats(runOnCandidates(data, cands, orMin, 'coin-flip', 100 + k, cost).trades, cost).mean);
      picks.push(stats(runOnCandidates(data, cands, orMin, 'random-symbol', 100 + k, cost).trades, cost).mean);
    }
    const beatFlip = flips.filter((m) => real.mean > m).length / PERMS;
    const beatPick = picks.filter((m) => real.mean > m).length / PERMS;
    console.log(`${String(orMin).padStart(2)}m range · slip ${slipBps}bp · real ${bpf(real.mean).padStart(8)} (n=${real.n}, win ${(real.win * 100).toFixed(0)}%)`);
    console.log(`    coin-flip  5% ${bpf(pct(flips, 0.05)).padStart(8)}  50% ${bpf(pct(flips, 0.5)).padStart(8)}  95% ${bpf(pct(flips, 0.95)).padStart(8)}   real beats ${(beatFlip * 100).toFixed(1)}%`);
    console.log(`    random pk  5% ${bpf(pct(picks, 0.05)).padStart(8)}  50% ${bpf(pct(picks, 0.5)).padStart(8)}  95% ${bpf(pct(picks, 0.95)).padStart(8)}   real beats ${(beatPick * 100).toFixed(1)}%`);
    verdicts.push({ orMin, slipBps, real: real.mean, beatFlip, beatPick });
  }
}
console.log('');
for (const orMin of RANGES) {
  const a = verdicts.find((v) => v.orMin === orMin && v.slipBps === 0);
  const b = verdicts.find((v) => v.orMin === orMin && v.slipBps === 4);
  const pass = a.beatFlip >= 0.98 && a.beatPick >= 0.98 && b.beatFlip >= 0.98 && b.beatPick >= 0.98 && b.real > 0;
  console.log(`${String(orMin).padStart(2)}m range: ${pass ? 'PASSES' : 'does not pass'} the pre-set bar`);
}
console.log('');

for (const slipBps of [0, 4]) {
  const cost = makeCosts({ takerBps: 8, slipBps });
  console.log(`################ taker 8bp/side · slippage ${slipBps}bp per stop fill ################`);
  for (const orMin of RANGES) {
    const af = anchorFor();
    const main = runVariant(data, af, orMin, 'in-play', 7, cost);
    console.log(`=== 09:30 New York · ${orMin}m range`);
    console.log(`  in-play breakout   ${fmt(stats(main.trades, cost))}`);
    console.log(`    1st half         ${fmt(stats(main.trades.filter((t) => t.day < halfDay), cost))}`);
    console.log(`    2nd half         ${fmt(stats(main.trades.filter((t) => t.day >= halfDay), cost))}`);
    console.log(`  random symbol      ${fmt(stats(runVariant(data, af, orMin, 'random-symbol', 7, cost).trades, cost))}`);
    console.log(`  coin-flip dir      ${fmt(stats(runVariant(data, af, orMin, 'coin-flip', 7, cost).trades, cost))}`);
    console.log(`  drift (long)       ${fmt(stats(runVariant(data, af, orMin, 'drift', 7, cost).trades, cost))}`);
    const skips = Object.entries(main.skipped).map(([k, v]) => `${k} ${v}`).join(', ');
    console.log(`  skipped: ${skips || 'none'}`);
    if (slipBps === 0) {
      const picks = {};
      for (const t of main.trades) picks[t.symbol.split('/')[0]] = (picks[t.symbol.split('/')[0]] || 0) + 1;
      const top = Object.entries(picks).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${v}`).join(', ');
      console.log(`  most picked: ${top}`);
    }
    console.log('');
  }
}
console.log(`read at ${new Date().toISOString()}`);

// The stock opening-range breakout with the top 3 or 4 symbols a day.
//
// The one-pick version (orb-stocks.mjs) is the only one the backtest year
// actually examined. Trading the next few most unusual names as well is a
// different strategy, and this tests it before the live paper test is
// switched over.
//
// Fixed before running:
//   rule       exactly the 15-minute rule from orb-stocks.mjs
//   picks      the top 3, and separately the top 4, by relative volume; each
//              a separate trade of equal size
//   controls   the same number of RANDOM symbols a day, and the same picks
//              with RANDOM directions — equal trade counts on equal days
//   bar        beat 98% of both over 200 draws, and positive after 4bp
//              slippage — unchanged from the one-pick test
//   also       results by rank, to see whether picks 2-4 add or dilute. That
//              breakdown is descriptive; it does not choose anything.
//
// Same-day trades are not independent — a market-wide move hits all of them —
// so N trades a day is worth less than N days. The permutation controls are
// built the same way, which is what keeps the comparison fair despite that.
import fs from 'fs';
import { makeCosts, indexBars, candidatesFor, runOnCandidates, stats, fmt } from './orb-core.mjs';
import nytime from './nytime.js';

const CACHE = process.env.ORB_STOCK_CACHE || './.orb-stocks-cache.json';
const PERMS = Number(process.env.ORB_PERMS || 200);
const OR_MIN = 15;

const cache = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
const idx = {};
const daySet = new Set();
for (const [s, v] of Object.entries(cache.bars)) {
  if (!(v.rows?.length > 1000)) continue;
  idx[s] = indexBars(v.rows);
  for (const [t] of v.rows) daySet.add(Math.floor(t / 86400000) * 86400000);
}
const days = [...daySet].sort((a, b) => a - b).filter((d) => nytime.isNyseSession(d));
const data = { idx, days };
const cands = candidatesFor(data, (d) => nytime.nyOpenUtc(d), OR_MIN);
const halfDay = days[10 + Math.floor((days.length - 10) / 2)];

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const bpf = (v) => `${(v * 10000).toFixed(1)}bp`;

console.log(`${Object.keys(idx).length} stock perps · ${days.length - 10} tradeable sessions · 15m range · ${PERMS} draws\n`);

const verdicts = [];
for (const topN of [1, 3, 4]) {
  console.log(`=================== top ${topN} a day ===================`);
  for (const slipBps of [0, 4]) {
    const cost = makeCosts({ takerBps: 8, slipBps });
    const run = runOnCandidates(data, cands, OR_MIN, 'in-play', 7, cost, topN);
    const real = stats(run.trades, cost);
    const flips = [], picks = [];
    for (let k = 0; k < PERMS; k += 1) {
      flips.push(stats(runOnCandidates(data, cands, OR_MIN, 'coin-flip', 100 + k, cost, topN).trades, cost).mean);
      picks.push(stats(runOnCandidates(data, cands, OR_MIN, 'random-symbol', 100 + k, cost, topN).trades, cost).mean);
    }
    const beatFlip = flips.filter((m) => real.mean > m).length / PERMS;
    const beatPick = picks.filter((m) => real.mean > m).length / PERMS;
    console.log(`slip ${slipBps}bp   ${fmt(real)}`);
    console.log(`         beats coin-flip ${(beatFlip * 100).toFixed(1)}% (95th ${bpf(pct(flips, 0.95))})   ` +
      `beats random symbols ${(beatPick * 100).toFixed(1)}% (95th ${bpf(pct(picks, 0.95))})`);
    if (slipBps === 4) {
      console.log(`         1st half ${fmt(stats(run.trades.filter((t) => t.day < halfDay), cost))}`);
      console.log(`         2nd half ${fmt(stats(run.trades.filter((t) => t.day >= halfDay), cost))}`);
      const sorted = [...run.trades].sort((a, b) => b.net - a.net);
      const drop = (k) => bpf(sorted.slice(k).reduce((s, t) => s + t.net, 0) / (sorted.length - k));
      console.log(`         without best 5: ${drop(5)} · best 10: ${drop(10)} · best 20: ${drop(20)}`);
      if (topN > 1) {
        for (let r = 1; r <= topN; r += 1) {
          console.log(`         rank ${r}: ${fmt(stats(run.trades.filter((t) => t.rank === r), cost))}`);
        }
      }
    }
    verdicts.push({ topN, slipBps, real: real.mean, beatFlip, beatPick });
  }
  console.log('');
}

for (const topN of [1, 3, 4]) {
  const a = verdicts.find((v) => v.topN === topN && v.slipBps === 0);
  const b = verdicts.find((v) => v.topN === topN && v.slipBps === 4);
  const pass = [a.beatFlip, a.beatPick, b.beatFlip, b.beatPick].every((x) => x >= 0.98) && b.real > 0;
  console.log(`top ${topN}: ${pass ? 'PASSES' : 'does not pass'} the pre-set bar`);
}
console.log(`\nread at ${new Date().toISOString()}`);

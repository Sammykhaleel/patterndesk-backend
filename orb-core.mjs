// Opening-range breakout, shared by the crypto and stock backtests.
//
// One implementation, so the stock test cannot quietly differ from the crypto
// one in the places that decide the answer: where the entry fills, where the
// stop sits, what happens when a bar touches both, and what a control is
// compared against.
//
// Fills. A breakout entry and a stop exit are stop orders: they trigger at a
// level and fill at the first trade through it, which is beyond the level. The
// first version filled exactly AT the level, and on a random walk that made
// the breakout lose 8.7bp a trade instead of the 16bp of fees it should — a
// 7bp flattery on every trade. `slipBps` charges that overshoot against the
// trade on each stop-type fill. Time exits fill at the bar close and pay only
// the fee.

export const BAR = 5 * 60000;
export const HOLD = 6.5 * 3600000;

export function makeCosts({ takerBps = 8, slipBps = 0 } = {}) {
  return { fee: (2 * takerBps) / 10000, slip: slipBps / 10000, takerBps, slipBps };
}

export function indexBars(rows) {
  const m = new Map();
  for (const [t, o, h, l, c, v] of rows) m.set(t, { t, o, h, l, c, v });
  return m;
}

/** The opening range for one symbol on one day, or null if any bar is missing. */
export function openingRange(idx, anchor, orMin) {
  const n = orMin / 5;
  let hi = -Infinity, lo = Infinity, vol = 0, open = NaN, close = NaN;
  for (let k = 0; k < n; k += 1) {
    const b = idx.get(anchor + k * BAR);
    if (!b) return null;
    if (k === 0) open = b.o;
    close = b.c;
    hi = Math.max(hi, b.h);
    lo = Math.min(lo, b.l);
    vol += b.v * b.c;             // quote volume, so symbols compare
  }
  return { hi, lo, vol, open, close };
}

function finish(entry, exit, dir, riskFrac, t, how, cost) {
  const gross = (dir * (exit - entry)) / entry;
  const net = gross - cost.fee;
  return { entry, exit, dir, gross, net, r: net / riskFrac, riskFrac, how, t };
}

/**
 * Trade the first breakout after the range, until the stop or the exit time.
 *
 * `forceDir` replaces the breakout's own direction for the coin-flip control;
 * the entry happens on the same bar, so only the direction differs.
 */
export function tradeBreakout(idx, anchor, orMin, range, forceDir, cost) {
  const from = anchor + orMin * 60000;
  const until = anchor + HOLD;
  for (let t = from; t < until; t += BAR) {
    const b = idx.get(t);
    if (!b) continue;
    const upBreak = b.h > range.hi;
    const dnBreak = b.l < range.lo;
    if (!upBreak && !dnBreak) continue;

    // Both sides broken in one bar: the order is unknowable, so skip the day
    // rather than pick the flattering one.
    if (upBreak && dnBreak) return { skipped: 'both sides in one bar' };

    const natural = upBreak ? 1 : -1;
    const dir = forceDir !== undefined ? forceDir : natural;
    const level = upBreak ? range.hi : range.lo;
    // A gap through the level fills at the open, not at the level; then the
    // stop-order overshoot, against whichever way this trade is facing.
    const base = upBreak ? Math.max(level, b.o) : Math.min(level, b.o);
    const entry = base * (1 + dir * cost.slip);

    // The rule's stop is the far side of the range. A coin-flip entry AGAINST
    // the break would put that stop at the entry itself, so it sits one
    // range-width away instead — the same distance the rule risks.
    const width = range.hi - range.lo;
    const stop = dir === natural ? (dir === 1 ? range.lo : range.hi) : base - dir * width;
    const riskFrac = Math.abs(entry - stop) / entry;
    if (!(riskFrac > 0)) return { skipped: 'zero-width range' };

    const stopFill = (x) => (dir === 1 ? Math.min(stop, x) : Math.max(stop, x)) * (1 - dir * cost.slip);

    // The entry bar itself reaching the stop counts against us.
    const stoppedNow = dir === 1 ? b.l <= stop : b.h >= stop;
    if (stoppedNow) return finish(entry, stopFill(stop), dir, riskFrac, t, 'stop (entry bar)', cost);

    for (let u = t + BAR; u < until; u += BAR) {
      const x = idx.get(u);
      if (!x) continue;
      if (dir === 1 && x.l <= stop) return finish(entry, stopFill(x.o), dir, riskFrac, u, 'stop', cost);
      if (dir === -1 && x.h >= stop) return finish(entry, stopFill(x.o), dir, riskFrac, u, 'stop', cost);
    }
    let last = null;
    for (let u = until - BAR; u > t; u -= BAR) { last = idx.get(u); if (last) break; }
    if (!last) return { skipped: 'no exit bar' };
    return finish(entry, last.c, dir, riskFrac, last.t, 'time', cost);
  }
  return { skipped: 'no breakout' };
}

export function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Run one variant across every session.
 *
 * `data.days` is the ordered list of sessions and `anchorFor(day)` gives the
 * UTC instant each one opens — a fixed hour for crypto, 09:30 New York for
 * stocks. Relative volume compares today's range with the previous
 * `lookback` SESSIONS, not calendar days, so a weekend is not counted as a
 * missing day.
 */
/**
 * Every symbol's opening range and relative volume, for every session.
 *
 * Seed-independent, so a permutation test can compute it once and then draw
 * hundreds of random directions or random picks from it cheaply.
 */
export function candidatesFor(data, anchorFor, orMin, lookback = 10) {
  const symbols = Object.keys(data.idx);
  const out = [];
  for (let i = lookback; i < data.days.length; i += 1) {
    const day = data.days[i];
    const anchor = anchorFor(day);
    const scored = [];
    for (const s of symbols) {
      const today = openingRange(data.idx[s], anchor, orMin);
      if (!today) continue;
      let sum = 0, n = 0;
      for (let d = 1; d <= lookback; d += 1) {
        const past = openingRange(data.idx[s], anchorFor(data.days[i - d]), orMin);
        if (past) { sum += past.vol; n += 1; }
      }
      if (n < lookback / 2 || !(sum > 0)) continue;
      scored.push({ s, today, relVol: today.vol / (sum / n) });
    }
    out.push({ day, anchor, scored });
  }
  return out;
}

export const hottest = (scored) => scored.reduce((a, b) => (b.relVol > a.relVol ? b : a));

export function runVariant(data, anchorFor, orMin, mode, seed, cost, lookback = 10) {
  return runOnCandidates(data, candidatesFor(data, anchorFor, orMin, lookback), orMin, mode, seed, cost);
}

export function runOnCandidates(data, candidates, orMin, mode, seed, cost) {
  const rand = mulberry32(seed);
  const trades = [];
  const skipped = {};

  for (const { day, anchor, scored } of candidates) {
    if (!scored.length) { skipped['no candidates'] = (skipped['no candidates'] || 0) + 1; continue; }

    const pick = mode === 'random-symbol'
      ? scored[Math.floor(rand() * scored.length)]
      : hottest(scored);

    const idx = data.idx[pick.s];
    let res;
    if (mode === 'coin-flip') {
      res = tradeBreakout(idx, anchor, orMin, pick.today, rand() < 0.5 ? 1 : -1, cost);
    } else if (mode === 'drift') {
      const from = idx.get(anchor + orMin * 60000);
      let last = null;
      for (let u = anchor + HOLD - BAR; u > anchor; u -= BAR) { last = idx.get(u); if (last) break; }
      res = from && last ? { net: (last.c - from.o) / from.o - cost.fee, r: NaN } : { skipped: 'no bars' };
    } else {
      res = tradeBreakout(idx, anchor, orMin, pick.today, undefined, cost);
    }

    if (res.skipped) { skipped[res.skipped] = (skipped[res.skipped] || 0) + 1; continue; }
    trades.push({ day, symbol: pick.s, relVol: pick.relVol, ...res });
  }
  return { trades, skipped };
}

export function stats(trades, cost) {
  const xs = trades.map((t) => t.net);
  const n = xs.length;
  if (!n) return { n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const sorted = [...xs].sort((a, b) => a - b);
  const med = n % 2 ? sorted[n >> 1] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const rs = trades.map((t) => t.r).filter(Number.isFinite);
  const feeR = trades.map((t) => cost.fee / t.riskFrac).filter(Number.isFinite);
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  return {
    n, mean, med, sd, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : NaN,
    win: xs.filter((x) => x > 0).length / n,
    meanR: avg(rs), feeR: avg(feeR),
  };
}

export const bp = (v) => (Number.isFinite(v) ? `${(v * 10000).toFixed(1)}bp` : '—');

export function fmt(s) {
  if (!s.n) return 'n=0';
  return `n=${String(s.n).padStart(3)}  mean ${bp(s.mean).padStart(8)}  med ${bp(s.med).padStart(8)}  ` +
    `win ${(s.win * 100).toFixed(0).padStart(3)}%  t ${s.t.toFixed(2).padStart(5)}  ` +
    `R ${Number.isFinite(s.meanR) ? s.meanR.toFixed(2).padStart(5) : '    —'}  ` +
    `fees ${Number.isFinite(s.feeR) ? s.feeR.toFixed(2) : '—'}R`;
}

/**
 * A market with no structure, on the real timestamps.
 *
 * No rule has an edge here, so every variant should lose roughly its costs.
 * A harness that shows an edge on this is reading the future; one that loses
 * much more than its costs is biased against the rule. Volume is random too,
 * so "in play" selection is a random pick.
 */
export function synthesise(bars, seed, barSdBps = 15) {
  const rand = mulberry32(seed);
  const gauss = () => {
    let u = 0, v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const SUB = 5;
  const subSd = barSdBps / 10000 / Math.sqrt(SUB);
  const out = {};
  for (const [s, rows] of Object.entries(bars)) {
    let px = 100;
    out[s] = rows.map(([t]) => {
      const o = px;
      let h = px, l = px;
      for (let k = 0; k < SUB; k += 1) {
        px *= Math.exp(gauss() * subSd);
        h = Math.max(h, px); l = Math.min(l, px);
      }
      return [t, o, h, l, px, Math.exp(gauss())];
    });
  }
  return out;
}

/**
 * How big a t-statistic this harness produces from pure noise.
 *
 * Six variants sharing sessions, symbols and a direction sequence are not six
 * independent tries, and a skewed payoff — many small stops, a few large time
 * exits — makes the t-statistic fat-tailed at these sample sizes. The textbook
 * 2.0 is the wrong bar; this measures the right one.
 */
export function nullDistribution({ bars, days, anchors, ranges, anchorFor, cost, seeds = 30, barSdBps }) {
  const inPlayT = [], inPlayMean = [];
  let batchHits = 0;
  for (let k = 0; k < seeds; k += 1) {
    const syn = synthesise(bars, 1000 + k, barSdBps);
    const idx = {};
    for (const [s, rows] of Object.entries(syn)) if (rows.length) idx[s] = indexBars(rows);
    const ts = [];
    for (const a of anchors) {
      for (const orMin of ranges) {
        const st = stats(runVariant({ idx, days }, anchorFor(a), orMin, 'in-play', 50 + k, cost).trades, cost);
        inPlayT.push(st.t); inPlayMean.push(st.mean); ts.push(st.t);
      }
    }
    if (ts.some((t) => Math.abs(t) > 3)) batchHits += 1;
  }
  const share = (f) => (inPlayT.filter(f).length / inPlayT.length) * 100;
  return {
    runs: inPlayT.length, seeds,
    mean: inPlayMean.reduce((a, b) => a + b, 0) / inPlayMean.length,
    over2: share((t) => Math.abs(t) > 2),
    over25: share((t) => Math.abs(t) > 2.5),
    over3: share((t) => Math.abs(t) > 3),
    batchHits,
    variantsPerBatch: anchors.length * ranges.length,
  };
}

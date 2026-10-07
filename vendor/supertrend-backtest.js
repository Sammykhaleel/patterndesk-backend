import { supertrend } from './indicators.js';

// The parameter grid the sweep searches. These live here, beside the only code
// that reads them — they were left behind in main.js during the module split,
// which made every sweep throw at runtime.
export const ST_PERIODS = [7,10,14,20];
export const ST_MULTS = [1.5,2,2.5,3,3.5,4];

// Backtests the Supertrend as an actual strategy, not just a signal counter:
// enter on each flip, exit when it flips back, always in the market. That's
// how the indicator is normally traded, so it's the honest thing to measure.
//
// Deliberately reports drawdown and buy-and-hold alongside return, because a
// strategy that made money while underperforming simply holding the asset
// hasn't earned its complexity — and one with a brutal drawdown isn't
// tradeable regardless of its final number.
//
// `partial` (optional) models taking part of the position off at a profit
// target and letting the rest run to the flip:
//   { kind: "pct", value: 2 }  target 2% from the entry
//   { kind: "st",  value: 1 }  target 1x the distance from the entry to the
//                              Supertrend line at entry — scales with each
//                              symbol's volatility, so one setting suits
//                              KAT and META alike
//   frac      share closed at the target (default 0.5)
//   makerPct  cost of that close (default 0.02%: it is a resting limit order)
// The target is checked on each bar's high (long) or low (short) from the bar
// after entry up to and including the flip bar, and fills AT the target —
// never better, even when a bar opens beyond it. A bar that reached the target
// and then closed through the line counts as a fill: a resting limit order
// would have filled on the way. Exchange minimum order sizes are not modelled.
//
// `fromT` (optional) counts only trades entered at or after that time, and
// measures buy-and-hold from there. The line is still computed over all the
// candles, so it is settled when the window opens. See recentResult.
function backtestSupertrend(candles, period, mult, costPct=0.05, partial=null, fromT=null){
  const st = supertrend(candles, period, mult);
  const trades = [];
  let open = null;
  const frac = partial ? (partial.frac ?? 0.5) : 0;
  const makerPct = partial ? (partial.makerPct ?? 0.02) : 0;
  for(let i=1;i<candles.length;i++){
    const cur=st[i], prev=st[i-1];
    if(!cur || !prev) continue;
    // The target, checked before the flip on this bar: see above.
    if(open && open.target!=null && !open.hit){
      const k = candles[i];
      if(open.dir===1 ? k.h >= open.target : k.l <= open.target) open.hit = true;
    }
    if(cur.dir !== prev.dir){
      const price = candles[i].c;
      if(open){
        const move = (exit) => open.dir===1 ? (exit-open.price)/open.price : (open.price-exit)/open.price;
        let pct;
        if(open.hit){
          pct = (frac*move(open.target) + (1-frac)*move(price))*100
              - costPct - frac*makerPct - (1-frac)*costPct;
        } else {
          pct = move(price)*100 - costPct*2; // cost charged both sides
        }
        if(fromT == null || candles[open.i].t >= fromT)
          trades.push({dir:open.dir, entry:open.price, exit:price, pct, bars: i-open.i, hit: !!open.hit});
      }
      open = {dir:cur.dir, price, i, target: partialTarget(partial, cur.dir, price, cur.v), hit:false};
    }
  }
  if(!trades.length) return null;

  // equity curve, compounded, for max drawdown
  let eq=1, peak=1, maxDD=0;
  for(const t of trades){
    eq *= (1 + t.pct/100);
    if(eq>peak) peak=eq;
    const dd=(peak-eq)/peak;
    if(dd>maxDD) maxDD=dd;
  }
  const wins = trades.filter(t=>t.pct>0);
  const losses = trades.filter(t=>t.pct<=0);
  const grossWin = wins.reduce((s,t)=>s+t.pct,0);
  const grossLoss = Math.abs(losses.reduce((s,t)=>s+t.pct,0));
  const first = candles.find(k=>k && k.c>0 && (fromT == null || k.t >= fromT)), last = candles[candles.length-1];
  const buyHold = first ? (last.c-first.c)/first.c*100 : null;

  return {
    n: trades.length,
    // Only when a partial close was modelled, so results without one stay
    // byte-identical to what they always were.
    ...(partial ? { hits: trades.filter(t=>t.hit).length } : {}),
    winRate: wins.length/trades.length*100,
    totalPct: (eq-1)*100,
    avgWin: wins.length ? grossWin/wins.length : 0,
    avgLoss: losses.length ? grossLoss/losses.length : 0,
    profitFactor: grossLoss>0 ? grossWin/grossLoss : null,
    maxDD: maxDD*100,
    avgBars: trades.reduce((s,t)=>s+t.bars,0)/trades.length,
    buyHold,
    longs: trades.filter(t=>t.dir===1).length,
    shorts: trades.filter(t=>t.dir===-1).length,
  };
}

/** The price a partial close rests at, or null when there is none. */
function partialTarget(partial, dir, price, line){
  if(!partial) return null;
  let dist;
  if(partial.kind === "pct") dist = price * partial.value / 100;
  else if(partial.kind === "st") dist = Math.abs(price - line) * partial.value;
  else return null;
  if(!(dist > 0)) return null;
  return dir===1 ? price + dist : price - dist;
}

// The targets compared. Fixed percentages are what people reach for; the
// Supertrend-distance ones adapt to the symbol, which a single percentage
// cannot — 2% is noise on KAT and a long way on META.
export const PARTIAL_VARIANTS = [
  { key:"pct1", label:"+1%",       kind:"pct", value:1 },
  { key:"pct2", label:"+2%",       kind:"pct", value:2 },
  { key:"pct3", label:"+3%",       kind:"pct", value:3 },
  { key:"st1",  label:"1× ST gap", kind:"st",  value:1 },
  { key:"st2",  label:"2× ST gap", kind:"st",  value:2 },
];

/**
 * One setting, with and without a partial close at each target.
 *
 * Returns { base, rows: [{...variant, ...result}] } — rows in the order
 * above, each the same flips as the base with only the exits changed, so the
 * difference is the partial close and nothing else.
 */
function comparePartials(candles, period, mult, { frac=0.5, costPct=0.05, variants=PARTIAL_VARIANTS } = {}){
  const base = backtestSupertrend(candles, period, mult, costPct);
  if(!base) return null;
  const rows = variants.map(v => ({ ...v, frac, ...backtestSupertrend(candles, period, mult, costPct, { ...v, frac }) }));
  return { base, rows, frac };
}

function sweepSupertrend(candles, costPct=0.05){
  const grid = new Map(); // "period|mult" -> result, for neighbour lookups
  const out=[];
  for(const period of ST_PERIODS){
    for(const mult of ST_MULTS){
      const r = backtestSupertrend(candles, period, mult, costPct);
      if(r) grid.set(period+"|"+mult, r);
      if(r && r.n>=5) out.push({period, mult, ...r});
    }
  }
  // Neighbour stability is the strongest guard against curve-fitting: a
  // genuinely good setting has decent neighbours, because the underlying
  // behaviour is smooth. A lone spike surrounded by poor results won on
  // noise and won't survive out of sample.
  for(const r of out){
    const pi = ST_PERIODS.indexOf(r.period), mi = ST_MULTS.indexOf(r.mult);
    const neigh = [];
    for(const [dp,dm] of [[-1,0],[1,0],[0,-1],[0,1]]){
      const np = ST_PERIODS[pi+dp], nm = ST_MULTS[mi+dm];
      if(np===undefined || nm===undefined) continue;
      const g = grid.get(np+"|"+nm);
      if(g) neigh.push(g.totalPct);
    }
    r.neighborCount = neigh.length;
    r.neighborsPositive = neigh.filter(v=>v>0).length;
    r.neighborAvg = neigh.length ? neigh.reduce((a,b)=>a+b,0)/neigh.length : null;

    // Composite score. Deliberately does NOT weight raw return heavily —
    // return is what overfits most easily, while profit factor, sample size
    // and neighbour agreement are what tend to persist.
    let score = 0;
    if(r.profitFactor!=null) score += Math.min(r.profitFactor, 3) * 20;   // up to 60
    score += Math.min(r.n, 30) / 30 * 20;                                  // up to 20, sample size
    if(neigh.length) score += (r.neighborsPositive/neigh.length) * 20;     // up to 20, stability
    score -= Math.min(r.maxDD, 60) / 60 * 15;                              // up to -15, drawdown
    if(r.totalPct <= 0) score -= 25;
    if(r.n < 10) score -= 12;                                              // small sample penalty
    // Beyond ~30 trades the extra sample adds little, while every additional
    // flip is another spread paid and another chance for real fills to differ
    // from the backtest. Frequent-flipping settings look better on paper than
    // they trade, so charge for the excess.
    if(r.n > 30) score -= Math.min((r.n-30)/10, 3) * 4;                    // up to -12
    r.score = score;

    const reasons = [];
    if(r.n < 10) reasons.push(`only ${r.n} trades — small sample, treat cautiously`);
    else if(r.n >= 25) reasons.push(`${r.n} trades is a reasonable sample`);
    if(r.profitFactor!=null && r.profitFactor >= 1.5) reasons.push(`profit factor ${r.profitFactor.toFixed(2)} is solid`);
    else if(r.profitFactor!=null && r.profitFactor < 1.2) reasons.push(`profit factor ${r.profitFactor.toFixed(2)} is thin`);
    if(neigh.length && r.neighborsPositive === neigh.length) reasons.push("neighbouring settings also profit — stable, not a fluke");
    else if(neigh.length && r.neighborsPositive === 0) reasons.push("neighbouring settings all lose — likely curve-fitted");
    if(r.maxDD > 30) reasons.push(`${r.maxDD.toFixed(0)}% drawdown is punishing to sit through`);
    if(r.n > 40) reasons.push("flips very often — most exposed to real-world slippage");
    r.reasons = reasons;
  }
  out.sort((a,b)=>b.score-a.score);
  if(out.length) out[0].isPick = true;
  return out;
}

/**
 * One setting over the last `days` only.
 *
 * Every timeframe's history reaches back a different distance (4,000 bars is
 * 83 days of 30m and 5 months of 4h), so whole-history returns and their
 * buy-and-hold are not comparable across rows: SNDK's 4h looked like it only
 * rode a +60% trend, yet over the same weeks as the 30m, when holding lost
 * 22%, it made +56%. This is the like-for-like figure. Null when the history
 * does not reach back that far, or nothing traded in it.
 */
export const RECENT_DAYS = 60;
function recentResult(candles, period, mult, { days = RECENT_DAYS, costPct = 0.05 } = {}){
  if(!candles || candles.length < 2) return null;
  const fromT = candles[candles.length-1].t - days*86400000;
  if(!(candles[0].t <= fromT)) return null;
  const r = backtestSupertrend(candles, period, mult, costPct, null, fromT);
  return r ? { days, totalPct: r.totalPct, n: r.n, buyHold: r.buyHold, profitFactor: r.profitFactor, maxDD: r.maxDD } : null;
}

export { backtestSupertrend, sweepSupertrend, comparePartials, recentResult };

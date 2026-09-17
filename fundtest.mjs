// Is there an edge in funding rather than in price?
//
// Funding is the first candidate tonight that is not another line drawn on
// price. It is a function of positioning: when longs are crowded they pay
// shorts, every eight hours, whether or not price moves. Part of it is a
// payment rather than a forecast, which is what makes it worth testing.
//
// The scale problem is visible before the first backtest and shapes the whole
// design: on SOL the mean funding is 0.26bp per 8h period while price moves
// roughly 50bp over the same period. Carry is under one percent of the noise
// it is swimming in. So a funding-directed position is overwhelmingly a price
// bet with a rounding error attached, and any result will be dominated by
// which way price went — which is exactly why the control matters more here
// than anywhere else.
//
// Three things are measured separately so they cannot be confused:
//   - CARRY ALONE: the funding you would have collected, no price exposure.
//     Unreachable without a hedge, but it bounds how big the prize can be.
//   - THE FULL STRATEGY: funding-directed positions, price and fees included.
//   - BUY AND HOLD: the control that showed every rule last night was worse
//     than doing nothing.
import ccxt from 'ccxt';

const MAKER_BPS = 2;
const FEE = (2 * MAKER_BPS) / 10000;        // a round trip, charged on changes only
const PERIODS_BACK = 200;                   // ~66 days at 8h

const ex = new ccxt.weex({ enableRateLimit: true, timeout: 25000, options: { defaultType: 'swap' } });
await ex.loadMarkets();

const tickers = await ex.fetchTickers(undefined, { type: 'swap' });
const universe = Object.values(tickers)
  .filter((t) => ex.markets[t.symbol]?.swap && ex.markets[t.symbol]?.linear)
  .filter((t) => Number(t.quoteVolume) > 20_000_000)
  .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
  .slice(0, 40).map((t) => t.symbol);

const series = [];
const queue = [...universe];
async function worker() {
  for (;;) {
    const symbol = queue.shift(); if (!symbol) return;
    try {
      const h = await ex.fetchFundingRateHistory(symbol, undefined, PERIODS_BACK);
      // The mark price rides along on each funding row, so price and funding
      // share a timestamp exactly — no interpolation, no alignment error.
      const rows = h
        .map((r) => ({ t: r.timestamp, rate: Number(r.fundingRate), px: Number(r.info?.markPrice) }))
        .filter((r) => Number.isFinite(r.rate) && Number.isFinite(r.px) && r.px > 0)
        .sort((a, b) => a.t - b.t);
      if (rows.length >= 120) series.push({ symbol, rows });
    } catch { /* not served */ }
  }
}
await Promise.all([worker(), worker(), worker()]);
console.log(`${series.length} symbols · ${PERIODS_BACK} funding periods (8h) · maker ${MAKER_BPS}bp/side\n`);

/**
 * Walk the funding periods holding whatever `decide(rate)` asks for.
 *
 * Funding sign convention: a POSITIVE rate means longs pay shorts. So a short
 * earns +rate and a long pays it. Getting this backwards would invert every
 * conclusion, so it is stated once here and used everywhere.
 *
 * Fees are charged only when the position CHANGES. A carry position that sits
 * still for twenty periods pays one round trip, not twenty, and charging it
 * every period would bury a real result under costs that were never incurred.
 */
function walk(rows, decide) {
  let side = 0, equity = 1, changes = 0, carry = 0, priceOnly = 1;
  for (let i = 1; i < rows.length; i += 1) {
    const want = decide(rows[i - 1].rate, rows[i - 1]);
    if (want !== side) { equity *= 1 - FEE; changes += 1; side = want; }
    if (side === 0) continue;
    const move = (rows[i].px - rows[i - 1].px) / rows[i - 1].px;
    const fund = -side * rows[i - 1].rate;          // short (+1 earns) when rate > 0
    carry += fund;
    equity *= 1 + side * move + fund;
    priceOnly *= 1 + side * move;
  }
  return { ret: equity - 1, carry, priceRet: priceOnly - 1, changes };
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const med = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const winPct = (a) => (a.filter((v) => v > 0).length / a.length) * 100;
const p = (v) => `${(v * 100).toFixed(2)}%`;

// How big could the prize be, if price exposure were somehow removed?
const pureCarry = series.map(({ rows }) => {
  let c = 0;
  for (let i = 1; i < rows.length; i += 1) c += Math.abs(rows[i - 1].rate);
  return c;
});
const signedCarry = series.map(({ rows }) => {
  let c = 0;
  for (let i = 1; i < rows.length; i += 1) c += rows[i - 1].rate;   // always short
  return c;
});
console.log(`CARRY CEILING over ~66 days, before any price exposure or fees`);
console.log(`  always short, collecting funding : mean ${p(mean(signedCarry))}  median ${p(med(signedCarry))}`);
console.log(`  perfect side every period        : mean ${p(mean(pureCarry))}  median ${p(med(pureCarry))}`);

const strategies = {
  'short when rate > 0': (r) => (r > 0 ? -1 : 1),
  'short only if rate > 0.5bp': (r) => (r > 0.00005 ? -1 : 0),
  'fade extreme funding': (r) => (r > 0.00005 ? -1 : r < -0.00005 ? 1 : 0),
  'always short': () => -1,
  'always long': () => 1,
};

console.log(`\nFULL STRATEGY — price, funding and fees together`);
console.log('strategy                      mean     median   win%   avg carry  avg flips');
for (const [name, fn] of Object.entries(strategies)) {
  const out = series.map(({ rows }) => walk(rows, fn));
  console.log(`${name.padEnd(28)}${p(mean(out.map((o) => o.ret))).padStart(8)} ` +
    `${p(med(out.map((o) => o.ret))).padStart(8)} ${winPct(out.map((o) => o.ret)).toFixed(0).padStart(5)}% ` +
    `${p(mean(out.map((o) => o.carry))).padStart(10)} ${mean(out.map((o) => o.changes)).toFixed(0).padStart(9)}`);
}

const hold = series.map(({ rows }) => (rows[rows.length - 1].px - rows[0].px) / rows[0].px);
console.log(`${'BUY & HOLD'.padEnd(28)}${p(mean(hold)).padStart(8)} ${p(med(hold)).padStart(8)} ` +
  `${winPct(hold).toFixed(0).padStart(5)}%`);

// Does funding predict the NEXT period's move, or only pay for the current one?
let n = 0, sxy = 0, sx = 0, sy = 0, sxx = 0, syy = 0;
for (const { rows } of series) {
  for (let i = 1; i < rows.length; i += 1) {
    const x = rows[i - 1].rate;
    const y = (rows[i].px - rows[i - 1].px) / rows[i - 1].px;
    n += 1; sx += x; sy += y; sxy += x * y; sxx += x * x; syy += y * y;
  }
}
const corr = (n * sxy - sx * sy) / Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
console.log(`\nfunding now vs price move next period: r = ${corr.toFixed(4)} over ${n} observations`);
console.log(`(positive would mean high funding precedes a RISE — crowding that keeps working)`);
console.log(`\nread at ${new Date().toISOString()}`);

// Would supertrend have paid its own costs on Weex, at intraday holding times?
//
// This is the question that has to be answered before anything auto-trades.
// The intraday ranker says which symbols move enough to cover a round trip; it
// says nothing about direction. Supertrend is the direction rule this account
// already trusts — but it is trusted on Bybit 1h bars, and neither the venue
// nor the timeframe carries over for free.
//
// Every trade here pays the real cost both ways. A backtest that nets fees out
// is the same flattery as a P&L panel that quotes gross, and this account has
// already been shown one of those today.
import ccxt from 'ccxt';
import { supertrend } from './vendor/indicators.js';

const SYMBOLS = ['ADA/USDT:USDT', 'XRP/USDT:USDT', 'DOGE/USDT:USDT', 'MSTR/USDT:USDT'];
const TFS = ['15m', '1h'];
const PERIOD = 10;
const MULT = 3;

// Measured on the venue, not assumed: maker 2bp a side, taker 8bp a side.
const MAKER_BPS = 2;
const TAKER_BPS = 8;

const pct = (v) => `${(v * 100).toFixed(2)}%`;

/**
 * Walk the bars, flipping with the indicator, always in the market.
 *
 * Entry and exit are taken at the CLOSE of the bar that flipped — the same bar
 * the live scanner would act on, and the earliest price it could actually get.
 * Using the next bar's open would be more conservative still; using the flip
 * bar's low or high would be fantasy.
 */
function runBacktest(candles, costBpsPerSide) {
  const st = supertrend(candles, PERIOD, MULT);
  const trades = [];
  let side = 0;
  let entry = 0;

  for (let i = 1; i < candles.length; i += 1) {
    const now = st[i];
    const prev = st[i - 1];
    if (!now || !prev) continue;
    if (now.dir === prev.dir) continue;          // no flip on this bar

    const price = candles[i].c;
    if (side !== 0) {
      const gross = side === 1 ? (price - entry) / entry : (entry - price) / entry;
      trades.push(gross);
    }
    side = now.dir;
    entry = price;
  }

  // Costs: every completed trade paid to get in and to get out.
  const cost = (2 * costBpsPerSide) / 10000;
  const nets = trades.map((g) => g - cost);

  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  for (const n of nets) {
    equity *= 1 + n;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, (peak - equity) / peak);
  }

  const wins = nets.filter((n) => n > 0);
  return {
    trades: nets.length,
    grossSum: trades.reduce((a, b) => a + b, 0),
    netSum: nets.reduce((a, b) => a + b, 0),
    compounded: equity - 1,
    winRate: nets.length ? wins.length / nets.length : NaN,
    avg: nets.length ? nets.reduce((a, b) => a + b, 0) / nets.length : NaN,
    maxDd,
    feeDrag: cost * nets.length,
  };
}

const ex = new ccxt.weex({ enableRateLimit: true, timeout: 25000 });
await ex.loadMarkets();

for (const tf of TFS) {
  console.log(`\n================ ${tf} · supertrend(${PERIOD}, ${MULT}) ================`);
  console.log('symbol  bars  days   trades  win%    gross     fees      NET(maker)  NET(taker)  maxDD');
  for (const symbol of SYMBOLS) {
    let ohlcv;
    try {
      ohlcv = await ex.fetchOHLCV(symbol, tf, undefined, 1000);
    } catch (err) {
      console.log(`${symbol.split('/')[0].padEnd(6)}  failed: ${err.message.slice(0, 50)}`);
      continue;
    }
    // Drop the forming bar, same rule as everywhere else.
    const rows = ohlcv.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
    const tfMs = ex.parseTimeframe(tf) * 1000;
    const candles = rows.length && rows[rows.length - 1].t + tfMs > Date.now() ? rows.slice(0, -1) : rows;

    const mk = runBacktest(candles, MAKER_BPS);
    const tk = runBacktest(candles, TAKER_BPS);
    const days = (candles.length * tfMs) / 86400000;

    console.log(
      `${symbol.split('/')[0].padEnd(6)} ${String(candles.length).padStart(5)} ` +
      `${days.toFixed(1).padStart(5)} ${String(mk.trades).padStart(7)} ` +
      `${(mk.winRate * 100).toFixed(0).padStart(5)}% ${pct(mk.grossSum).padStart(9)} ` +
      `${pct(mk.feeDrag).padStart(8)} ${pct(mk.compounded).padStart(11)} ` +
      `${pct(tk.compounded).padStart(11)} ${pct(mk.maxDd).padStart(7)}`
    );
  }
}
console.log(`\nfees: maker ${MAKER_BPS}bp/side, taker ${TAKER_BPS}bp/side — charged on every entry and exit.`);
console.log(`read at ${new Date().toISOString()}`);

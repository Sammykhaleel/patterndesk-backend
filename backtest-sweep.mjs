// Does supertrend have ANY edge on these Weex symbols, or was one setting
// simply unlucky?
//
// A sweep is dangerous evidence and is run here for the opposite of the usual
// reason. The temptation is to find the best cell and trade it; that cell is
// the one most shaped by noise, and picking it is how a backtest becomes a
// story. What a sweep answers honestly is a coarser question: is the surface
// mostly profitable, or mostly not? If nearly every setting loses, one winner
// is chance. If most win, a single loser was unlucky.
import ccxt from 'ccxt';
import { supertrend } from './vendor/indicators.js';

const SYMBOLS = ['ADA/USDT:USDT', 'XRP/USDT:USDT', 'DOGE/USDT:USDT', 'MSTR/USDT:USDT'];
const TFS = ['15m', '1h'];
const PERIODS = [7, 10, 14, 20];
const MULTS = [2, 2.5, 3, 4];
const MAKER_BPS = 2;

function net(candles, period, mult, costBps) {
  const st = supertrend(candles, period, mult);
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

const ex = new ccxt.weex({ enableRateLimit: true, timeout: 25000 });
await ex.loadMarkets();

let totalCells = 0, totalWins = 0;
for (const tf of TFS) {
  const tfMs = ex.parseTimeframe(tf) * 1000;
  console.log(`\n=========== ${tf} · net after maker fees, ${MAKER_BPS}bp/side ===========`);
  for (const symbol of SYMBOLS) {
    const raw = await ex.fetchOHLCV(symbol, tf, undefined, 1000);
    const rows = raw.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
    const candles = rows.length && rows[rows.length - 1].t + tfMs > Date.now() ? rows.slice(0, -1) : rows;

    const cells = [];
    let wins = 0;
    for (const p of PERIODS) {
      for (const m of MULTS) {
        const r = net(candles, p, m, MAKER_BPS);
        cells.push({ p, m, ...r });
        if (r.ret > 0) wins += 1;
      }
    }
    totalCells += cells.length;
    totalWins += wins;
    cells.sort((a, b) => b.ret - a.ret);
    const best = cells[0], worst = cells[cells.length - 1];
    const median = cells[Math.floor(cells.length / 2)];
    console.log(
      `${symbol.split('/')[0].padEnd(6)} profitable ${String(wins).padStart(2)}/${cells.length}   ` +
      `best ${(best.ret * 100).toFixed(1).padStart(7)}% (p${best.p} m${best.m}, ${best.trades}t)   ` +
      `median ${(median.ret * 100).toFixed(1).padStart(7)}%   ` +
      `worst ${(worst.ret * 100).toFixed(1).padStart(7)}%`
    );
  }
}
console.log(`\nOVERALL: ${totalWins} of ${totalCells} settings profitable ` +
            `(${((totalWins / totalCells) * 100).toFixed(0)}%). Coin-flip would be ~50%.`);
console.log(`read at ${new Date().toISOString()}`);

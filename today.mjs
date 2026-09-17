// What is actually on the table right now: which symbols clear their costs,
// which way each is currently pointing, and what a sane position size would be.
//
// The direction column is INFORMATION, not a recommendation. Supertrend was
// tested on this venue last night across two timeframes, 128 parameter cells,
// a trendiness filter and five reversion variants, and beat neither costs nor
// doing nothing. It is shown because it is the rule this account already reads,
// and because a direction you can see and disagree with is more useful than one
// hidden inside a script.
import ccxt from 'ccxt';
import { supertrend } from './vendor/indicators.js';
import { scoreSymbol } from './scalp.js';

const TF = process.argv[2] || '15m';
const EQUITY = Number(process.argv[3]) || 17.99;
const RISK_PCT = 0.03;            // fraction of equity risked if the stop is hit

const SYMBOLS = [
  'XRP/USDT:USDT', 'ADA/USDT:USDT', 'DOGE/USDT:USDT', 'SOL/USDT:USDT',
  'ETH/USDT:USDT', 'BTC/USDT:USDT', 'LINK/USDT:USDT', 'LTC/USDT:USDT',
  'AVAX/USDT:USDT', 'BNB/USDT:USDT', 'DOT/USDT:USDT', 'MSTR/USDT:USDT',
];

const ex = new ccxt.weex({ enableRateLimit: true, timeout: 25000, options: { defaultType: 'swap' } });
await ex.loadMarkets();
const tfMs = ex.parseTimeframe(TF) * 1000;
const now = Date.now();

console.log(`\n${TF} · equity $${EQUITY.toFixed(2)} · risking ${(RISK_PCT * 100).toFixed(0)}% ($${(EQUITY * RISK_PCT).toFixed(2)}) per trade`);
console.log('symbol   maker  clears?  supertrend  bars   stop%   size$   minOrder  note');

const rows = [];
for (const symbol of SYMBOLS) {
  const m = ex.markets[symbol];
  if (!m) continue;
  try {
    const raw = await ex.fetchOHLCV(symbol, TF, undefined, 200);
    const book = await ex.fetchOrderBook(symbol, 50);
    const all = raw.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
    const c = all.length && all[all.length - 1].t + tfMs > now ? all.slice(0, -1) : all;

    const score = scoreSymbol({
      symbol, candles: c, book, orderUsd: 50, now,
      takerBps: (m.taker ?? 0.0008) * 10000, makerBps: (m.maker ?? 0.0002) * 10000,
    });

    const st = supertrend(c, 10, 3);
    const last = st[st.length - 1];
    const dir = last ? last.dir : 0;
    // How long it has pointed this way — a flip one bar ago is a different
    // proposition from one that has held for forty.
    let held = 0;
    for (let i = st.length - 1; i > 0; i -= 1) {
      if (!st[i] || !st[i - 1] || st[i].dir !== st[i - 1].dir) break;
      held += 1;
    }

    const price = c[c.length - 1].c;
    const band = last ? last.v : NaN;
    const stopPct = Number.isFinite(band) ? Math.abs(price - band) / price : NaN;
    // Size so that being stopped costs RISK_PCT of equity, not more.
    const sizeUsd = Number.isFinite(stopPct) && stopPct > 0 ? (EQUITY * RISK_PCT) / stopPct : NaN;
    const minAmt = m.limits?.amount?.min;
    const minOrder = Number.isFinite(minAmt) ? minAmt * price : NaN;

    const note = [];
    if (!score.tradeable) note.push(score.reasons.join('; '));
    if (Number.isFinite(sizeUsd) && Number.isFinite(minOrder) && sizeUsd < minOrder) {
      note.push(`min order $${minOrder.toFixed(2)} > sane size`);
    }

    rows.push({ symbol, score, dir, held, stopPct, sizeUsd, minOrder, note: note.join(' · ') });
  } catch (err) {
    rows.push({ symbol, err: err.message.slice(0, 40) });
  }
}

rows.sort((a, b) => (b.score?.makerRatio || -1) - (a.score?.makerRatio || -1));
for (const r of rows) {
  if (r.err) { console.log(`${r.symbol.split('/')[0].padEnd(8)} failed: ${r.err}`); continue; }
  const s = r.score;
  console.log(
    `${r.symbol.split('/')[0].padEnd(8)} ${s.makerRatio.toFixed(2).padStart(5)} ` +
    `${(s.tradeable ? '  yes  ' : '  NO   ')} ` +
    `${(r.dir === 1 ? 'LONG ' : r.dir === -1 ? 'SHORT' : '  ?  ')} ` +
    `${String(r.held).padStart(5)}  ${(r.stopPct * 100).toFixed(2).padStart(6)}% ` +
    `${r.sizeUsd.toFixed(0).padStart(7)} ${r.minOrder.toFixed(2).padStart(9)}   ${r.note}`
  );
}
console.log(`\nstop% is the distance to the supertrend band — where the rule would exit.`);
console.log(`size$ is the notional that makes that stop cost ${(RISK_PCT * 100).toFixed(0)}% of equity.`);
console.log(`bars = how long the direction has held. read at ${new Date().toISOString()}`);

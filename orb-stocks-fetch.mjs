// Fetch a year of US-session 5m bars for the stock perps, from Bitget.
//
// Weex will not page history back, OKX lists these names only as dated
// futures, and Bitget has a year of 5m history on the perps themselves. One
// request per symbol per session, anchored to 09:30 New York time — not to a
// fixed UTC hour, because the open is 13:30 UTC in summer and 14:30 UTC in
// winter, and a year of data crosses both changes.
//
// Progress is written after every symbol so an interrupted run resumes.
import fs from 'fs';
import ccxt from 'ccxt';
import { nyOpenUtc, isNyWeekday } from './nytime.js';

const CACHE = process.env.ORB_STOCK_CACHE || './.orb-stocks-cache.json';
const DAYS = Number(process.env.ORB_DAYS || 365);
const BAR = 5 * 60000;
const SESSION_BARS = 78;                       // 09:30-16:00

const BASES = [
  'MSTR', 'NVDA', 'TSLA', 'AAPL', 'COIN', 'HOOD', 'AMD', 'META', 'GOOGL',
  'AMZN', 'MSFT', 'SPY', 'QQQ', 'CRCL', 'GME', 'PLTR', 'NFLX', 'AVGO',
  'BABA', 'INTC', 'MARA', 'RIOT', 'TSM',
];

const bitget = new ccxt.bitget({ enableRateLimit: true, timeout: 25000, options: { defaultType: 'swap' } });
const weex = new ccxt.weex({ enableRateLimit: true, timeout: 25000, options: { defaultType: 'swap' } });
await bitget.loadMarkets();
await weex.loadMarkets();

const symbols = BASES.map((b) => `${b}/USDT:USDT`).filter((s) => bitget.markets[s]?.swap && weex.markets[s]?.swap);
console.log(`symbols on both venues: ${symbols.map((s) => s.split('/')[0]).join(' ')}`);

const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : { bars: {} };
const today0 = Math.floor(Date.now() / 86400000) * 86400000;
const days = [];
for (let d = today0 - DAYS * 86400000; d < today0; d += 86400000) if (isNyWeekday(d)) days.push(d);

let requests = 0;
for (const symbol of symbols) {
  if (cache.bars[symbol]?.done) { console.log(`  ${symbol.split('/')[0]} cached`); continue; }
  const rows = [];
  for (const day of days) {
    const open = nyOpenUtc(day);
    let page;
    try {
      page = await bitget.fetchOHLCV(symbol, '5m', open, SESSION_BARS + 2);
      requests += 1;
    } catch (err) {
      // A day the venue will not serve is a missing day, not a reason to stop.
      continue;
    }
    for (const r of page) if (r[0] >= open && r[0] < open + SESSION_BARS * BAR) rows.push(r);
  }
  rows.sort((a, b) => a[0] - b[0]);
  cache.bars[symbol] = { done: true, rows };
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  console.log(`  ${symbol.split('/')[0]} ${rows.length} session bars (${requests} requests so far)`);
}
console.log(`done: ${Object.keys(cache.bars).length} symbols, ${days.length} weekdays`);

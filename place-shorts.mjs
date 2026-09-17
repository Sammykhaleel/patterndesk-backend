// Place the four shorts the user chose, as resting limit orders with stops.
//
// Maker on purpose: this venue charges 8bp to cross and 2bp to rest, and the
// whole intraday analysis says crossing eats the move. A short rests by selling
// AT the best ask — joining that queue rather than hitting the bid — so the
// order may sit unfilled if price walks away. That is the correct trade-off
// here and an unfilled order is reported as such, never quietly re-sent as a
// market order.
//
// Every entry carries its stop at creation. An entry that fills while its stop
// is still being placed is a naked leveraged position for as long as that gap
// lasts, and this account cannot afford that gap.
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import ccxt from 'ccxt';

// Resolve .env against THIS file, not the shell's working directory, so the
// script runs correctly from anywhere.
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '.env'), quiet: true });
import { supertrend } from './vendor/indicators.js';

const PLAN = [
  { symbol: 'XRP/USDT:USDT', notional: 46 },
  { symbol: 'DOGE/USDT:USDT', notional: 54 },
  { symbol: 'SOL/USDT:USDT', notional: 46 },
  { symbol: 'BNB/USDT:USDT', notional: 66 },
];
const SIDE = 'sell';          // short
const TF = '15m';
const LIVE = process.argv.includes('--live');

const ex = new ccxt.weex({
  apiKey: process.env.WEEX_API_KEY,
  secret: process.env.WEEX_API_SECRET,
  password: process.env.WEEX_API_PASSWORD,
  enableRateLimit: true, timeout: 25000,
  options: { defaultType: 'swap' },
});
await ex.loadMarkets();

const before = await ex.fetchBalance({ type: 'swap' });
console.log(`equity before: ${Number(before.total?.USDT || 0).toFixed(4)} USDT ` +
            `(free ${Number(before.free?.USDT || 0).toFixed(4)})`);
console.log(LIVE ? '\n*** LIVE — orders will be sent ***\n' : '\n--- dry run, nothing sent (pass --live) ---\n');

const results = [];
for (const { symbol, notional } of PLAN) {
  const m = ex.markets[symbol];
  try {
    const book = await ex.fetchOrderBook(symbol, 10);
    const bestAsk = book.asks?.[0]?.[0];
    const bestBid = book.bids?.[0]?.[0];
    if (!bestAsk || !bestBid) throw new Error('no book');

    // Rest at the ask: a sell there joins the queue instead of crossing to the bid.
    const price = Number(ex.priceToPrecision(symbol, bestAsk));

    const raw = await ex.fetchOHLCV(symbol, TF, undefined, 200);
    const all = raw.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
    const tfMs = ex.parseTimeframe(TF) * 1000;
    const c = all.length && all[all.length - 1].t + tfMs > Date.now() ? all.slice(0, -1) : all;
    const st = supertrend(c, 10, 3);
    const last = st[st.length - 1];
    if (!last || last.dir !== -1) throw new Error(`supertrend is no longer short (dir ${last?.dir})`);

    // The stop sits at the band, above a short. Rounded to the venue's tick.
    const stopPrice = Number(ex.priceToPrecision(symbol, last.v));
    if (!(stopPrice > price)) throw new Error(`stop ${stopPrice} is not above entry ${price}`);

    const amount = Number(ex.amountToPrecision(symbol, notional / price));
    const minAmt = m.limits?.amount?.min;
    if (Number.isFinite(minAmt) && amount < minAmt) {
      throw new Error(`size ${amount} below venue minimum ${minAmt}`);
    }

    const riskUsd = amount * (stopPrice - price);
    console.log(`${symbol.split('/')[0].padEnd(5)} SELL ${String(amount).padStart(10)} @ ${price}  ` +
      `stop ${stopPrice} (${(((stopPrice - price) / price) * 100).toFixed(2)}%)  ` +
      `notional $${(amount * price).toFixed(2)}  risk $${riskUsd.toFixed(2)}`);

    if (!LIVE) { results.push({ symbol, planned: true }); continue; }

    const order = await ex.createOrder(symbol, 'limit', SIDE, amount, price, {
      stopLoss: { triggerPrice: stopPrice },
    });
    console.log(`      -> id ${order.id}  status ${order.status}  filled ${order.filled ?? 0}`);
    results.push({ symbol, id: order.id, status: order.status, filled: order.filled });
  } catch (err) {
    console.log(`${symbol.split('/')[0].padEnd(5)} SKIPPED — ${err.message.slice(0, 120)}`);
    results.push({ symbol, error: err.message });
  }
}

if (LIVE) {
  const after = await ex.fetchBalance({ type: 'swap' });
  console.log(`\nequity after: ${Number(after.total?.USDT || 0).toFixed(4)} USDT ` +
              `(free ${Number(after.free?.USDT || 0).toFixed(4)})`);
  const open = await ex.fetchOpenOrders();
  console.log(`resting orders: ${open.length}`);
  for (const o of open) {
    console.log(`  ${o.symbol.split('/')[0]} ${o.side} ${o.amount} @ ${o.price} — ${o.status}`);
  }
  const pos = (await ex.fetchPositions()).filter((p) => Number(p.contracts) > 0);
  console.log(`open positions: ${pos.length}`);
  for (const p of pos) {
    console.log(`  ${p.symbol.split('/')[0]} ${p.side} notional ${Number(p.notional || 0).toFixed(2)} ` +
                `entry ${p.entryPrice} uPnL ${Number(p.unrealizedPnl || 0).toFixed(4)}`);
  }
}
console.log(`\n${new Date().toISOString()}`);

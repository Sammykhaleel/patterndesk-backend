// Place four longs as resting limit orders with stops, on the futures account.
//
// Maker on purpose: 8bp to cross, 2bp to rest. A long rests by BUYING at the
// best bid — joining that queue rather than lifting the ask — so it may sit
// unfilled if price walks away. That is the right trade-off and an unfilled
// order is reported as unfilled, never quietly re-sent as a market order.
//
// Two guards, both of which have already earned their place tonight:
//
//   1. The signal is re-read at the moment of sending. Thirty-six minutes
//      passed between the board and execution last time, and all four symbols
//      had reversed. An approval is for a setup, not for a symbol.
//   2. The stop is attached at creation. An entry that fills while its stop is
//      still being placed is a naked leveraged position for the length of that
//      gap, and this account cannot carry that.
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import ccxt from 'ccxt';

// Resolve .env against THIS file, not the shell's working directory, so the
// script runs correctly from anywhere.
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '.env'), quiet: true });
import { supertrend } from './vendor/indicators.js';

const PLAN = [
  { symbol: 'DOT/USDT:USDT', notional: 31 },
  { symbol: 'ADA/USDT:USDT', notional: 31 },
  { symbol: 'AVAX/USDT:USDT', notional: 44 },
  { symbol: 'DOGE/USDT:USDT', notional: 46 },
];
const WANT_DIR = 1;                       // long
const SIDE = 'buy';
const TF = '15m';
const LEVERAGE = Number(process.env.LEVERAGE) || 25;
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
console.log(`futures wallet before: ${Number(before.total?.USDT || 0).toFixed(4)} USDT ` +
            `(free ${Number(before.free?.USDT || 0).toFixed(4)})`);
console.log(LIVE ? `\n*** LIVE — orders will be sent, leverage ${LEVERAGE}x ***\n`
                 : `\n--- dry run, nothing sent (pass --live) ---\n`);

let plannedNotional = 0;
let plannedRisk = 0;

for (const { symbol, notional } of PLAN) {
  const m = ex.markets[symbol];
  try {
    if (!m?.swap || !m?.linear) throw new Error('not a linear perp');

    const book = await ex.fetchOrderBook(symbol, 10);
    const bestBid = book.bids?.[0]?.[0];
    if (!bestBid) throw new Error('no book');
    // Rest at the bid: a buy there joins the queue instead of lifting the ask.
    const price = Number(ex.priceToPrecision(symbol, bestBid));

    const raw = await ex.fetchOHLCV(symbol, TF, undefined, 200);
    const all = raw.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
    const tfMs = ex.parseTimeframe(TF) * 1000;
    const c = all.length && all[all.length - 1].t + tfMs > Date.now() ? all.slice(0, -1) : all;
    const st = supertrend(c, 10, 3);
    const last = st[st.length - 1];
    if (!last || last.dir !== WANT_DIR) {
      throw new Error(`supertrend is no longer long (dir ${last?.dir}) — setup gone`);
    }

    const stopPrice = Number(ex.priceToPrecision(symbol, last.v));
    if (!(stopPrice < price)) throw new Error(`stop ${stopPrice} is not below entry ${price}`);

    const amount = Number(ex.amountToPrecision(symbol, notional / price));
    const minAmt = m.limits?.amount?.min;
    if (Number.isFinite(minAmt) && amount < minAmt) {
      throw new Error(`size ${amount} below venue minimum ${minAmt}`);
    }

    const realNotional = amount * price;
    const riskUsd = amount * (price - stopPrice);
    plannedNotional += realNotional;
    plannedRisk += riskUsd;

    console.log(`${symbol.split('/')[0].padEnd(5)} BUY ${String(amount).padStart(10)} @ ${price}  ` +
      `stop ${stopPrice} (${(((price - stopPrice) / price) * 100).toFixed(2)}%)  ` +
      `notional $${realNotional.toFixed(2)}  risk $${riskUsd.toFixed(2)}`);

    if (!LIVE) continue;

    try {
      await ex.setLeverage(LEVERAGE, symbol);
    } catch (e) {
      console.log(`      leverage: could not set (${e.message.slice(0, 60)}) — using account default`);
    }

    const order = await ex.createOrder(symbol, 'limit', SIDE, amount, price, {
      stopLoss: { triggerPrice: stopPrice },
    });
    console.log(`      -> id ${order.id}  status ${order.status}  filled ${order.filled ?? 0}`);
  } catch (err) {
    console.log(`${symbol.split('/')[0].padEnd(5)} SKIPPED — ${err.message.slice(0, 120)}`);
  }
}

const equity = Number(before.total?.USDT || 0);
console.log(`\nplanned: $${plannedNotional.toFixed(2)} notional on $${equity.toFixed(2)} equity ` +
  `(${(plannedNotional / equity).toFixed(1)}x) · margin at ${LEVERAGE}x ≈ $${(plannedNotional / LEVERAGE).toFixed(2)}`);
console.log(`total risk if every stop is hit: $${plannedRisk.toFixed(2)} ` +
  `(${((plannedRisk / equity) * 100).toFixed(1)}% of equity) — these are four correlated longs, so treat that as one loss, not four`);

if (LIVE) {
  const after = await ex.fetchBalance({ type: 'swap' });
  console.log(`\nfutures wallet after: ${Number(after.total?.USDT || 0).toFixed(4)} USDT ` +
              `(free ${Number(after.free?.USDT || 0).toFixed(4)})`);
  const open = await ex.fetchOpenOrders();
  console.log(`resting orders: ${open.length}`);
  for (const o of open) console.log(`   ${o.symbol.split('/')[0]} ${o.side} ${o.amount} @ ${o.price} — ${o.status}`);
  const pos = (await ex.fetchPositions()).filter((p) => Number(p.contracts) > 0);
  console.log(`open positions: ${pos.length}`);
  for (const p of pos) {
    console.log(`   ${p.symbol.split('/')[0]} ${p.side} notional ${Number(p.notional || 0).toFixed(2)} ` +
      `entry ${p.entryPrice} liq ${p.liquidationPrice ?? 'n/a'} uPnL ${Number(p.unrealizedPnl || 0).toFixed(4)}`);
  }
}
console.log(`\n${new Date().toISOString()}`);

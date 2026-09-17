// Place entries on Weex, either direction, through the tested planner.
//
//   node trade.mjs short XRP SOL BNB            # dry run
//   node trade.mjs short XRP SOL BNB --live     # send
//   node trade.mjs long DOT ADA --risk 0.03 --live
//
// Everything that decides anything lives in entry.js and is covered by
// entry-test.js: which side of the book to rest on, which side the stop goes,
// how size is computed, and every reason to refuse. This file is the I/O
// around it — fetch, print, send, report — so that the parts which can lose
// money are the parts under test.
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import ccxt from 'ccxt';
import { supertrend } from './vendor/indicators.js';

const HERE = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(HERE, '.env'), quiet: true });

const { planEntry, sizeForRisk, entryParams, LONG, SHORT } = await import('./entry.js')
  .then((m) => m.default || m);

const argv = process.argv.slice(2);
const LIVE = argv.includes('--live');
const dirWord = (argv[0] || '').toLowerCase();
if (dirWord !== 'long' && dirWord !== 'short') {
  console.log('usage: node trade.mjs <long|short> SYM [SYM...] [--risk 0.03] [--tf 15m] [--live]');
  process.exit(1);
}
const DIR = dirWord === 'long' ? LONG : SHORT;
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const RISK = Number(flag('risk', '0.03'));
const TF = flag('tf', '15m');
const LEVERAGE = Number(process.env.LEVERAGE) || 25;
const bases = argv.slice(1).filter((a) => !a.startsWith('--') && a !== flag('risk', '') && a !== flag('tf', ''));

const ex = new ccxt.weex({
  apiKey: process.env.WEEX_API_KEY,
  secret: process.env.WEEX_API_SECRET,
  password: process.env.WEEX_API_PASSWORD,
  enableRateLimit: true, timeout: 25000,
  options: { defaultType: 'swap' },
});
await ex.loadMarkets();

const balance = await ex.fetchBalance({ type: 'swap' });
const equity = Number(balance.total?.USDT || 0);
const free = Number(balance.free?.USDT || 0);
console.log(`futures wallet: ${equity.toFixed(4)} USDT (free ${free.toFixed(4)}) · ${dirWord.toUpperCase()} · ` +
            `risk ${(RISK * 100).toFixed(1)}%/trade · ${TF}`);
console.log(LIVE ? `\n*** LIVE — orders will be sent at ${LEVERAGE}x ***\n`
                 : `\n--- dry run, nothing sent (add --live) ---\n`);

const existing = (await ex.fetchPositions()).filter((p) => Number(p.contracts) > 0);
const held = new Map(existing.map((p) => [p.symbol, p]));

let totalNotional = 0;
let totalRisk = 0;

for (const base of bases) {
  const symbol = `${base.toUpperCase()}/USDT:USDT`;
  try {
    const market = ex.markets[symbol];
    if (!market) throw new Error('not listed on this venue');

    // An opposing position already open is a close, not an entry, and this
    // tool does not close things.
    const open = held.get(symbol);
    if (open) {
      const openDir = open.side === 'long' ? LONG : SHORT;
      if (openDir !== DIR) throw new Error(`already ${open.side} — this would close or hedge, not open`);
      throw new Error(`already ${open.side} on this symbol`);
    }

    const book = await ex.fetchOrderBook(symbol, 20);
    const raw = await ex.fetchOHLCV(symbol, TF, undefined, 200);
    const all = raw.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
    const tfMs = ex.parseTimeframe(TF) * 1000;
    const candles = all.length && all[all.length - 1].t + tfMs > Date.now() ? all.slice(0, -1) : all;

    const st = supertrend(candles, 10, 3);
    const last = st[st.length - 1];
    const signalDir = last ? last.dir : 0;
    const stopPrice = last ? last.v : NaN;

    const refPrice = DIR === LONG ? book.bids?.[0]?.[0] : book.asks?.[0]?.[0];
    const notional = sizeForRisk({ equityUsd: equity, riskFraction: RISK, price: refPrice, stopPrice });
    if (!Number.isFinite(notional)) {
      throw new Error('stop is too close to price to size against (inside the noise)');
    }

    const plan = planEntry({ exchange: ex, symbol, dir: DIR, notionalUsd: notional, book, signalDir, stopPrice, market });

    if (!plan.ok) {
      console.log(`${base.toUpperCase().padEnd(5)} SKIPPED — ${plan.reasons.join('; ')}`);
      continue;
    }

    totalNotional += plan.notional;
    totalRisk += plan.riskUsd;
    console.log(`${base.toUpperCase().padEnd(5)} ${plan.side.toUpperCase().padEnd(4)} ${String(plan.amount).padStart(10)} @ ${plan.price}  ` +
      `stop ${plan.stopPrice} (${(Math.abs(plan.price - plan.stopPrice) / plan.price * 100).toFixed(2)}%)  ` +
      `notional $${plan.notional.toFixed(2)}  risk $${plan.riskUsd.toFixed(2)}`);

    if (!LIVE) continue;

    try { await ex.setLeverage(LEVERAGE, symbol); }
    catch (e) { console.log(`      leverage: ${e.message.slice(0, 60)} — using account default`); }

    const order = await ex.createOrder(symbol, 'limit', plan.side, plan.amount, plan.price, entryParams(plan));
    console.log(`      -> id ${order.id}`);
  } catch (err) {
    console.log(`${base.toUpperCase().padEnd(5)} SKIPPED — ${err.message.slice(0, 110)}`);
  }
}

if (totalNotional > 0) {
  console.log(`\nplanned $${totalNotional.toFixed(2)} notional (${(totalNotional / equity).toFixed(1)}x equity) · ` +
    `margin at ${LEVERAGE}x ≈ $${(totalNotional / LEVERAGE).toFixed(2)}`);
  console.log(`risk if every stop hits: $${totalRisk.toFixed(2)} (${(totalRisk / equity * 100).toFixed(1)}% of equity) — ` +
    `correlated symbols stop together, so treat it as one loss`);
} else {
  console.log('\nnothing placeable.');
}

if (LIVE) {
  const after = await ex.fetchBalance({ type: 'swap' });
  console.log(`\nwallet after: ${Number(after.total?.USDT || 0).toFixed(4)} USDT (free ${Number(after.free?.USDT || 0).toFixed(4)})`);
  const pos = (await ex.fetchPositions()).filter((p) => Number(p.contracts) > 0);
  console.log(`positions: ${pos.length}`);
  for (const p of pos) {
    console.log(`   ${p.symbol.split('/')[0].padEnd(5)} ${String(p.side).padEnd(5)} notional ${Number(p.notional || 0).toFixed(2)} ` +
      `entry ${p.entryPrice} liq ${p.liquidationPrice ?? 'n/a'} uPnL ${Number(p.unrealizedPnl || 0).toFixed(4)}`);
  }
  // Stops are trigger orders on this venue and do NOT appear in a plain
  // fetchOpenOrders — the earlier script reported "resting orders: 0" and
  // looked, wrongly, as though nothing was protecting the positions.
  const stops = await ex.fetchOpenOrders(undefined, undefined, undefined, { trigger: true });
  console.log(`stops in place: ${stops.length}`);
  for (const o of stops) {
    console.log(`   ${o.symbol.split('/')[0].padEnd(5)} ${o.side} ${o.amount} trigger ${o.triggerPrice ?? o.stopPrice}`);
  }
}
console.log(`\n${new Date().toISOString()}`);

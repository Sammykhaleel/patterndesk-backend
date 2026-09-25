'use strict';

/**
 * Entering with a resting limit order (maker) instead of a market order
 * (taker), with a market fallback so a signal is never missed.
 *
 * Why: fees took about a third of a month's profit, and every entry paid the
 * taker rate (Bybit 0.055%) and crossed the spread. A post-only limit at the
 * best price on our side of the book pays the maker rate (0.02%) and crosses
 * nothing.
 *
 * The trade-off, stated so it is not rediscovered: a resting order fills most
 * readily when price comes back to it, which is more often the weaker entries.
 * The ones that run straight away miss it and fall back to market — so the
 * saving lands on some entries and not the best ones. The fallback is what
 * keeps that a fee question and not a missed-trade question.
 *
 * Entries only. Closes, reversals' closing legs and anything reduceOnly stay
 * market: the exit is the one order that must not sit unfilled.
 *
 * How much filled is read two ways after each attempt — the change in the
 * position, and the order's own filled amount — and the LARGER is believed.
 * Either can lag; under-reading a fill would send a market order for size
 * already bought and double the position, whereas over-reading it only leaves
 * the position a little small. When unsure, buy less.
 */

const DEFAULTS = {
  attempts: 3,           // limit orders tried before falling back
  waitMs: 10_000,        // how long each rests before it is cancelled
  maxDriftPercent: 0.1,  // stop re-pricing once price has moved this far from the first try
};

const sleepFor = (ms) => new Promise((r) => setTimeout(r, ms));

/** Contracts held on `side` for `symbol`, or null when it cannot be read. */
async function heldContracts(exchange, symbol, side) {
  try {
    const positions = await exchange.fetchPositions([symbol]);
    const want = side === 'buy' ? 'long' : 'short';
    const p = (positions || []).find((x) => x && x.symbol === symbol && x.side === want);
    const n = p ? Math.abs(Number(p.contracts) || 0) : 0;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** What an order reports as filled, or 0 when it cannot be read. */
async function orderFilled(exchange, id, symbol) {
  if (!id || typeof exchange.fetchOrder !== 'function') return 0;
  try {
    const o = await exchange.fetchOrder(id, symbol, { acknowledged: true });
    const f = Number(o && o.filled);
    return Number.isFinite(f) ? f : 0;
  } catch {
    return 0;
  }
}

/**
 * Buys or sells `amount` contracts, resting as maker first.
 *
 * @returns {{ order, makerFilled, takerAmount, attempts, fellBack, prices }}
 */
async function placeMakerEntry({
  exchange, symbol, side, amount, params = {}, minAmount = 0,
  logger = console, requestId = 'maker', sleep = sleepFor, options = {},
}) {
  const opts = { ...DEFAULTS, ...options };
  const before = await heldContracts(exchange, symbol, side);
  const baseId = params.clientOrderId || null;
  const prices = [];
  let firstPrice = null;
  let makerFilled = 0;
  let lastOrder = null;
  let attempts = 0;

  for (let i = 1; i <= opts.attempts; i += 1) {
    const remaining = amount - makerFilled;
    if (remaining <= 0 || remaining < minAmount) break;

    let ticker;
    try { ticker = await exchange.fetchTicker(symbol); } catch { break; }
    const best = Number(side === 'buy' ? ticker && ticker.bid : ticker && ticker.ask);
    if (!Number.isFinite(best) || best <= 0) break;
    if (firstPrice === null) firstPrice = best;
    // Chasing a runaway is how a limit strategy ends up paying more than the
    // market order it replaced; past this, the market order is the better deal.
    if (Math.abs(best - firstPrice) / firstPrice * 100 > opts.maxDriftPercent) {
      logger.log(`[${requestId}] maker: price moved over ${opts.maxDriftPercent}% from ${firstPrice}; falling back`);
      break;
    }

    const price = Number(exchange.priceToPrecision(symbol, best));
    prices.push(price);
    attempts = i;
    let order = null;
    try {
      order = await exchange.createOrder(symbol, 'limit', side, remaining, price, {
        ...params,
        postOnly: true,
        ...(baseId ? { clientOrderId: `${baseId}-m${i}`.slice(0, 36) } : {}),
      });
      lastOrder = order;
    } catch (err) {
      // A post-only order that would have crossed is rejected, not filled as
      // taker. That is the order doing its job; try again at the new price.
      logger.log(`[${requestId}] maker attempt ${i} not placed (${err.message})`);
      continue;
    }

    await sleep(opts.waitMs);

    // Cancel first, then read: after the cancel nothing more can fill, so
    // the reading cannot be overtaken by a fill that lands after it.
    try { await exchange.cancelOrder(order.id, symbol); } catch { /* filled, or already gone */ }

    const held = await heldContracts(exchange, symbol, side);
    const byPosition = held !== null && before !== null ? Math.max(0, held - before) : 0;
    const byOrder = await orderFilled(exchange, order.id, symbol);
    // Cumulative across attempts by position; this attempt only by order.
    makerFilled = Math.max(makerFilled + byOrder, byPosition, makerFilled);
    makerFilled = Math.min(makerFilled, amount);
    logger.log(`[${requestId}] maker attempt ${i} at ${price}: filled ${makerFilled}/${amount}`);
  }

  const remaining = amount - makerFilled;
  let takerAmount = 0;
  let fallbackOrder = null;
  if (remaining > 0 && remaining >= minAmount) {
    takerAmount = Number(exchange.amountToPrecision(symbol, remaining));
    if (takerAmount > 0) {
      logger.log(`[${requestId}] maker: ${takerAmount} unfilled after ${attempts} attempt(s); market for the rest`);
      fallbackOrder = await exchange.createOrder(symbol, 'market', side, takerAmount, undefined, params);
    }
  }

  return {
    order: fallbackOrder || lastOrder,
    makerFilled,
    takerAmount,
    attempts,
    fellBack: fallbackOrder !== null,
    prices,
  };
}

module.exports = { placeMakerEntry, DEFAULTS };

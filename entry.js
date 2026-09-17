'use strict';

/**
 * Planning an entry: size, price, stop, and the reasons to refuse.
 *
 * This is the shared core behind placing a long or a short. It is pure — no
 * network, no clock of its own — because the two things most worth getting
 * right here are both asymmetries that only show up when you compare the two
 * directions side by side, and asymmetries are exactly what a hand-checked
 * script gets wrong:
 *
 *   RESTING. A long rests by BUYING at the bid; a short rests by SELLING at
 *   the ask. Both join a queue rather than crossing it. Get it backwards and
 *   every entry crosses the spread and pays the taker fee — 8bp instead of
 *   2bp on this venue, which the intraday analysis says is most of the edge.
 *
 *   STOPS. A long's stop sits BELOW the entry; a short's sits ABOVE. Inverted,
 *   the "stop" is a target that fires instantly at a loss, and on a leveraged
 *   account that is the worst bug in the file.
 *
 * Refusals are returned as reasons rather than thrown, so a caller placing
 * four symbols reports three placed and one skipped with a cause, instead of
 * stopping at the first problem.
 */

const LONG = 1;
const SHORT = -1;

/**
 * Round a price or amount the way the venue requires.
 *
 * Takes the exchange rather than reimplementing tick maths: ccxt already knows
 * each market's precision, and a hand-rolled rounder that disagrees with the
 * venue produces orders that are rejected at best and silently resized at
 * worst.
 */
function round(exchange, fn, symbol, value) {
  if (!Number.isFinite(value)) return NaN;
  const out = Number(exchange[fn](symbol, value));
  return Number.isFinite(out) ? out : NaN;
}

/**
 * Plan one entry.
 *
 * `dir` is +1 long or -1 short. `signalDir` is what the strategy currently
 * says; when the two disagree the entry is refused, because an approval is for
 * a setup and not for a symbol. Thirty-six minutes once passed between a board
 * and its execution and every symbol on it had reversed.
 */
function planEntry({
  exchange, symbol, dir, notionalUsd, book, signalDir, stopPrice: rawStop, market,
}) {
  const reasons = [];
  const m = market || (exchange && exchange.markets && exchange.markets[symbol]);
  const side = dir === LONG ? 'buy' : 'sell';

  if (dir !== LONG && dir !== SHORT) {
    return { symbol, ok: false, reasons: ['direction must be long or short'] };
  }
  if (!m || !m.swap || !m.linear) reasons.push('not a linear perp');
  if (signalDir !== undefined && signalDir !== dir) {
    reasons.push(`signal says ${signalDir === LONG ? 'long' : signalDir === SHORT ? 'short' : 'flat'} — setup gone`);
  }

  const bid = book && book.bids && book.bids[0] && Number(book.bids[0][0]);
  const ask = book && book.asks && book.asks[0] && Number(book.asks[0][0]);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || ask < bid) {
    return { symbol, side, dir, ok: false, reasons: [...reasons, 'no usable order book'] };
  }

  // Rest, never cross: a buy joins the bid, a sell joins the ask.
  const rawPrice = dir === LONG ? bid : ask;
  const price = round(exchange, 'priceToPrecision', symbol, rawPrice);
  const stopPrice = round(exchange, 'priceToPrecision', symbol, rawStop);

  if (!Number.isFinite(price)) reasons.push('could not price the order');
  if (!Number.isFinite(stopPrice)) {
    reasons.push('no stop price');
  } else if (dir === LONG && !(stopPrice < price)) {
    reasons.push(`stop ${stopPrice} is not below a long entry at ${price}`);
  } else if (dir === SHORT && !(stopPrice > price)) {
    reasons.push(`stop ${stopPrice} is not above a short entry at ${price}`);
  }

  const amount = Number.isFinite(price) && price > 0
    ? round(exchange, 'amountToPrecision', symbol, notionalUsd / price)
    : NaN;

  if (!Number.isFinite(amount) || amount <= 0) {
    reasons.push('size rounded away to nothing');
  } else {
    const minAmt = m && m.limits && m.limits.amount && m.limits.amount.min;
    const minCost = m && m.limits && m.limits.cost && m.limits.cost.min;
    if (Number.isFinite(minAmt) && amount < minAmt) {
      reasons.push(`size ${amount} is below the venue minimum ${minAmt}`);
    }
    if (Number.isFinite(minCost) && amount * price < minCost) {
      reasons.push(`notional ${(amount * price).toFixed(2)} is below the venue minimum ${minCost}`);
    }
  }

  const notional = Number.isFinite(amount) && Number.isFinite(price) ? amount * price : NaN;
  // Distance is taken in the direction the position actually loses.
  const riskUsd = Number.isFinite(amount) && Number.isFinite(stopPrice) && Number.isFinite(price)
    ? amount * (dir === LONG ? price - stopPrice : stopPrice - price)
    : NaN;

  return {
    symbol, side, dir, price, stopPrice, amount, notional, riskUsd,
    ok: reasons.length === 0, reasons,
  };
}

/**
 * Size a position so that being stopped costs a fixed share of equity.
 *
 * Returns NaN rather than a number when the stop is touching the price. A
 * vanishing stop distance sends this to infinity, and the resulting "size" is
 * both unplaceable and, if it were placed, a position that noise would stop
 * out immediately. A supertrend band that has ratcheted to within 0.02% of
 * price produces exactly that, and it looks like an opportunity on screen.
 */
function sizeForRisk({ equityUsd, riskFraction, price, stopPrice, minStopFraction = 0.002 }) {
  if (![equityUsd, riskFraction, price, stopPrice].every(Number.isFinite)) return NaN;
  if (equityUsd <= 0 || riskFraction <= 0 || price <= 0) return NaN;
  const stopFraction = Math.abs(price - stopPrice) / price;
  if (!(stopFraction >= minStopFraction)) return NaN;
  return (equityUsd * riskFraction) / stopFraction;
}

/** The params ccxt needs to attach the stop at creation, never as a second call. */
function entryParams(plan) {
  return { stopLoss: { triggerPrice: plan.stopPrice } };
}

module.exports = { planEntry, sizeForRisk, entryParams, LONG, SHORT };

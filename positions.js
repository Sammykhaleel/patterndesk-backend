'use strict';

/**
 * Reading and unwinding what is already open.
 *
 * Everything else in this server opens positions. Until now nothing could
 * show you one, close one, or take a stop off one — which meant the only way
 * to answer "what did the bot just do" was to open the exchange's own app,
 * and the only way to undo it was to trade there by hand.
 *
 * Three rules shape this file:
 *
 *   1. Reads are honest about what they could not read. A venue that refuses
 *      an unfiltered position query returns a partial book, and saying so
 *      beats presenting three positions as though they were all of them.
 *   2. Writes name the position they act on and act on nothing else. "Close
 *      everything" is not offered: one mis-tap should cost one position.
 *   3. A capability the venue does not have is a 501 that says so, never a
 *      silent success. Clearing a stop that was not cleared is the most
 *      dangerous possible lie here.
 */

const { RequestError } = require('./trading');

/** ccxt reports side as long/short; orders take buy/sell. */
function positionSideOf(p) {
  const side = String(p?.side || '').toLowerCase();
  if (side === 'long' || side === 'buy') return 'long';
  if (side === 'short' || side === 'sell') return 'short';
  // Fall back to the sign of the size when the venue omits the side.
  const contracts = Number(p?.contracts ?? 0);
  if (Number.isFinite(contracts) && contracts !== 0) return contracts > 0 ? 'long' : 'short';
  return null;
}

/** The order side that reduces this position: sell a long, buy a short. */
function closingSideFor(position) {
  const side = positionSideOf(position);
  if (!side) throw new RequestError('Could not tell which way that position is facing.', 502);
  return side === 'long' ? 'sell' : 'buy';
}

/**
 * A number, or null — never NaN and never a string.
 *
 * ccxt hands several of these through as strings from the raw payload, and a
 * "0.0000" that reaches the UI as a string renders as a stop that exists.
 */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * The protective levels a position carries.
 *
 * Bybit returns "0" for "none" rather than omitting the field, so a plain
 * Number() would report a stop at price zero — which reads as a stop that
 * exists and is very far away, the opposite of the truth.
 */
function protectionOf(p) {
  const info = p?.info || {};
  const pick = (...vals) => {
    for (const v of vals) {
      const n = num(v);
      if (n !== null && n > 0) return n;
    }
    return null;
  };
  return {
    stopLoss: pick(p.stopLossPrice, info.stopLoss, info.stop_loss),
    takeProfit: pick(p.takeProfitPrice, info.takeProfit, info.take_profit),
  };
}

/** One position, flattened to what a person needs to decide about it. */
function normalisePosition(exchangeId, p) {
  const contracts = Math.abs(Number(p?.contracts ?? 0));
  return {
    exchange: exchangeId,
    symbol: p.symbol,
    side: positionSideOf(p),
    contracts,
    notional: num(p.notional),
    entryPrice: num(p.entryPrice),
    markPrice: num(p.markPrice),
    unrealizedPnl: num(p.unrealizedPnl),
    leverage: num(p.leverage),
    liquidationPrice: num(p.liquidationPrice),
    ...protectionOf(p),
  };
}

/**
 * Every open position across the given exchanges.
 *
 * One venue failing does not fail the call: its error is reported alongside
 * the positions that did load, because a partial answer plus a named failure
 * is more useful than nothing at all when you are trying to get flat.
 */
async function readPositions(exchanges, { logger = console } = {}) {
  const positions = [];
  const problems = [];

  for (const [id, exchange] of Object.entries(exchanges)) {
    if (!exchange.has.fetchPositions) {
      problems.push({ exchange: id, error: 'This venue cannot report open positions.' });
      continue;
    }
    try {
      const raw = await exchange.fetchPositions();
      for (const p of raw || []) {
        const contracts = Number(p?.contracts ?? 0);
        if (!Number.isFinite(contracts) || Math.abs(contracts) === 0) continue;
        positions.push(normalisePosition(id, p));
      }
    } catch (err) {
      logger.warn(`[positions] ${id} could not be read: ${err.message}`);
      problems.push({ exchange: id, error: err.message });
    }
  }

  positions.sort((a, b) => Math.abs(b.notional || 0) - Math.abs(a.notional || 0));
  return { positions, problems };
}

/** The one open position on this symbol, or a 404 naming what is open. */
async function findPosition(exchange, symbol) {
  let raw;
  try {
    raw = await exchange.fetchPositions([symbol]);
  } catch {
    // Some venues refuse a filtered query; read the book and pick from it.
    raw = await exchange.fetchPositions();
  }
  const open = (raw || []).filter((p) => {
    const contracts = Number(p?.contracts ?? 0);
    return Number.isFinite(contracts) && Math.abs(contracts) > 0 && p.symbol === symbol;
  });
  if (open.length === 0) {
    throw new RequestError(`No open position on ${symbol}.`, 404);
  }
  // Hedge accounts hold both directions. Acting on "the position" would be
  // ambiguous, so the caller has to say which side it means.
  return open;
}

/**
 * Removes the take-profit and stop a position is carrying.
 *
 * The levels are sent with the entry as Bybit position attributes, not as
 * resting orders, so they cannot be cancelled from an order list — they are
 * cleared by setting them to zero on the position itself.
 *
 * Refused rather than approximated on a venue without that call: reporting a
 * stop as cleared when it is still live would be the most expensive possible
 * thing to be wrong about here.
 */
async function clearProtection(exchange, symbol, { positionIdx = null } = {}) {
  if (typeof exchange.privatePostV5PositionTradingStop !== 'function') {
    throw new RequestError(
      `Clearing a position's stop and target is not implemented for ${exchange.id}. `
      + 'Do it in the exchange\'s own app.',
      501
    );
  }
  const market = exchange.market(symbol);
  const params = {
    category: market.linear ? 'linear' : 'inverse',
    symbol: market.id,
    // "0" is Bybit's clear instruction; omitting a field leaves it untouched.
    stopLoss: '0',
    takeProfit: '0',
    positionIdx: positionIdx === null ? 0 : positionIdx,
  };
  await exchange.privatePostV5PositionTradingStop(params);
  return { symbol, cleared: ['stopLoss', 'takeProfit'] };
}

/**
 * Cancels resting orders on one symbol.
 *
 * Scoped to a symbol on purpose. A blanket cancel is one tap away from
 * removing protective orders on positions the caller was not thinking about.
 */
async function cancelOrders(exchange, symbol) {
  if (!exchange.has.cancelAllOrders) {
    throw new RequestError(`${exchange.id} cannot cancel orders through this API.`, 501);
  }
  const before = exchange.has.fetchOpenOrders
    ? await exchange.fetchOpenOrders(symbol).catch(() => null)
    : null;
  await exchange.cancelAllOrders(symbol);
  return {
    symbol,
    // null means "could not count", which is not the same as zero and must
    // not be rendered as "cancelled 0 orders".
    cancelled: before ? before.length : null,
  };
}

/**
 * Free and total margin, per venue.
 *
 * "The bot closes positions but never opens any" has several possible causes
 * and they are indistinguishable from outside: a tripped breaker, a position
 * cap, a stop beyond liquidation — or simply no free margin left, which is
 * what an oversized manual position on a small account produces. Free balance
 * is the one of those that nothing else reports, and an order needs it while
 * a reduceOnly close does not. That asymmetry is exactly the reported
 * symptom, so it is worth being able to see.
 */
async function readAccounts(exchanges, { code = 'USDT', logger = console } = {}) {
  const accounts = {};
  for (const [id, exchange] of Object.entries(exchanges)) {
    try {
      const b = await exchange.fetchBalance();
      const num = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      accounts[id] = {
        currency: code,
        free: num(b?.free?.[code] ?? b?.[code]?.free),
        used: num(b?.used?.[code] ?? b?.[code]?.used),
        total: num(b?.total?.[code] ?? b?.[code]?.total),
      };
    } catch (err) {
      logger.warn(`[positions] balance for ${id} unavailable: ${err.message}`);
      accounts[id] = { currency: code, error: err.message };
    }
  }
  return accounts;
}

module.exports = {
  readPositions,
  readAccounts,
  findPosition,
  normalisePosition,
  positionSideOf,
  closingSideFor,
  protectionOf,
  clearProtection,
  cancelOrders,
};

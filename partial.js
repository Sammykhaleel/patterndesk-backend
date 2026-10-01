'use strict';

/**
 * Partial close: part of a position taken off at a profit target, the rest
 * held to the flip.
 *
 * Optional and per symbol — { pricePct, sizePct } on a symbol's override, set
 * only when chosen. Measured first (ST Test's "Partial close" table): across
 * the account's symbols it mostly cost money, because this strategy earns from
 * a few long runs and a partial close halves them. It helped on some (ZEC at
 * +3%, in two separate measurements), which is why it is a per-symbol choice
 * and never a default.
 *
 * Placed right after the entry fills, as a resting reduce-only LIMIT order on
 * the exchange:
 *   - it fills even while this server is asleep or restarting;
 *   - it pays the maker rate when it rests, which is what the backtest charged;
 *   - reduce-only, so it can only ever shrink the position, never open one.
 *
 * `pricePct` is the move in the SYMBOL's price from the entry (3 = ZEC 3%
 * above a long's entry), not a return on the position. `sizePct` is the share
 * of the position closed there.
 *
 * Its order id ends in "p" (signalId(..., 'p')), which is how it is found to
 * cancel and how the P&L panel names what closed it. Before the position it
 * belongs to is closed, and before a new entry places another, any that is
 * still resting is cancelled: a leftover reduce-only order on the wrong
 * position would close part of a trade nobody asked it to.
 */

const PARTIAL_ID = /^[A-Za-z0-9]+-\w+-\d+p$/;

function isPartialOrder(order) {
  const id = String((order && (order.clientOrderId || (order.info && order.info.orderLinkId))) || '');
  return PARTIAL_ID.test(id);
}

/** Cancels every partial-close order still resting on `symbol`. Never throws. */
async function cancelPartials({ exchange, symbol, logger = console }) {
  let open;
  try {
    open = await exchange.fetchOpenOrders(symbol);
  } catch (err) {
    logger.warn(`[partial] ${symbol}: could not read open orders to cancel a partial close (${err.message})`);
    return { cancelled: 0, error: err.message };
  }
  let cancelled = 0;
  for (const o of open || []) {
    if (!isPartialOrder(o)) continue;
    try {
      await exchange.cancelOrder(o.id, symbol);
      cancelled += 1;
    } catch (err) {
      // Already filled or gone between the read and the cancel: nothing left
      // to do. Anything else is logged; the reduce-only flag still means it
      // cannot open a position.
      if (!/not exist|not found|already|filled|cancel/i.test(err.message)) {
        logger.warn(`[partial] ${symbol}: could not cancel ${o.id} (${err.message})`);
      }
    }
  }
  if (cancelled) logger.log(`[partial] ${symbol}: cancelled ${cancelled} resting partial close(s)`);
  return { cancelled };
}

/**
 * Places the partial close for the position just opened on `side` ('buy' =
 * long, 'sell' = short). Reads the position from the exchange for its real
 * size and average entry — the order's own fill report can be partial, and a
 * maker entry is several orders.
 *
 * Returns what it did; never throws, because the entry it follows has already
 * happened and must be reported as such.
 */
async function placePartial({ exchange, symbol, side, partial, clientOrderId, config = {}, logger = console }) {
  const pricePct = Number(partial && partial.pricePct);
  const sizePct = Number(partial && partial.sizePct);
  if (!(pricePct > 0) || !(sizePct > 0 && sizePct < 100)) return { placed: false, reason: 'not set' };
  if (config.hedgeMode) {
    logger.warn(`[partial] ${symbol}: not placed — partial closes are not supported in hedge mode`);
    return { placed: false, reason: 'hedge mode' };
  }
  if (config.dryRun) {
    logger.log(`[partial] ${symbol}: DRY RUN — would close ${sizePct}% at ${pricePct}% from entry`);
    return { placed: false, reason: 'dry run' };
  }

  const want = side === 'buy' ? 'long' : 'short';
  let position;
  try {
    const rows = await exchange.fetchPositions([symbol]);
    position = (rows || []).find((p) => p && p.symbol === symbol && p.side === want && Math.abs(Number(p.contracts)) > 0);
  } catch (err) {
    logger.warn(`[partial] ${symbol}: could not read the position (${err.message}) — no partial close placed`);
    return { placed: false, reason: err.message };
  }
  if (!position) return { placed: false, reason: 'no position found' };

  const contracts = Math.abs(Number(position.contracts));
  const entry = Number(position.entryPrice);
  if (!(entry > 0)) return { placed: false, reason: 'no entry price' };

  const market = exchange.market(symbol);
  // Rounded DOWN by ccxt's precision: closing a hair less than asked is
  // harmless; a hair more is refused by a reduce-only order anyway.
  const amount = Number(exchange.amountToPrecision(symbol, contracts * sizePct / 100));
  const minAmount = Number(market && market.limits && market.limits.amount && market.limits.amount.min) || 0;
  const target = entry * (side === 'buy' ? 1 + pricePct / 100 : 1 - pricePct / 100);
  const price = Number(exchange.priceToPrecision(symbol, target));
  const minNotional = Number(config.minOrderNotional) || 0;

  if (!(amount > 0) || amount < minAmount || (minNotional && amount * price * (Number(market && market.contractSize) || 1) < minNotional)) {
    logger.log(`[partial] ${symbol}: ${sizePct}% of ${contracts} is below the exchange minimum — the whole position rides to the flip`);
    return { placed: false, reason: 'below minimum', contracts };
  }
  if (!(price > 0)) return { placed: false, reason: 'no price' };

  try {
    const order = await exchange.createOrder(symbol, 'limit', side === 'buy' ? 'sell' : 'buy', amount, price,
      { reduceOnly: true, clientOrderId });
    logger.log(`[partial] ${symbol}: ${amount} of ${contracts} (${sizePct}%) to close at ${price} — ${pricePct}% from the ${entry} entry`);
    return { placed: true, amount, price, entry, contracts, orderId: order && order.id };
  } catch (err) {
    logger.warn(`[partial] ${symbol}: the partial close was refused (${err.message}); the position is unchanged`);
    return { placed: false, reason: err.message };
  }
}

module.exports = { placePartial, cancelPartials, isPartialOrder, PARTIAL_ID };

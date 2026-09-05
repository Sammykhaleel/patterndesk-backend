'use strict';

const crypto = require('crypto');
const { applyLeverage, applyMarginMode } = require('./exchanges');

/** Errors that are the caller's fault and safe to describe back to them. */
class RequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
    this.expose = true;
  }
}

const VALID_SIDES = new Set(['buy', 'sell']);

/* ------------------------------------------------------------------ *
 * Request validation
 * ------------------------------------------------------------------ */

function validateTradeRequest(body, exchanges) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RequestError('Request body must be a JSON object.');
  }

  const { exchange: exchangeName, symbol, side, reduceOnly, clientOrderId } = body;

  if (typeof exchangeName !== 'string' || !exchangeName.trim()) {
    throw new RequestError('"exchange" must be a non-empty string.');
  }
  if (typeof symbol !== 'string' || !symbol.trim()) {
    throw new RequestError('"symbol" must be a non-empty string, e.g. "BTC/USDT:USDT".');
  }
  if (typeof side !== 'string' || !VALID_SIDES.has(side.toLowerCase())) {
    throw new RequestError('"side" must be exactly "buy" or "sell".');
  }
  if (reduceOnly !== undefined && typeof reduceOnly !== 'boolean') {
    throw new RequestError('"reduceOnly" must be a boolean when provided.');
  }
  if (clientOrderId !== undefined) {
    if (typeof clientOrderId !== 'string' || !/^[A-Za-z0-9_-]{1,36}$/.test(clientOrderId)) {
      throw new RequestError('"clientOrderId" must be 1-36 characters of A-Z, a-z, 0-9, "-" or "_".');
    }
  }

  // Optional protective levels. The scanner supplies the pattern's own
  // invalidation and measured-move target, which are more meaningful than a
  // fixed percentage. Both are validated for direction below, once the entry
  // price is known.
  for (const name of ['stopPrice', 'targetPrice']) {
    const value = body[name];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new RequestError(`"${name}" must be a positive number when provided.`);
    }
  }

  const id = exchangeName.trim().toLowerCase();
  const exchange = exchanges[id];
  if (!exchange) {
    throw new RequestError(
      `Exchange "${exchangeName}" is not configured. Available: ${Object.keys(exchanges).join(', ') || 'none'}.`
    );
  }

  return {
    exchangeId: id,
    exchange,
    symbol: symbol.trim(),
    side: side.toLowerCase(),
    reduceOnly: reduceOnly === true,
    clientOrderId: clientOrderId ?? null,
    stopPrice: typeof body.stopPrice === 'number' ? body.stopPrice : null,
    targetPrice: typeof body.targetPrice === 'number' ? body.targetPrice : null,
  };
}

function resolveMarket(exchange, symbol) {
  let market;
  try {
    market = exchange.market(symbol);
  } catch {
    throw new RequestError(`Symbol "${symbol}" is not listed on ${exchange.id}.`);
  }
  if (market.active === false) {
    throw new RequestError(`Market ${symbol} is not active on ${exchange.id}.`);
  }
  return market;
}

/* ------------------------------------------------------------------ *
 * Balance and sizing
 * ------------------------------------------------------------------ */

/**
 * The margin currency is market.settle for derivatives (USDT for a linear
 * perp, BTC for an inverse one) and market.quote for spot. Parsing it out of
 * the symbol string only ever worked for linear USDT pairs.
 */
function marginCurrency(market) {
  return market.settle || market.quote;
}

function readFreeBalance(balance, currency) {
  // ccxt exposes both shapes and either can be missing depending on the
  // exchange and account type (Bybit unified in particular).
  const candidates = [
    balance?.[currency]?.free,
    balance?.free?.[currency],
    balance?.[currency]?.total,
    balance?.total?.[currency],
  ];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function resolvePrice(ticker) {
  const candidates = [ticker?.last, ticker?.close, ticker?.mark, ticker?.bid, ticker?.ask];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/**
 * Converts a slice of the margin balance into an order amount in the units the
 * exchange expects, honouring contract size and linear/inverse conventions.
 *
 * Returns amount (in contracts/base units) and the notional it represents in
 * the quote currency, which is what the position cap is measured against.
 */
function computeOrderSize({ market, price, freeBalance, fraction }) {
  const contractSize = Number(market.contractSize) || 1;
  const isInverse = market.inverse === true;

  // Notional exposure in quote currency.
  const notionalQuote = isInverse
    ? freeBalance * price * fraction // settle currency is the base coin
    : freeBalance * fraction;        // settle currency is the quote coin

  // Inverse contracts are denominated in quote currency; linear ones in base.
  const rawAmount = isInverse
    ? notionalQuote / contractSize
    : notionalQuote / price / contractSize;

  if (!Number.isFinite(rawAmount) || rawAmount <= 0) {
    throw new RequestError('Computed order size is not a usable number.', 422);
  }

  return { rawAmount, notionalQuote, contractSize, isInverse };
}

function notionalOf({ amount, price, market }) {
  const contractSize = Number(market.contractSize) || 1;
  return market.inverse === true
    ? amount * contractSize
    : amount * price * contractSize;
}

/**
 * Explains an order that is too small to place, and says what would fix it.
 *
 * "Increase TRADE_BALANCE_PERCENTAGE" on its own is a dead end when you cannot
 * tell whether you need 6% or 600%. The smallest tradeable size is a property
 * of the market, and the balance is known, so the required percentage is just
 * arithmetic — worth doing here rather than leaving to trial and error against
 * a live exchange.
 */
function sizeTooSmallMessage({ market, symbol, price, sized, config, err = null }) {
  const step = Number(market.precision?.amount) || Number(market.limits?.amount?.min) || null;
  const parts = [
    `Order size ${sized.rawAmount.toPrecision(4)} ${market.base} is below the smallest tradeable size on ${symbol}`
    + (step ? ` (step ${step})` : '') + '.',
    `That is ${sized.notionalQuote.toFixed(2)} of notional at ${config.tradePercentage}% of your balance.`,
  ];

  if (step && Number.isFinite(price) && price > 0 && config.tradeFraction > 0) {
    const neededNotional = notionalOf({ amount: step, price, market });
    // notionalQuote = base * fraction, so base = notionalQuote / fraction —
    // which recovers the balance term for linear and inverse markets alike.
    const base = sized.notionalQuote / config.tradeFraction;
    if (base > 0) {
      const neededPct = (neededNotional / base) * 100;
      parts.push(
        `The smallest order here is about ${neededNotional.toFixed(2)}, which needs `
        + `TRADE_BALANCE_PERCENTAGE of roughly ${Math.ceil(neededPct)} at this balance — `
        + 'or fund the account instead.'
      );
    }
  }
  if (err && err.message) parts.push(`(${err.message})`);
  return parts.join(' ');
}

function assertWithinMarketLimits({ market, amount, notionalQuote }) {
  const limits = market.limits || {};
  const minAmount = Number(limits.amount?.min);
  const maxAmount = Number(limits.amount?.max);
  const minCost = Number(limits.cost?.min);

  if (Number.isFinite(minAmount) && amount < minAmount) {
    throw new RequestError(
      `Order size ${amount} is below the ${market.symbol} minimum of ${minAmount}. Increase TRADE_BALANCE_PERCENTAGE or fund the account.`,
      422
    );
  }
  if (Number.isFinite(maxAmount) && maxAmount > 0 && amount > maxAmount) {
    throw new RequestError(
      `Order size ${amount} exceeds the ${market.symbol} maximum of ${maxAmount}.`,
      422
    );
  }
  if (Number.isFinite(minCost) && notionalQuote < minCost) {
    throw new RequestError(
      `Order notional ${notionalQuote.toFixed(4)} is below the ${market.symbol} minimum of ${minCost}.`,
      422
    );
  }
}

/**
 * Resolves the protective levels for an entry.
 *
 * Prefers levels the caller supplied — the scanner passes the pattern's own
 * invalidation and measured-move target — and falls back to a fixed percentage.
 * Each is checked against the entry side: a stop on the wrong side of the price
 * fills instantly, and a target on the wrong side closes the position the
 * moment it opens.
 *
 * Both ride on the entry order, so the exchange enforces them even if this
 * process dies. A bot that must stay alive to close its own positions is a
 * liability.
 */
function resolveProtectiveLevels({ side, price, requested, stopLossPercent, takeProfitPercent }) {
  const isBuy = side === 'buy';
  const problems = [];

  let stop = requested.stopPrice ?? null;
  if (stop !== null && !(isBuy ? stop < price : stop > price)) {
    problems.push(`stopPrice ${stop} is on the wrong side of a ${side} entry at ${price}`);
    stop = null;
  }
  if (stop === null && stopLossPercent !== null) {
    const pct = stopLossPercent / 100;
    stop = isBuy ? price * (1 - pct) : price * (1 + pct);
  }

  let target = requested.targetPrice ?? null;
  if (target !== null && !(isBuy ? target > price : target < price)) {
    problems.push(`targetPrice ${target} is on the wrong side of a ${side} entry at ${price}`);
    target = null;
  }
  if (target === null && takeProfitPercent !== null) {
    const pct = takeProfitPercent / 100;
    target = isBuy ? price * (1 + pct) : price * (1 - pct);
  }

  return { stop, target, problems };
}

/**
 * How far price can move against the position before the exchange closes it.
 * If the protective stop sits further away than that, the exchange liquidates
 * before the stop can trigger — the stop is decorative and the real loss is
 * the margin, not the intended risk.
 *
 * The two margin modes answer this completely differently, and using the
 * isolated formula under cross is what made a 25x account refuse ordinary
 * pattern stops that were never actually at risk:
 *
 *   isolated — only the margin posted for THIS position stands behind it, so
 *     roughly a (100/L)% adverse move wipes it out. Leverage is the whole
 *     story and the account balance is irrelevant.
 *
 *   cross — the free balance backs the book. What matters is how much equity
 *     stands behind the exposure, so the distance is (equity / notional),
 *     less the maintenance margin the exchange holds back. A small position
 *     on a healthy balance is effectively unliquidatable no matter what the
 *     nominal leverage says.
 *
 * Both are approximations — the true liquidation price also moves with fees
 * and funding — so safetyFactor keeps a buffer under either.
 */
function assertStopInsideLiquidation({
  price,
  stop,
  leverage,
  safetyFactor,
  marginMode = 'isolated',
  equity = null,
  notionalQuote = null,
  existingNotional = 0,
  maintenanceMarginRate = 0.01,
}) {
  if (stop === null) return null;

  const stopDistancePct = (Math.abs(price - stop) / price) * 100;
  const cross = marginMode === 'cross'
    && Number.isFinite(equity) && equity > 0
    && Number.isFinite(notionalQuote) && notionalQuote > 0;

  let liquidationPct;
  let explain;

  if (cross) {
    // Free balance rather than total equity: it is what is genuinely
    // uncommitted, so this understates the buffer when other positions are
    // open. Erring toward refusing a trade is the right direction here.
    const totalNotional = notionalQuote + Math.max(0, existingNotional || 0);
    const maintenance = totalNotional * maintenanceMarginRate;
    liquidationPct = ((equity - maintenance) / totalNotional) * 100;

    if (liquidationPct <= 0) {
      throw new RequestError(
        `Refusing to trade: ${equity.toFixed(2)} of free margin does not cover the maintenance margin on ` +
        `${totalNotional.toFixed(2)} of cross exposure. Reduce TRADE_BALANCE_PERCENTAGE or close something.`,
        422
      );
    }
    // Price cannot fall past zero, so a long is never further than 100% away.
    liquidationPct = Math.min(liquidationPct, 100);
    explain = `${equity.toFixed(2)} free margin behind ${totalNotional.toFixed(2)} of cross exposure puts `
      + `liquidation around ${liquidationPct.toFixed(2)}%`;
  } else {
    // Isolated. Unchanged, including staying inert at 1x and when unset.
    if (!leverage || leverage <= 1) return null;
    liquidationPct = 100 / leverage;
    explain = `at ${leverage}x isolated, liquidation is around ${liquidationPct.toFixed(2)}%`;
  }

  const usablePct = liquidationPct * safetyFactor;
  if (stopDistancePct >= usablePct) {
    // The remedy differs by mode: under cross, leverage is not what is
    // squeezing the distance, so telling someone to lower it would send them
    // to change a setting that cannot help.
    const remedy = cross
      ? 'Lower TRADE_BALANCE_PERCENTAGE, raise the balance, or use a tighter stop.'
      : `Lower LEVERAGE to about ${Math.max(1, Math.floor(safetyFactor * 100 / stopDistancePct))}x, `
        + 'or use a tighter stop.';
    throw new RequestError(
      `Stop is ${stopDistancePct.toFixed(2)}% away but ${explain} (usable ${usablePct.toFixed(2)}% after ` +
      `buffer). The position would be liquidated before the stop triggers. ${remedy}`,
      422
    );
  }
  return { stopDistancePct, liquidationPct, marginMode: cross ? 'cross' : 'isolated' };
}

/* ------------------------------------------------------------------ *
 * Position awareness
 * ------------------------------------------------------------------ */

async function fetchOpenPosition(exchange, market) {
  if (!exchange.has.fetchPositions) return null;
  let positions;
  try {
    positions = await exchange.fetchPositions([market.symbol]);
  } catch (err) {
    throw new Error(`Could not read open positions for ${market.symbol}: ${err.message}`);
  }
  const open = (positions || []).filter((p) => {
    if (!p || p.symbol !== market.symbol) return false;
    const contracts = Number(p.contracts ?? p.contractSize ?? 0);
    return Number.isFinite(contracts) && Math.abs(contracts) > 0;
  });
  if (open.length === 0) return null;

  // Hedge-mode accounts can report both directions; treat the larger as current.
  open.sort((a, b) => Math.abs(Number(b.contracts) || 0) - Math.abs(Number(a.contracts) || 0));
  const p = open[0];
  return {
    side: p.side === 'short' ? 'sell' : 'buy',
    contracts: Math.abs(Number(p.contracts) || 0),
    notional: Math.abs(Number(p.notional) || 0),
    raw: p,
  };
}

/* ------------------------------------------------------------------ *
 * Idempotency
 * ------------------------------------------------------------------ */

class DedupeCache {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.entries = new Map();
  }

  #prune() {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.at > this.ttlMs) this.entries.delete(key);
    }
  }

  get(key) {
    if (this.ttlMs <= 0) return null;
    this.#prune();
    return this.entries.get(key) ?? null;
  }

  set(key, value) {
    if (this.ttlMs <= 0) return;
    this.#prune();
    this.entries.set(key, { at: Date.now(), value });
  }

  get size() {
    this.#prune();
    return this.entries.size;
  }
}

function dedupeKey({ exchangeId, symbol, side, reduceOnly, clientOrderId }) {
  if (clientOrderId) return `cid:${exchangeId}:${clientOrderId}`;
  return `sig:${exchangeId}:${symbol}:${side}:${reduceOnly ? 'close' : 'open'}`;
}

function buildClientOrderId(provided) {
  if (provided) return provided;
  return `pd${crypto.randomBytes(9).toString('hex')}`;
}

/* ------------------------------------------------------------------ *
 * Main entry point
 * ------------------------------------------------------------------ */

async function executeTrade(request, { config, dedupe, breaker = null, logger = console, requestId }) {
  const { exchange, exchangeId, symbol, side, reduceOnly, clientOrderId } = request;

  const key = dedupeKey({ exchangeId, symbol, side, reduceOnly, clientOrderId });
  const cached = dedupe.get(key);
  if (cached) {
    logger.log(`[${requestId}] duplicate signal suppressed (${key})`);
    return { ...cached.value, duplicate: true };
  }

  const market = resolveMarket(exchange, symbol);
  const currency = marginCurrency(market);

  const [balance, ticker] = await Promise.all([
    exchange.fetchBalance(),
    exchange.fetchTicker(symbol),
  ]);

  const price = resolvePrice(ticker);
  if (price === null) {
    throw new RequestError(`No usable price available for ${symbol}.`, 503);
  }

  const position = await fetchOpenPosition(exchange, market);

  // Account-level circuit breaker. Checked here rather than in the scanner
  // loop so it covers EVERY route into an order — a hand-sent POST included.
  // It used to live only inside the scan loop, which meant MAX_DAILY_LOSS_PERCENT
  // did nothing at all whenever SCANNER_ENABLED was false.
  //
  // reduceOnly is exempt on purpose: a tripped breaker must never trap you in
  // a position. Closing is always allowed, opening is not.
  if (breaker && !reduceOnly) {
    const equity = Number(balance?.total?.USDT ?? balance?.USDT?.total);
    if (Number.isFinite(equity) && equity > 0) {
      if (breaker.needsBaseline(equity) && typeof breaker.reconstruct === 'function') {
        breaker.adoptBaseline(await breaker.reconstruct(exchange, equity, logger), logger, equity);
      }
      breaker.update(equity, logger);
    }
    if (breaker.blocked) {
      throw new RequestError(
        `Halted by the daily circuit breaker: ${breaker.reason}. ` +
        'Closing an open position with reduceOnly still works; new positions resume next UTC day.',
        409
      );
    }
  }

  let amount;
  let notionalQuote;
  // Hoisted: the cross-margin liquidation check below needs to know how much
  // equity stands behind the exposure, not just how large the order is.
  let freeBalance = null;

  if (reduceOnly) {
    if (!position) {
      throw new RequestError(`No open position on ${symbol} to reduce.`, 409);
    }
    if (position.side === side) {
      throw new RequestError(
        `reduceOnly ${side} would increase the existing ${position.side} position on ${symbol}.`,
        409
      );
    }
    amount = position.contracts;
    notionalQuote = notionalOf({ amount, price, market });
  } else {
    if (position && position.side !== side) {
      throw new RequestError(
        `An opposite ${position.side} position is open on ${symbol}. Close it first with reduceOnly before opening a ${side}.`,
        409
      );
    }

    freeBalance = readFreeBalance(balance, currency);
    if (freeBalance <= 0) {
      throw new RequestError(`No free ${currency} balance available on ${exchangeId}.`, 409);
    }

    const sized = computeOrderSize({
      market,
      price,
      freeBalance,
      fraction: config.tradeFraction,
    });

    // ccxt THROWS InvalidOrder when the size is under the symbol's lot step —
    // it does not round down to zero, so the guard below never saw the case it
    // was written for. Unhandled, the single most ordinary condition there is
    // ("this order is too small for this market") reached the browser as an
    // opaque 500 with the reason buried in a stack trace.
    try {
      amount = Number(exchange.amountToPrecision(symbol, sized.rawAmount));
    } catch (err) {
      throw new RequestError(sizeTooSmallMessage({ market, symbol, price, sized, config, err }), 422);
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new RequestError(sizeTooSmallMessage({ market, symbol, price, sized, config }), 422);
    }
    notionalQuote = notionalOf({ amount, price, market });

    assertWithinMarketLimits({ market, amount, notionalQuote });

    if (config.maxPositionNotional !== null) {
      const existing = position ? position.notional : 0;
      const projected = existing + notionalQuote;
      if (projected > config.maxPositionNotional) {
        throw new RequestError(
          `Order would take ${symbol} exposure to ${projected.toFixed(2)}, over the cap of ${config.maxPositionNotional}. ` +
          `Existing position: ${existing.toFixed(2)}.`,
          409
        );
      }
    }
  }

  const params = { reduceOnly: reduceOnly || undefined };
  const finalClientOrderId = buildClientOrderId(clientOrderId);
  params.clientOrderId = finalClientOrderId;

  // Protective levels attached to the entry itself, so a fill is never left
  // naked and the exchange closes the position without this process running.
  let stopPrice = null;
  let targetPrice = null;
  if (!reduceOnly) {
    const levels = resolveProtectiveLevels({
      side,
      price,
      requested: { stopPrice: request.stopPrice, targetPrice: request.targetPrice },
      stopLossPercent: config.stopLossPercent,
      takeProfitPercent: config.takeProfitPercent,
    });
    for (const problem of levels.problems) {
      logger.warn(`[${requestId}] ignoring bad level: ${problem}`);
    }
    if (levels.stop !== null) {
      stopPrice = Number(exchange.priceToPrecision(symbol, levels.stop));
      params.stopLoss = { triggerPrice: stopPrice, type: 'market' };
    }
    if (levels.target !== null) {
      targetPrice = Number(exchange.priceToPrecision(symbol, levels.target));
      params.takeProfit = { triggerPrice: targetPrice, type: 'market' };
    }
    if (config.requireProtectiveStop && stopPrice === null) {
      throw new RequestError(
        'Refusing to open a position with no stop. Set STOP_LOSS_PERCENT or send a valid stopPrice.',
        422
      );
    }
  }

  for (const k of Object.keys(params)) {
    if (params[k] === undefined) delete params[k];
  }

  const plan = {
    requestId,
    exchange: exchangeId,
    symbol,
    side,
    amount,
    price,
    notionalQuote: Number(notionalQuote.toFixed(6)),
    marginCurrency: currency,
    reduceOnly,
    stopPrice,
    targetPrice,
    leverage: config.leverage ?? null,
    marginMode: config.marginMode ?? null,
    marginUsed: config.leverage
      ? Number((notionalQuote / config.leverage).toFixed(6))
      : Number(notionalQuote.toFixed(6)),
    clientOrderId: finalClientOrderId,
    testnet: config.useTestnet,
  };

  logger.log(`[${requestId}] plan ${JSON.stringify(plan)}`);

  // Checked BEFORE the dry-run return, deliberately. This is pure arithmetic
  // on the stop that would actually be attached — it sends nothing and changes
  // nothing — so running it only when armed meant the one guard most likely to
  // refuse a trade was the one a dry run could never reveal. You would arm,
  // tap, and discover the refusal with real money on the line instead of in
  // the simulation whose entire job is to tell you what would happen.
  if (!reduceOnly) {
    assertStopInsideLiquidation({
      price,
      stop: stopPrice,
      leverage: config.leverage,
      safetyFactor: config.liquidationSafetyFactor,
      marginMode: config.marginMode,
      equity: freeBalance,
      notionalQuote,
      existingNotional: position ? position.notional : 0,
      // The exchange's own rate when ccxt reports one, otherwise the
      // configured floor. Whichever is harsher wins: understating maintenance
      // margin would overstate how far liquidation is.
      maintenanceMarginRate: Math.max(
        Number(market.maintenanceMarginRate) || 0,
        config.maintenanceMarginRate
      ),
    });
  }

  if (config.dryRun) {
    const result = { success: true, dryRun: true, plan };
    dedupe.set(key, result);
    return result;
  }

  // Everything below this line talks to the exchange and changes account
  // state, so it stays on the armed path only. A dry run therefore cannot
  // tell you whether MARGIN_MODE actually applied — watch the first live
  // order's log for that.
  if (!reduceOnly) {
    const margin = await applyMarginMode(exchange, symbol, config.marginMode, config.leverage, logger);
    const lev = await applyLeverage(exchange, symbol, config.leverage, logger);

    // Sizing and the liquidation check both assume the configured leverage.
    // Trading anyway at an unknown value would invalidate both.
    if (!lev.ok && config.requireLeverageApplied) {
      throw new RequestError(
        `Refusing to trade: leverage could not be set to ${config.leverage}x (${lev.reason}). ` +
        `Order sizing and the liquidation check both depend on it. ` +
        `Set REQUIRE_LEVERAGE_APPLIED=false to trade at the account's current leverage anyway.`,
        409
      );
    }
    if (!margin.ok && config.marginMode) {
      logger.warn(`[${requestId}] margin mode not confirmed: ${margin.reason}`);
    }
  }

  const order = await exchange.createOrder(symbol, 'market', side, amount, undefined, params);

  const result = {
    success: true,
    dryRun: false,
    orderId: order.id ?? null,
    clientOrderId: order.clientOrderId ?? finalClientOrderId,
    filled: order.filled ?? null,
    average: order.average ?? null,
    status: order.status ?? null,
    plan,
  };

  // Cached only after a successful send, so a failed attempt can be retried.
  dedupe.set(key, result);
  logger.log(`[${requestId}] order placed id=${result.orderId} status=${result.status}`);
  return result;
}

module.exports = {
  RequestError,
  DedupeCache,
  validateTradeRequest,
  executeTrade,
  // exported for tests
  computeOrderSize,
  resolveProtectiveLevels,
  assertStopInsideLiquidation,
  readFreeBalance,
  resolvePrice,
  marginCurrency,
  notionalOf,
  dedupeKey,
};

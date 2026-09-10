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

/**
 * Total account value, for ceilings expressed as a percentage of it.
 *
 * Total rather than free on purpose: a ceiling measured against the
 * uncommitted balance would tighten every time a position opened, so the limit
 * would depend on the order things happened in rather than on the account.
 */
function readAccountEquity(balance, currency) {
  const candidates = [
    balance?.[currency]?.total,
    balance?.total?.[currency],
    balance?.[currency]?.free,
    balance?.free?.[currency],
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
/**
 * The smallest order this market will actually accept, in base units.
 *
 * Two independent floors — the lot step and the minimum order value — and the
 * binding one differs per symbol, which is why no single percentage of a small
 * balance works across a watchlist. UNI's floor is $5, SOL's is $10.19, BTC's
 * is $80. Expressed as a percentage of an $8 account that is 63%, 128% and
 * 1004%, and no one should have to retune a setting per ticker.
 */
function minimumTradeableAmount({ market, price, minNotional = 0 }) {
  const step = Number(market.precision?.amount) || 0;
  let amount = Math.max(step, Number(market.limits?.amount?.min) || 0);

  // ccxt does not report limits.cost.min for every Bybit market — RAVE is one
  // it omits — and with only a 1-unit lot left as a constraint, a percentage of
  // a small balance rounds down to loose change. Bybit ACCEPTED a $0.2529 order
  // there, so this is an economic floor rather than a validity one: the size
  // below which a position is not worth opening. The exchange's own figure
  // wins whenever it is higher.
  const minCost = Math.max(Number(market.limits?.cost?.min) || 0, Number(minNotional) || 0);
  if (minCost > 0) {
    const perUnit = notionalOf({ amount: 1, price, market });
    if (perUnit > 0) amount = Math.max(amount, minCost / perUnit);
  }

  // Round UP to a whole number of lot steps: rounding down would land back
  // under the floor we just cleared.
  if (step > 0) amount = Math.ceil(amount / step - 1e-9) * step;
  return amount;
}

function sizeTooSmallMessage({ market, symbol, price, sized, config, err = null }) {
  const step = Number(market.precision?.amount) || Number(market.limits?.amount?.min) || null;
  const parts = [
    `Order size ${sized.rawAmount.toPrecision(4)} ${market.base} is below the smallest tradeable size on ${symbol}`
    + (step ? ` (step ${step})` : '') + '.',
    `That is ${sized.notionalQuote.toFixed(2)} of notional at ${config.tradePercentage}% of your balance.`,
  ];

  if (step && Number.isFinite(price) && price > 0 && config.tradeFraction > 0) {
    // Two independent floors, and clearing only one gets you a second refusal
    // with a different number: the lot step (how finely the market divides)
    // and the minimum order value (how little it will accept at all). The
    // binding constraint is whichever is larger.
    const stepNotional = notionalOf({ amount: step, price, market });
    const minCost = Number(market.limits?.cost?.min) || 0;
    const neededNotional = Math.max(stepNotional, minCost);

    // notionalQuote = base * fraction, so base = notionalQuote / fraction —
    // which recovers the balance term for linear and inverse markets alike.
    const base = sized.notionalQuote / config.tradeFraction;
    if (base > 0) {
      const neededPct = (neededNotional / base) * 100;
      const why = minCost > stepNotional
        ? `${symbol} will not accept an order under ${minCost} regardless of lot size`
        : `the ${step} ${market.base} lot step is worth about ${stepNotional.toFixed(2)}`;
      parts.push(
        `The smallest order here is about ${neededNotional.toFixed(2)} (${why}), which needs `
        + `TRADE_BALANCE_PERCENTAGE of roughly ${Math.ceil(neededPct)} at this balance — `
        + 'or fund the account instead.'
      );
    }
  }
  if (err && err.message) parts.push(`(${err.message})`);
  return parts.join(' ');
}

function assertWithinMarketLimits({ market, amount, notionalQuote, minNotional = 0 }) {
  const limits = market.limits || {};
  const minAmount = Number(limits.amount?.min);
  const maxAmount = Number(limits.amount?.max);
  // Same reason as minimumTradeableAmount: a market that declares no cost
  // minimum is not a market without one.
  const minCost = Math.max(Number(limits.cost?.min) || 0, Number(minNotional) || 0);

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
/**
 * How far a stop may sit before liquidation would arrive first, as a percent.
 *
 * Extracted so the guard and anything that REPORTS the limit compute it the
 * same way. Two copies of this formula would drift, and the failure mode is
 * a UI cheerfully offering a setting the server then refuses on every signal.
 *
 * Returns null when cross sizing cannot be established.
 */
/** Distance to liquidation as a percent of price, capped at 100. */
function liquidationPercent({ equity, totalNotional, maintenanceMarginRate = 0.01 }) {
  const pct = ((equity - totalNotional * maintenanceMarginRate) / totalNotional) * 100;
  return pct <= 0 ? pct : Math.min(pct, 100);
}

/**
 * The widest stop that would still be accepted, as a percent of price.
 *
 * The reporting counterpart of the guard below, sharing its arithmetic so the
 * two cannot disagree. Returns null when cross sizing cannot be established,
 * and 0 when the account does not even cover maintenance margin — which is
 * not the same thing, and only one of them means "nothing is placeable".
 */
function usableStopPercent({ equity, notionalQuote, existingNotional = 0, maintenanceMarginRate = 0.01, safetyFactor = 0.7 }) {
  if (!Number.isFinite(equity) || equity <= 0) return null;
  if (!Number.isFinite(notionalQuote) || notionalQuote <= 0) return null;
  const totalNotional = notionalQuote + Math.max(0, existingNotional || 0);
  if (totalNotional <= 0) return null;
  const pct = liquidationPercent({ equity, totalNotional, maintenanceMarginRate });
  return pct <= 0 ? 0 : pct * safetyFactor;
}

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
    //
    // Computed by the shared helper so that anything REPORTING this limit
    // arrives at the same number. Two copies would drift, and the failure
    // mode is a UI offering a setting the server refuses on every signal.
    const totalNotional = notionalQuote + Math.max(0, existingNotional || 0);
    liquidationPct = liquidationPercent({ equity, totalNotional, maintenanceMarginRate });

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

/**
 * Reads the WHOLE position book, not just this symbol.
 *
 * Under cross margin every open position draws on the same balance, so the
 * distance to liquidation is set by total exposure. Measuring only the symbol
 * being traded made the guard blind in exactly the case that matters: ten
 * symbols at the per-symbol cap is ten times the exposure the guard could see,
 * and it would approve every one of them while the real liquidation distance
 * fell from 15% to under 1%.
 *
 * `totalKnown` is false when the exchange could not give a full picture. The
 * caller decides what to do about that; quietly treating unknown as zero is
 * the behaviour this replaces.
 */
async function fetchPositionBook(exchange, market, logger = console) {
  if (!exchange.has.fetchPositions) {
    return { position: null, totalNotional: 0, totalKnown: false };
  }

  let positions;
  let totalKnown = true;
  try {
    // No symbol filter: we want everything sharing the margin pool.
    positions = await exchange.fetchPositions();
  } catch (err) {
    // Some exchanges refuse an unfiltered query. Fall back to this symbol so
    // the trade can still be evaluated, but say the total is unknown.
    logger.warn(`[positions] full book unavailable (${err.message}); falling back to ${market.symbol} only`);
    totalKnown = false;
    try {
      positions = await exchange.fetchPositions([market.symbol]);
    } catch (inner) {
      throw new RequestError(`Could not read open positions for ${market.symbol}: ${inner.message}`, 502);
    }
  }

  const allOpen = (positions || []).filter((p) => {
    const contracts = Number(p?.contracts ?? p?.contractSize ?? 0);
    return Number.isFinite(contracts) && Math.abs(contracts) > 0;
  });
  const totalNotional = allOpen.reduce((sum, p) => sum + Math.abs(Number(p.notional) || 0), 0);

  return { position: pickPosition(allOpen, market), sides: pickPositions(allOpen, market), totalNotional, totalKnown };
}

/**
 * This symbol's positions, split by direction.
 *
 * One-way accounts hold at most one, so `largest` is the whole story. Hedge
 * accounts hold a long AND a short at once, and they have to stay separate:
 * netting them would let a new long look like it was reducing an existing
 * short, and closing "the position" would be ambiguous.
 */
function pickPositions(allOpen, market) {
  const mine = allOpen.filter((p) => p.symbol === market.symbol);
  const buy = mine.filter((p) => p.side !== 'short');
  const sell = mine.filter((p) => p.side === 'short');
  return {
    buy: buy.length ? normalisePosition(buy) : null,
    sell: sell.length ? normalisePosition(sell) : null,
    largest: mine.length ? normalisePosition(mine) : null,
  };
}

function pickPosition(allOpen, market) {
  return pickPositions(allOpen, market).largest;
}

function normalisePosition(open) {
  // Hedge-mode accounts can report both directions; treat the larger as current.
  const sorted = [...open].sort(
    (a, b) => Math.abs(Number(b.contracts) || 0) - Math.abs(Number(a.contracts) || 0)
  );
  const p = sorted[0];
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

/**
 * @param {boolean} [opts.preflight]  Run every guard and return the plan
 *   WITHOUT sending anything. Independent of config.dryRun, which is a
 *   deployment-wide setting; this is per call.
 * @param {boolean} [opts.ignoreOpenPosition]  Evaluate as though the symbol
 *   were already flat, so a reversal can ask whether it could open the other
 *   side BEFORE it gives up the position that is open.
 */
async function executeTrade(request, { config, dedupe, breaker = null, logger = console, requestId, preflight = false, ignoreOpenPosition = false }) {
  const { exchange, exchangeId, symbol, side, reduceOnly, clientOrderId } = request;

  const key = dedupeKey({ exchangeId, symbol, side, reduceOnly, clientOrderId });
  // A preflight neither consumes nor fills the dedupe slot: it sends no
  // order, and recording one would make the real attempt that follows look
  // like a duplicate and be dropped.
  const cached = preflight ? null : dedupe.get(key);
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

  const book = await fetchPositionBook(exchange, market, logger);
  const { totalKnown } = book;
  let largestPosition = book.position;
  let sides = book.sides;
  let totalNotional = book.totalNotional;

  // "Could I open the other side once this one is closed?" has to be asked
  // WITHOUT the position that is about to go: it is both what the flip guard
  // refuses on, and part of the cross exposure the liquidation check measures.
  // Without this the answer is always no, and a reversal could never check
  // itself before giving up a position.
  if (ignoreOpenPosition) {
    const closing = largestPosition ? Math.abs(Number(largestPosition.notional) || 0) : 0;
    totalNotional = Math.max(0, totalNotional - closing);
    sides = { buy: null, sell: null, largest: null };
    largestPosition = null;
  }

  // Which position this order acts on. Opening touches the SAME side; a
  // reduceOnly close touches the OPPOSITE one (selling closes a long). In
  // one-way mode there is only ever one, so the distinction collapses.
  const positionSide = reduceOnly ? (side === 'buy' ? 'sell' : 'buy') : side;
  const position = config.hedgeMode ? sides[positionSide] : largestPosition;

  // Under cross, every open position shares one margin pool, so a guard that
  // cannot see the whole book cannot compute the distance to liquidation. When
  // real orders are being sent, refusing beats guessing low.
  if (config.marginMode === 'cross' && !totalKnown && !config.dryRun && !reduceOnly) {
    throw new RequestError(
      'Refusing to open a cross-margin position: total open exposure could not be read, so the '
      + 'distance to liquidation cannot be established. Closing with reduceOnly still works.',
      502
    );
  }

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
    // Flip protection. In one-way mode a new order against an open position
    // would silently reverse it — closing the old one and opening a new one in
    // the opposite direction, at twice the size intended. Hedge accounts hold
    // both directions by design, so the guard would refuse the very thing that
    // mode exists for.
    if (!config.hedgeMode && sides.largest && sides.largest.side !== side) {
      throw new RequestError(
        `An opposite ${sides.largest.side} position is open on ${symbol}. Close it first with reduceOnly before opening a ${side}. `
        + 'Set HEDGE_MODE=true to hold both directions at once.',
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

    // One percentage cannot clear every market's floor on a small balance, so
    // optionally lift an undersized order to the smallest the market accepts
    // rather than refusing it. This only ever raises the size, and every guard
    // below still runs on the raised number — the position cap and the
    // liquidation check are what stop it going somewhere silly.
    if (config.minNotionalBump) {
      const floor = minimumTradeableAmount({ market, price, minNotional: config.minOrderNotional });
      if (floor > sized.rawAmount) {
        const raised = notionalOf({ amount: floor, price, market });
        logger.log(
          `[${requestId}] size raised to the ${symbol} minimum: `
          + `${sized.rawAmount.toPrecision(4)} -> ${floor} ${market.base} `
          + `(${sized.notionalQuote.toFixed(2)} -> ${raised.toFixed(2)} notional)`
        );
        sized.rawAmount = floor;
        sized.notionalQuote = raised;
      }
    }

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

    assertWithinMarketLimits({ market, amount, notionalQuote, minNotional: config.minOrderNotional });

    // Two ceilings, and the tighter one wins.
    //
    // A fixed figure does not survive the account growing: it refuses rather
    // than clamps, so the day 5% of the balance exceeds it every trade starts
    // failing and nothing says why except a number you set months earlier.
    // MAX_POSITION_PERCENT scales on its own and never needs revisiting; the
    // fixed cap remains useful as an absolute disaster ceiling.
    const equity = readAccountEquity(balance, currency);
    const ceilings = [];
    if (config.maxPositionNotional !== null) {
      ceilings.push({ limit: config.maxPositionNotional, why: `the fixed cap of ${config.maxPositionNotional}` });
    }
    if (config.maxPositionPercent !== null && equity > 0) {
      // A percentage of a small account can land below the smallest order the
      // market will accept — 10% of $8 is $0.80 against a $25 minimum. Taken
      // literally that is not a position limit, it is a ban on trading at all,
      // and it would arrive as a confusing refusal on every symbol.
      //
      // So the market's own floor raises this ceiling. The result is a setting
      // that means "at most X% of the account, or the smallest tradeable order
      // if that is larger" — which behaves sensibly from the first $10 to the
      // last $100,000 without ever being retuned. What stops a floor-sized
      // order being reckless is the liquidation guard, which is ratio-based
      // and scales on its own.
      //
      // MAX_POSITION_NOTIONAL_QUOTE is deliberately NOT raised this way: a
      // fixed cap is how you say "never put more than $X into one symbol",
      // and excluding markets whose minimum exceeds it is the point of it.
      const pctLimit = equity * (config.maxPositionPercent / 100);
      const marketFloor = notionalOf({
        amount: minimumTradeableAmount({ market, price, minNotional: config.minOrderNotional }),
        price,
        market,
      });
      ceilings.push({
        limit: Math.max(pctLimit, marketFloor),
        why: pctLimit >= marketFloor
          ? `${config.maxPositionPercent}% of a ${equity.toFixed(2)} account`
          : `the ${symbol} minimum order of ${marketFloor.toFixed(2)}, which is already above `
            + `${config.maxPositionPercent}% of a ${equity.toFixed(2)} account`,
      });
    }

    if (ceilings.length > 0) {
      const tightest = ceilings.reduce((a, b) => (b.limit < a.limit ? b : a));
      const existing = position ? position.notional : 0;
      const projected = existing + notionalQuote;
      if (projected > tightest.limit) {
        throw new RequestError(
          `Order would take ${symbol} exposure to ${projected.toFixed(2)}, over ${tightest.why} `
          + `(${tightest.limit.toFixed(2)}). Existing position: ${existing.toFixed(2)}.`,
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
    hedgeMode: config.hedgeMode === true,
    positionSide: config.hedgeMode ? positionSide : null,
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
      // The WHOLE book under cross, because all of it draws on the same
      // balance. Only this symbol's position under isolated, where each
      // position stands on the margin posted for it alone.
      existingNotional: config.marginMode === 'cross'
        ? totalNotional
        : (position ? position.notional : 0),
      // The exchange's own rate when ccxt reports one, otherwise the
      // configured floor. Whichever is harsher wins: understating maintenance
      // margin would overstate how far liquidation is.
      maintenanceMarginRate: Math.max(
        Number(market.maintenanceMarginRate) || 0,
        config.maintenanceMarginRate
      ),
    });
  }

  // Every guard above has passed, which is the whole question a preflight
  // asks. It stops here and records nothing.
  if (preflight) return { success: true, preflight: true, plan };

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

  // Hedge accounts need to be told WHICH of the two positions an order acts
  // on. Bybit uses positionIdx: 1 for the long, 2 for the short — and it
  // follows the position, not the order, so a reduceOnly sell closing a long
  // is still index 1.
  //
  // Only sent for exchanges whose convention is known. Guessing for another
  // venue could open a short where a long was meant, so an unknown one is
  // refused rather than sent blind.
  if (config.hedgeMode) {
    if (exchangeId === 'bybit') {
      params.positionIdx = positionSide === 'buy' ? 1 : 2;
    } else {
      throw new RequestError(
        `HEDGE_MODE is on but the side index convention for ${exchangeId} is not known here, `
        + 'so an order could open the wrong direction. Turn HEDGE_MODE off for this exchange.',
        501
      );
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
  readAccountEquity,
  usableStopPercent,
  minimumTradeableAmount,
  resolvePrice,
  marginCurrency,
  notionalOf,
  dedupeKey,
};

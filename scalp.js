'use strict';

/**
 * Which symbols are worth trading intraday today, and at what holding time.
 *
 * ---------------------------------------------------------------------------
 * Why this is a cost measurement and not a forecast
 * ---------------------------------------------------------------------------
 *
 * The obvious build is "rank symbols by how much they will move". That is a
 * prediction, it is very hard, and a confident-looking wrong answer is exactly
 * what this codebase has produced twice in one afternoon.
 *
 * The question this answers instead is arithmetic: does a typical move at a
 * given holding time cover what a round trip costs? On Weex, measured live:
 *
 *     taker 8bp per side = 16bp round trip
 *     maker 2bp per side =  4bp round trip
 *     typical 1-minute range, crypto majors: 4 to 8bp
 *
 * So one-minute taker scalping loses to its own fees on every symbol on the
 * board — the best was a ratio of 0.5. No ranking rescues that, and a panel
 * that ranked symbols without showing it would have recommended trades that
 * cannot win. The cost ratio is therefore the gate, not a column.
 *
 * ---------------------------------------------------------------------------
 * The capture factor, and why it is not 1
 * ---------------------------------------------------------------------------
 *
 * A bar's high-to-low range is not profit. Nobody buys the low and sells the
 * high; a good intraday fill takes some fraction of the range. Using the full
 * range as if it were capturable inflates every ratio by two to three times,
 * which is the same flattering-figure mistake as quoting P&L before fees.
 *
 * So the assumption is named, applied, and reported. CAPTURE = 0.4 is a
 * deliberately unkind default: better to skip a tradeable symbol than to
 * recommend an untradeable one.
 */

const CAPTURE = 0.4;

/** Below this, a typical move does not clear its own costs by enough to bother. */
const MIN_RATIO = 3;

/** US cash session in UTC minutes from midnight: 13:30 to 20:00. */
const US_OPEN_MIN = 13 * 60 + 30;
const US_CLOSE_MIN = 20 * 60;

/**
 * Bases that are stock trackers rather than crypto.
 *
 * Kept as an explicit list because there is no flag on the market object to
 * ask: ccxt reports MSTR/USDT:USDT as an ordinary linear swap, identical in
 * shape to DOGE/USDT:USDT. The difference only shows up in behaviour — one of
 * them stops moving when New York closes.
 */
const STOCK_BASES = new Set([
  'MSTR', 'NVDA', 'TSLA', 'AAPL', 'COIN', 'HOOD', 'AMD', 'META', 'GOOGL', 'GOOG',
  'AMZN', 'MSFT', 'SPY', 'QQQ', 'CRCL', 'GME', 'PLTR', 'NFLX', 'AVGO', 'SBET',
  'BMNR', 'IBIT', 'TSM', 'BABA', 'INTC', 'MARA', 'RIOT',
]);

function median(values) {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!clean.length) return NaN;
  const mid = clean.length >> 1;
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

function baseOf(symbol) {
  // "1000PEPE/USDT:USDT" -> PEPE. The 1000x wrappers are the same asset.
  return String(symbol || '').split('/')[0].toUpperCase().replace(/^1000+/, '');
}

function isStockPerp(symbol) {
  return STOCK_BASES.has(baseOf(symbol));
}

/**
 * Whether the US cash session is open, and therefore whether a stock perp's
 * recent bars mean anything.
 *
 * Outside the session a stock tracker still prints bars; they are just flat.
 * Measured at 22:34 UTC, NVDA and TSLA showed a typical one-minute range of
 * 0.8bp against MSTR's 7.1 — not because they are worse symbols, but because
 * New York was shut. Ranking them together would have buried every stock at
 * the bottom of the list all night and then flipped the order at 13:30.
 *
 * Holidays are not modelled: a flat session reads as a low score, which is the
 * correct conclusion by a different route.
 */
function usSessionOpen(now = Date.now()) {
  const d = new Date(now);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return mins >= US_OPEN_MIN && mins < US_CLOSE_MIN;
}

/** The typical move of a bar, in basis points, from CLOSED bars only. */
function medianRangeBps(candles) {
  if (!Array.isArray(candles) || !candles.length) return NaN;
  return median(candles.map((c) => {
    const { h, l, c: close } = c;
    if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(close) || close <= 0) return NaN;
    return ((h - l) / close) * 10000;
  }));
}

/**
 * The spread, in basis points, and the mid.
 *
 * It used to return the size resting at the touch as well, and the panel
 * showed it as "book $720". That number was worse than useless: the best price
 * level is ONE level, it empties and refills second by second, and XRP read
 * $720 and $3,645 minutes apart while its whole bid side held $475 million.
 * What can actually be filled is fillCost's job, and it is the only depth
 * figure reported now.
 */
function readBook(book) {
  const bid = book && book.bids && book.bids[0];
  const ask = book && book.asks && book.asks[0];
  if (!bid || !ask || !Number.isFinite(bid[0]) || !Number.isFinite(ask[0])) {
    return { spreadBps: NaN, mid: NaN };
  }
  const mid = (bid[0] + ask[0]) / 2;
  if (!(mid > 0) || ask[0] < bid[0]) return { spreadBps: NaN, mid: NaN };
  return { spreadBps: ((ask[0] - bid[0]) / mid) * 10000, mid };
}

/**
 * What it costs to fill `notionalUsd` by crossing the book, in bps from mid.
 *
 * This replaces reading the top of the book, which was a mistake: the best
 * price level is ONE level, it empties and refills second by second, and it
 * answers a question nobody asked. Measured minutes apart, XRP's top of book
 * read $720 and then $3,645 while its whole bid side held $475 million. A $50
 * order was being refused on the basis of that flicker.
 *
 * Walking the book instead answers the real question — what does my size
 * actually cost to trade — and the answer is a cost in basis points, which
 * belongs in the same arithmetic as the spread and the fee rather than in a
 * separate pass/fail test beside it.
 *
 * Both sides are walked and the answer is the ROUND TRIP: what you pay to buy
 * minus what you get back selling. Measuring each side against the mid instead
 * looked equivalent and is not — a lopsided book drags the mid toward the
 * thicker side, so a one-sided measurement confuses "this book is wide" with
 * "the mid is off-centre". The difference between the two fills has no such
 * problem, and it is the number you actually pay.
 *
 * For a symmetric book with no impact it comes out at exactly the spread,
 * which is what the spread-only version computed before size was considered.
 */
function fillCost(book, notionalUsd) {
  const { mid } = readBook(book);
  if (!Number.isFinite(mid) || !(notionalUsd > 0)) {
    return { roundTripBps: NaN, fillableUsd: NaN };
  }

  const walk = (levels) => {
    let need = notionalUsd;
    let spent = 0;
    let base = 0;
    for (const level of levels || []) {
      const p = Number(level && level[0]);
      const a = Number(level && level[1]);
      if (!Number.isFinite(p) || !Number.isFinite(a) || p <= 0 || a <= 0) continue;
      const take = Math.min(p * a, need);
      spent += take;
      base += take / p;
      need -= take;
      if (need <= 0) break;
    }
    if (base <= 0) return { avg: NaN, filled: 0 };
    return { avg: spent / base, filled: spent };
  };

  const buy = walk(book && book.asks);
  const sell = walk(book && book.bids);
  if (!Number.isFinite(buy.avg) || !Number.isFinite(sell.avg)) {
    return { roundTripBps: NaN, fillableUsd: Math.min(buy.filled, sell.filled) };
  }

  return {
    roundTripBps: ((buy.avg - sell.avg) / mid) * 10000,
    fillableUsd: Math.min(buy.filled, sell.filled),
  };
}

/**
 * Score one symbol at one holding time.
 *
 * Both a maker and a taker verdict are returned rather than one. The gap
 * between them is the cost of impatience, and on Weex it is fourfold — a
 * bigger lever than the choice of symbol, so it should not be hidden behind a
 * configuration default the user never sees.
 */
function scoreSymbol({ symbol, candles, book, takerBps, makerBps, orderUsd = 0, now = Date.now() }) {
  const moveBps = medianRangeBps(candles);
  const { spreadBps } = readBook(book);
  const stock = isStockPerp(symbol);
  const sessionOpen = stock ? usSessionOpen(now) : true;

  const capturable = moveBps * CAPTURE;

  // What crossing the book actually costs at this size. Falls back to half the
  // spread per side when no size was given, which is the same arithmetic for
  // an order small enough to fill at the touch.
  const { roundTripBps, fillableUsd } = fillCost(book, orderUsd);
  // With no size given, crossing once each way costs the spread — the same
  // arithmetic for an order small enough to fill at the touch.
  const crossBps = Number.isFinite(roundTripBps) ? roundTripBps : spreadBps;

  const takerCostBps = crossBps + 2 * takerBps;
  // A maker entry does not cross the book at all — that is the point of
  // resting. Charging it the spread would understate the advantage that
  // matters most on this venue.
  const makerCostBps = 2 * makerBps;

  const takerRatio = capturable / takerCostBps;
  const makerRatio = capturable / makerCostBps;

  const reasons = [];
  if (!Number.isFinite(moveBps)) reasons.push('no candles');
  if (!Number.isFinite(spreadBps)) reasons.push('no book');
  if (stock && !sessionOpen) reasons.push('US market closed');
  if (Number.isFinite(makerRatio) && makerRatio < MIN_RATIO) reasons.push('move does not cover costs');
  // Thin means the whole book cannot absorb the order, not that the best
  // price level happened to be small when we looked.
  if (orderUsd > 0 && Number.isFinite(fillableUsd) && fillableUsd < orderUsd) reasons.push('thin at your size');

  return {
    symbol,
    stock,
    sessionOpen,
    bars: Array.isArray(candles) ? candles.length : 0,
    moveBps,
    capturableBps: capturable,
    spreadBps,
    crossBps,
    fillableUsd,
    takerCostBps,
    makerCostBps,
    takerRatio,
    makerRatio,
    capture: CAPTURE,
    tradeable: reasons.length === 0,
    reasons,
  };
}

/**
 * Rank scored symbols, best first.
 *
 * Ranked on the MAKER ratio because that is the way the panel tells you to
 * trade: a limit order that rests. Ranking on taker would put the order of the
 * list at odds with the order button underneath it.
 *
 * Symbols that cannot be traded at all still come back, last, with their
 * reason — a dimmed row that says "US market closed" is information, whereas a
 * symbol silently missing from the list looks like it was never considered.
 */
function rankScores(scores) {
  const value = (s) => (Number.isFinite(s.makerRatio) ? s.makerRatio : -Infinity);
  return [...(scores || [])].sort((a, b) => {
    if (a.tradeable !== b.tradeable) return a.tradeable ? -1 : 1;
    return value(b) - value(a);
  });
}

module.exports = {
  scoreSymbol, rankScores, medianRangeBps, readBook, fillCost, isStockPerp, usSessionOpen, median, baseOf,
  CAPTURE, MIN_RATIO,
};

/* ------------------------------------------------------------------ *
 * Sweeping a venue
 * ------------------------------------------------------------------ */

/**
 * Score a list of symbols at one holding time.
 *
 * Two requests per symbol — candles and the book — which is why `concurrency`
 * exists and defaults low. The supertrend scanner was rate-limited off Bybit
 * by issuing roughly nineteen fetches a minute; this panel would issue sixty
 * in a burst if it asked for everything at once, and a ranker that gets itself
 * banned is worse than no ranker.
 *
 * A symbol whose read fails comes back scored as unmeasurable rather than
 * being dropped, so a venue having a bad minute cannot quietly shrink the
 * list and make the survivors look like the whole market.
 */
async function sweepSymbols({
  exchange, symbols, timeframe = '15m', bars = 150, orderUsd = 0,
  concurrency = 3, depthLimit = 50, now = Date.now(), logger = console,
}) {
  const queue = [...(symbols || [])];
  const out = [];

  const feesFor = (symbol) => {
    const m = exchange.markets && exchange.markets[symbol];
    return {
      takerBps: Number.isFinite(m && m.taker) ? m.taker * 10000 : 8,
      makerBps: Number.isFinite(m && m.maker) ? m.maker * 10000 : 2,
    };
  };

  async function worker() {
    for (;;) {
      const symbol = queue.shift();
      if (!symbol) return;
      try {
        const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, bars);
        const book = await exchange.fetchOrderBook(symbol, depthLimit);
        const tfMs = timeframeMs(exchange, timeframe);
        const candles = dropForming(toRows(ohlcv), tfMs, now);
        out.push(scoreSymbol({ symbol, candles, book, orderUsd, now, ...feesFor(symbol) }));
      } catch (err) {
        logger.warn(`[scalp] ${symbol}: ${err.message}`);
        out.push({
          ...scoreSymbol({ symbol, candles: [], book: null, orderUsd, now, ...feesFor(symbol) }),
          reasons: [`could not read: ${err.message}`],
        });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return rankScores(out);
}

function toRows(ohlcv) {
  return (ohlcv || []).map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
}

function dropForming(rows, tfMs, now) {
  if (!rows.length) return rows;
  const last = rows[rows.length - 1];
  return last.t + tfMs > now ? rows.slice(0, -1) : rows;
}

function timeframeMs(exchange, timeframe) {
  const ms = exchange.parseTimeframe(timeframe) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`Unrecognised timeframe "${timeframe}".`);
  return ms;
}

module.exports.sweepSymbols = sweepSymbols;

/**
 * The default list to rank.
 *
 * Crypto majors that actually move, plus the stock trackers Weex lists. Kept
 * short on purpose: each symbol costs two requests, and a list of two hundred
 * would be a rate limit waiting to happen for the sake of symbols whose books
 * are too thin to trade anyway.
 */
const DEFAULT_UNIVERSE = [
  'BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'DOGE/USDT:USDT',
  'XRP/USDT:USDT', 'BNB/USDT:USDT', 'ADA/USDT:USDT', 'AVAX/USDT:USDT',
  'LINK/USDT:USDT', 'LTC/USDT:USDT', 'DOT/USDT:USDT', 'TRX/USDT:USDT',
  'MSTR/USDT:USDT', 'NVDA/USDT:USDT', 'TSLA/USDT:USDT', 'AAPL/USDT:USDT',
  'COIN/USDT:USDT', 'META/USDT:USDT', 'AMZN/USDT:USDT', 'GOOGL/USDT:USDT',
  'SPY/USDT:USDT', 'QQQ/USDT:USDT', 'PLTR/USDT:USDT', 'HOOD/USDT:USDT',
];

module.exports.DEFAULT_UNIVERSE = DEFAULT_UNIVERSE;

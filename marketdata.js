'use strict';

/**
 * Read-only market data, proxied from the exchanges the server is already
 * connected to.
 *
 * The chart draws crypto from Coinbase, Binance and CoinGecko, none of which
 * list the tokenised-stock perpetuals (MSTRUSDT.P, QQQUSDT.P and the like)
 * that Bybit and Weex do. And a browser cannot fetch them from Bybit directly:
 * the same CloudFront geo-block that stops this machine reaching api.bybit.com
 * stops the page doing it too.
 *
 * The server has neither problem — it is in Frankfurt with credentials and
 * loaded markets — so it can hand the page candles for any symbol either
 * exchange lists. That also means a symbol you can chart is, by construction,
 * a symbol you can trade: the same market object backs both.
 */

const { RequestError } = require('./trading');

/** ccxt timeframes the app's RANGES table can ask for. */
const VALID_TIMEFRAMES = new Set([
  '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '1w', '1M',
]);

function resolveExchange(exchanges, name) {
  const id = String(name || '').trim().toLowerCase();
  const exchange = exchanges[id];
  if (!exchange) {
    throw new RequestError(
      `Exchange "${name}" is not configured. Available: ${Object.keys(exchanges).join(', ') || 'none'}.`
    );
  }
  return exchange;
}

/**
 * Markets whose symbol or base currency matches, most tradeable first.
 *
 * Ranked rather than alphabetical: "MSTR" should surface MSTR/USDT:USDT ahead
 * of any market that merely contains those letters, or the useful answer is
 * buried under near-misses.
 */
function searchMarkets(exchange, query, limit = 40) {
  const q = String(query || '').trim().toUpperCase();
  if (q.length < 1) {
    throw new RequestError('"q" must be at least 1 character.');
  }

  const hits = [];
  for (const market of Object.values(exchange.markets || {})) {
    if (!market || market.active === false) continue;

    const symbol = String(market.symbol || '');
    const base = String(market.base || '').toUpperCase();
    const upper = symbol.toUpperCase();
    if (!upper.includes(q) && !base.includes(q)) continue;

    // Exact base match first, then a symbol that starts with the query, then
    // anything else that merely contains it.
    // Searching "BTC" on Bybit matches the USDT perp, the USDC perp, the
    // inverse coin-margined contract and the spot pair. They are different
    // instruments at different prices, and only the USDT-settled swap is the
    // one this app can size and trade, so it ranks first rather than being
    // one of four indistinguishable rows.
    const tradeable = market.type === 'swap' && market.settle === 'USDT' ? 0 : 1;
    const rank = (base === q ? 0 : upper.startsWith(q) ? 2 : 4) + tradeable;
    hits.push({ rank, market });
  }

  hits.sort((a, b) => a.rank - b.rank || a.market.symbol.localeCompare(b.market.symbol));

  return hits.slice(0, limit).map(({ market }) => ({
    symbol: market.symbol,
    base: market.base,
    quote: market.quote,
    settle: market.settle ?? null,
    type: market.type ?? null,
    // The page needs these to know what it can afford before it offers a
    // Trade button, and they are the numbers that differ most between venues.
    precision: Number(market.precision?.amount) || null,
    minAmount: Number(market.limits?.amount?.min) || null,
    minCost: Number(market.limits?.cost?.min) || null,
  }));
}

/**
 * OHLCV in the {t,o,h,l,c,v} shape the chart's own fetchers return, so a
 * proxied symbol renders through exactly the same path as a Coinbase one.
 */
async function fetchCandles(exchange, { symbol, timeframe, limit = 500 }) {
  if (typeof symbol !== 'string' || !symbol.trim()) {
    throw new RequestError('"symbol" is required.');
  }
  if (!VALID_TIMEFRAMES.has(timeframe)) {
    throw new RequestError(
      `"timeframe" must be one of: ${[...VALID_TIMEFRAMES].join(', ')}.`
    );
  }
  if (!exchange.has?.fetchOHLCV) {
    throw new RequestError(`${exchange.id} cannot serve candles through ccxt.`, 501);
  }

  let market;
  try {
    market = exchange.market(symbol.trim());
  } catch {
    throw new RequestError(`Symbol "${symbol}" is not listed on ${exchange.id}.`);
  }

  const capped = Math.min(Math.max(Number(limit) || 500, 10), 1000);

  let rows;
  try {
    rows = await exchange.fetchOHLCV(market.symbol, timeframe, undefined, capped);
  } catch (err) {
    // The exchange refusing is the caller's problem to see, not a 500: an
    // unsupported timeframe on one venue is a normal answer, not a fault.
    throw new RequestError(`${exchange.id} could not serve ${market.symbol} ${timeframe}: ${err.message}`, 502);
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new RequestError(`${exchange.id} returned no candles for ${market.symbol} ${timeframe}.`, 502);
  }

  const candles = rows
    .map(([t, o, h, l, c, v]) => ({ t: Number(t), o: +o, h: +h, l: +l, c: +c, v: +v }))
    // A row with a non-finite price would draw a gap the chart cannot scale.
    .filter((k) => [k.t, k.o, k.h, k.l, k.c].every(Number.isFinite));

  if (candles.length === 0) {
    throw new RequestError(`${exchange.id} returned only unusable rows for ${market.symbol}.`, 502);
  }

  return {
    src: exchange.id,
    symbol: market.symbol,
    timeframe,
    candles,
  };
}

/**
 * The smallest order this market will accept, in quote currency.
 *
 * The number worth showing next to a search result, because it is the one
 * that differs most between venues and decides whether you can afford the
 * symbol at all: SUI floors around $5 on Bybit and $82.89 on Weex, purely
 * because the lot step is 10 SUI there.
 */
function minNotionalOf(market, price) {
  const step = Number(market.precision) || Number(market.minAmount) || 0;
  const lotValue = Number.isFinite(price) && price > 0 ? step * price : 0;
  const declared = Number(market.minCost) || 0;
  const floor = Math.max(lotValue, declared);
  return floor > 0 ? floor : null;
}

/**
 * Searches every configured exchange at once.
 *
 * The same ticker can list on both venues with very different minimums, so a
 * result is only meaningful with its exchange and price attached — and the
 * two are not interchangeable afterwards: a symbol added from Bybit does not
 * necessarily trade on Weex.
 */
async function searchAcrossExchanges(exchanges, query, { limit = 40, logger = console } = {}) {
  const perExchange = Math.max(5, Math.ceil(limit / Math.max(1, Object.keys(exchanges).length)));

  const found = [];
  for (const [id, exchange] of Object.entries(exchanges)) {
    let hits;
    try {
      hits = searchMarkets(exchange, query, perExchange);
    } catch (err) {
      if (err instanceof RequestError) throw err;   // a bad query is a bad query
      logger.warn(`[markets] ${id} search failed: ${err.message}`);
      continue;
    }
    found.push({ id, exchange, hits });
  }

  // One bulk ticker call per exchange for the symbols we are about to show,
  // rather than one call per result. A venue that cannot price them still
  // returns its markets — a null price is worth more than no result.
  await Promise.all(found.map(async (group) => {
    if (group.hits.length === 0 || !group.exchange.has?.fetchTickers) return;

    // Grouped by market type, because Bybit's API is split into spot / linear
    // / inverse categories and a single fetchTickers mixing them is rejected
    // outright — which is why every result came back unpriced, and every
    // symbol added at a placeholder price of 1.
    const byType = new Map();
    for (const hit of group.hits) {
      const key = hit.type || 'unknown';
      if (!byType.has(key)) byType.set(key, []);
      byType.get(key).push(hit);
    }

    await Promise.all([...byType.values()].map(async (hits) => {
      try {
        const tickers = await group.exchange.fetchTickers(hits.map((m) => m.symbol));
        for (const hit of hits) {
          const t = tickers?.[hit.symbol];
          const px = Number(t?.last ?? t?.close ?? t?.mark ?? t?.bid ?? t?.ask);
          if (Number.isFinite(px) && px > 0) hit.price = px;
        }
      } catch (err) {
        logger.warn(`[markets] ${group.id} could not price ${hits[0]?.type} results: ${err.message}`);
      }
    }));
  }));

  const rows = [];
  for (const group of found) {
    for (const hit of group.hits) {
      rows.push({
        exchange: group.id,
        ...hit,
        price: hit.price ?? null,
        minNotional: minNotionalOf(hit, hit.price),
      });
    }
  }

  // Same ticker from two venues sits together, cheapest minimum first, so the
  // affordable one is the obvious pick.
  rows.sort((a, b) => a.base.localeCompare(b.base)
    || (a.minNotional ?? Infinity) - (b.minNotional ?? Infinity)
    || a.exchange.localeCompare(b.exchange));

  return rows.slice(0, limit);
}

module.exports = {
  searchMarkets,
  searchAcrossExchanges,
  minNotionalOf,
  fetchCandles,
  resolveExchange,
  VALID_TIMEFRAMES,
};

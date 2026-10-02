'use strict';

/**
 * Candles for measuring: how much history every backtest on this server uses.
 *
 * 4,000 bars, the depth the app always paged to for coins it charts from
 * Coinbase or Binance. Measured on 1,000 instead, a setting could top the
 * Auto-trader on 13 trades and come out average over 53 — the screens
 * disagreed with the deeper test (BTC 6H: 86 on 1,000 bars, 58 on 4,000).
 * One depth everywhere, the deeper one.
 *
 * A coin younger than 4,000 bars on a timeframe gets all the history it has;
 * the sweep's own sample-size penalty ranks its thin timeframes down.
 */

const DEEP_BARS = 4000;
const PAGE = 1000;          // Bybit's most per request

/**
 * The last `bars` candles. Up to one page, a single request; more, paged
 * forward from where that many bars would start, de-duplicated on time.
 */
async function candlesFor(exchange, symbol, timeframe, bars = DEEP_BARS, now = Date.now()) {
  const toCandle = ([t, o, h, l, c, v]) => ({ t, o, h, l, c, v });
  if (bars <= PAGE) {
    const raw = await exchange.fetchOHLCV(symbol, timeframe, undefined, bars);
    return (raw || []).map(toCandle);
  }
  const tfMs = (Number(exchange.parseTimeframe ? exchange.parseTimeframe(timeframe) : 0) || 60) * 1000;
  const byTime = new Map();
  let since = now - bars * tfMs;
  for (let page = 0; page < Math.ceil(bars / PAGE) + 1; page += 1) {
    const raw = await exchange.fetchOHLCV(symbol, timeframe, since, PAGE);
    if (!raw || !raw.length) break;
    for (const row of raw) byTime.set(row[0], row);
    const last = raw[raw.length - 1][0];
    if (raw.length < PAGE || last + tfMs > now) break;
    since = last + tfMs;
  }
  return [...byTime.values()].sort((a, b) => a[0] - b[0]).slice(-bars).map(toCandle);
}

module.exports = { candlesFor, DEEP_BARS, PAGE };

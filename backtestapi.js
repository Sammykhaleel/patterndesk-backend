'use strict';

/**
 * Best TF and ST Test, computed here instead of on the phone.
 *
 * For an exchange-listed symbol the app already fetched its history from this
 * server — 1,000 bars per timeframe through /api/candles — and then swept it
 * on the device: eleven round trips one after another, and the arithmetic on
 * a phone. Here the candles are a local call away, the timeframes are fetched
 * a few at a time, and the answer is one response.
 *
 * Same data (1,000 bars from the same exchange) and the same code
 * (vendor/supertrend-backtest.js is the app's, checked by a test), so the
 * numbers are the ones the app would have computed — just sooner.
 *
 * Results are cached briefly: opening the same chart twice, or two devices on
 * the same symbol, costs one computation.
 */

const { RequestError } = require('./trading');
const { loadModules, TIMEFRAMES } = require('./tuning');

const { candlesFor, DEEP_BARS } = require('./history');
const MAX_BARS = DEEP_BARS;
const BEST_TF_TTL_MS = 10 * 60 * 1000;
const ST_TEST_TTL_MS = 5 * 60 * 1000;
const PARALLEL = 4;

const cache = new Map();   // key -> {at, value}
function cached(key, ttl, now) {
  const hit = cache.get(key);
  return hit && now - hit.at < ttl ? hit.value : null;
}
function remember(key, value, now) {
  cache.set(key, { at: now, value });
  // A small store: drop the oldest beyond a few hundred entries.
  if (cache.size > 300) cache.delete(cache.keys().next().value);
}

function marketOf(exchange, symbol) {
  const s = String(symbol || '').trim();
  if (!s) throw new RequestError('"symbol" is required.');
  try { return exchange.market(s).symbol || s; }
  catch { throw new RequestError(`"${s}" is not listed on ${exchange.id}.`); }
}

/** How many bars to measure on: 4,000 unless fewer are asked for. */
function barsWanted(bars) {
  const n = Math.round(Number(bars));
  return Number.isFinite(n) && n > 0 ? Math.min(Math.max(n, 100), MAX_BARS) : DEEP_BARS;
}

/** Runs `fn` over `items`, at most `n` at a time, keeping order. */
async function mapLimited(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

/**
 * Every timeframe's best setting, as Best TF shows it: the top of the sweep,
 * and where its line sits now as a percent of price.
 */
async function bestTimeframes({ exchange, symbol, timeframes = TIMEFRAMES, bars, now = Date.now }) {
  const sym = marketOf(exchange, symbol);
  const n = barsWanted(bars);
  const key = `besttf|${exchange.id}|${sym}|${n}|${timeframes.join(',')}`;
  const hit = cached(key, BEST_TF_TTL_MS, now());
  if (hit) return { ...hit, cached: true };

  const { sweepSupertrend, supertrend, recentResult } = await loadModules();
  const results = await mapLimited(timeframes, PARALLEL, async (tf) => {
    let candles;
    try { candles = await candlesFor(exchange, sym, tf, n, now()); }
    catch (err) { return { tf, best: null, error: `${exchange.id} could not serve ${tf}: ${err.message}` }; }
    if (candles.length < 30) return { tf, best: null, error: 'not enough history to measure' };
    const sweep = sweepSupertrend(candles);
    const best = sweep[0] || null;
    if (!best) return { tf, best: null, error: 'not enough flips to measure', bars: candles.length };
    const st = supertrend(candles, best.period, best.mult);
    const live = st[st.length - 1];
    const px = candles[candles.length - 1].c;
    const stopPct = live && Number.isFinite(live.v) && px ? Math.abs(px - live.v) / px * 100 : null;
    return { tf, best, stopPct, bars: candles.length, from: candles[0].t, recent: recentResult(candles, best.period, best.mult) };
  });
  const value = { symbol: sym, exchange: exchange.id, at: now(), results };
  remember(key, value, now());
  return value;
}

/**
 * ST Test for one timeframe: the current setting measured, the ranked sweep,
 * and the partial-close comparison on the current setting.
 */
async function stTest({ exchange, symbol, timeframe, period, mult, bars, now = Date.now }) {
  const sym = marketOf(exchange, symbol);
  const n = barsWanted(bars);
  if (!TIMEFRAMES.includes(timeframe)) throw new RequestError(`"timeframe" must be one of: ${TIMEFRAMES.join(', ')}.`);
  const p = Number(period), m = Number(mult);
  if (!Number.isInteger(p) || p < 2 || p > 200) throw new RequestError('"period" must be a whole number from 2 to 200.');
  if (!Number.isFinite(m) || m <= 0 || m > 20) throw new RequestError('"mult" must be above 0 and at most 20.');

  const key = `sttest|${exchange.id}|${sym}|${n}|${timeframe}|${p}|${m}`;
  const hit = cached(key, ST_TEST_TTL_MS, now());
  if (hit) return { ...hit, cached: true };

  const { backtestSupertrend, sweepSupertrend, comparePartials } = await loadModules();
  let candles;
  try { candles = await candlesFor(exchange, sym, timeframe, n, now()); }
  catch (err) { throw new RequestError(`${exchange.id} could not serve ${sym} ${timeframe}: ${err.message}`, 502); }
  const cur = candles.length ? backtestSupertrend(candles, p, m) : null;
  if (!cur) throw new RequestError('not enough flips in the available history to measure', 422);
  const value = {
    symbol: sym, exchange: exchange.id, timeframe, period: p, mult: m, at: now(),
    bars: candles.length, first: candles[0].t, last: candles[candles.length - 1].t,
    cur,
    // The app shows the top five; a few more cost nothing.
    sweep: sweepSupertrend(candles).slice(0, 10),
    partials: comparePartials(candles, p, m),
  };
  remember(key, value, now());
  return value;
}

/**
 * The Lineup's measurement of one symbol (tuning.js measureSymbol): every
 * timeframe's best with its side and stop, the running setting scored, and
 * the partial-close comparison on it. The phone's Lineup asks for this
 * instead of sweeping eleven timeframes itself.
 */
async function measure({ exchange, symbol, timeframe, period, mult, now = Date.now }) {
  const sym = marketOf(exchange, symbol);
  let setting = null;
  if (timeframe != null && timeframe !== '') {
    if (!TIMEFRAMES.includes(timeframe)) throw new RequestError(`"timeframe" must be one of: ${TIMEFRAMES.join(', ')}.`);
    const p = Number(period), m = Number(mult);
    if (!Number.isInteger(p) || p < 2 || p > 200) throw new RequestError('"period" must be a whole number from 2 to 200.');
    if (!Number.isFinite(m) || m <= 0 || m > 20) throw new RequestError('"mult" must be above 0 and at most 20.');
    setting = { timeframe, period: p, mult: m };
  }
  const key = `measure|${exchange.id}|${sym}|${setting ? `${setting.timeframe} ${setting.period}/${setting.mult}` : '-'}`;
  const hit = cached(key, BEST_TF_TTL_MS, now());
  if (hit) return { ...hit, cached: true };
  const { measureSymbol } = require('./tuning');
  const value = await measureSymbol({ exchange, symbol: sym, setting, now, parallel: PARALLEL });
  remember(key, value, now());
  return value;
}

module.exports = { bestTimeframes, stTest, measure, candlesFor, _cache: cache };

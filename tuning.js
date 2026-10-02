'use strict';

/**
 * The tuning check, on the server.
 *
 * The app's Lineup measured each symbol's setting only while the site was
 * open — on a phone that is minutes at a time, so a symbol going out of tune
 * could sit unflagged for days. This does the same measuring here, on a
 * timer, whether or not anything is open:
 *
 *   - every timeframe's best setting, from the same sweep as Best TF;
 *   - the setting each symbol RUNS, scored, with its side at the last closed
 *     bar and where its line sits now;
 *   - that running setting with part of each position closed at +1/+2/+3%
 *     (the partial-close comparison, price targets only).
 *
 * The last two measurements per symbol are kept, because a verdict counts
 * only when two in a row agree. `since` is when the symbol's current setting
 * was first measured here: a symbol is not judged for a day after its
 * setting changes.
 *
 * Same code as the app (vendor/supertrend-backtest.js is a copy of
 * src/indicators/supertrend-backtest.js), and the same 1,000 bars per
 * timeframe the Lineup fetches for exchange-listed symbols, so the two agree.
 *
 * Read-only: it fetches candles and never trades. Paced, so it never crowds
 * the scanner, which shares the exchange's rate limit.
 */

const fs = require('fs');
const path = require('path');
const { candlesFor, DEEP_BARS } = require('./history');

const STATE_FILE = 'tuning-state.json';
const TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '6h', '1d', '1w', '1M'];
const BARS = DEEP_BARS;
const DEFAULT_EVERY_MS = 2 * 60 * 60 * 1000;
const DEFAULT_FIRST_MS = 3 * 60 * 1000;
const DEFAULT_PAUSE_MS = 400;

let modules = null;
async function loadModules() {
  if (modules) return modules;
  const dir = path.resolve(__dirname, 'vendor');
  const bt = await import(`file://${path.join(dir, 'supertrend-backtest.js')}`);
  const ind = await import(`file://${path.join(dir, 'indicators.js')}`);
  modules = { ...bt, supertrend: ind.supertrend };
  return modules;
}

/**
 * The single setting `symbol` runs under `settings`: its override's
 * timeframe and supertrend, or the global ones. Null when it scans several
 * timeframes (no single setting to measure) or none is known.
 */
function runningSetting(settings, symbol) {
  if (!settings) return null;
  const ov = (settings.overrides || {})[symbol] || null;
  const tuned = ov && (ov.timeframe || ov.supertrend) ? ov : null;
  const st = { ...(settings.supertrend || {}), ...((tuned && tuned.supertrend) || {}) };
  const tfs = tuned && tuned.timeframe ? [tuned.timeframe]
    : (Array.isArray(settings.timeframes) && settings.timeframes.length ? settings.timeframes : [settings.timeframe].filter(Boolean));
  if (tfs.length !== 1) return null;
  const period = Number(st.period), mult = Number(st.multiplier);
  if (!Number.isFinite(period) || !Number.isFinite(mult)) return null;
  return { timeframe: tfs[0], period, mult };
}

const settingKey = (s) => (s ? `${s.timeframe} ${s.period}/${s.mult}` : null);

/** The index of the last bar that has closed: the forming one is not a signal. */
function lastClosed(candles, tfMs, now) {
  const last = candles.length - 1;
  if (last < 0) return -1;
  return candles[last].t + tfMs > now ? last - 1 : last;
}

/** Where a setting stands now: its side at the last closed bar, and how far its line is. */
function where(supertrend, candles, period, mult, tfMs, now) {
  const st = supertrend(candles, period, mult);
  const live = st[st.length - 1];
  const px = candles[candles.length - 1].c;
  const closed = st[lastClosed(candles, tfMs, now)];
  return {
    dir: closed && (closed.dir === 1 || closed.dir === -1) ? closed.dir : null,
    stopPct: live && Number.isFinite(live.v) && px ? Math.abs(px - live.v) / px * 100 : null,
  };
}

const pick = (r) => ({
  period: r.period, mult: r.mult, score: r.score ?? null, totalPct: r.totalPct,
  profitFactor: r.profitFactor ?? null, n: r.n, maxDD: r.maxDD, winRate: r.winRate,
  buyHold: Number.isFinite(r.buyHold) ? r.buyHold : null,
});

/** One symbol, every timeframe. */
async function measureSymbol({ exchange, symbol, setting, timeframes = TIMEFRAMES, bars = BARS, now = Date.now, sleep, pauseMs = 0, logger = console }) {
  const { sweepSupertrend, backtestSupertrend, comparePartials, PARTIAL_VARIANTS, supertrend } = await loadModules();
  const rows = [];
  let running = null;
  let partials = null;
  const errors = [];
  for (const tf of timeframes) {
    let candles;
    try {
      candles = await candlesFor(exchange, symbol, tf, bars, now());
    } catch (err) {
      errors.push(`${tf}: ${err.message}`);
      if (sleep && pauseMs) await sleep(pauseMs);
      continue;
    }
    if (sleep && pauseMs) await sleep(pauseMs);
    if (candles.length < 30) continue;
    const tfMs = (Number(exchange.parseTimeframe ? exchange.parseTimeframe(tf) : 0) || 60) * 1000;
    const sweep = sweepSupertrend(candles);
    const top = sweep[0];
    if (top) rows.push({ tf, ...pick(top), ...where(supertrend, candles, top.period, top.mult, tfMs, now()) });

    if (setting && setting.timeframe === tf) {
      const own = sweep.find((x) => Number(x.period) === setting.period && Number(x.mult) === setting.mult)
        || backtestSupertrend(candles, setting.period, setting.mult);
      if (own) running = { tf, ...pick({ ...own, period: setting.period, mult: setting.mult }), ...where(supertrend, candles, setting.period, setting.mult, tfMs, now()) };
      const cmp = comparePartials(candles, setting.period, setting.mult, { variants: PARTIAL_VARIANTS.filter((v) => v.kind === 'pct') });
      if (cmp) {
        partials = {
          frac: cmp.frac, n: cmp.base.n, base: cmp.base.totalPct,
          rows: cmp.rows.map((r) => ({ pricePct: r.value, totalPct: r.totalPct, hits: r.hits, n: r.n, profitFactor: r.profitFactor ?? null })),
        };
      }
    }
  }
  if (!rows.length && errors.length) logger.warn(`[tuning] ${symbol}: no timeframe could be measured (${errors[0]})`);
  return { at: now(), key: settingKey(setting), setting, rows, running, partials };
}

function createTuningMonitor({
  getExchange, getSettings, stateDir = null,
  everyMs = DEFAULT_EVERY_MS, firstAfterMs = DEFAULT_FIRST_MS, pauseMs = DEFAULT_PAUSE_MS,
  timeframes = TIMEFRAMES, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  logger = console,
}) {
  const file = stateDir ? path.join(stateDir, STATE_FILE) : null;
  let state = { symbols: {}, lastRunAt: null, lastRunMs: null };
  if (file) {
    try { state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; }
    catch { /* first run, or unreadable: start empty */ }
  }
  let busy = false;
  let timer = null, first = null;
  let nextRunAt = null;

  function save() {
    if (!file) return;
    try {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, file);
    } catch (err) {
      logger.warn(`[tuning] could not save its results (${err.message}); they are kept in memory`);
    }
  }

  async function runOnce() {
    if (busy) return { skipped: 'already running' };
    const exchange = getExchange();
    const settings = getSettings();
    if (!exchange || !settings) return { skipped: 'no exchange or settings' };
    busy = true;
    const started = now();
    let measured = 0;
    try {
      for (const symbol of settings.symbols || []) {
        const setting = runningSetting(settings, symbol);
        let m;
        try {
          m = await measureSymbol({ exchange, symbol, setting, timeframes, now, sleep, pauseMs, logger });
        } catch (err) {
          logger.warn(`[tuning] ${symbol}: ${err.message}`);
          continue;
        }
        if (!m.rows.length) continue;
        const prior = state.symbols[symbol] || null;
        state.symbols[symbol] = {
          current: m,
          previous: prior ? prior.current : null,
          // When this setting CHANGED, as seen here: a new setting starts its
          // day of grace. 0 when it has run unchanged since the first
          // measurement — first sight is not a change, or every symbol would
          // sit ungraded for a day after each deploy.
          since: !prior || !prior.current ? 0
            : prior.current.key === m.key ? (prior.since ?? 0) : m.at,
        };
        measured += 1;
      }
      // Symbols no longer scanned are dropped, so the store does not grow.
      for (const s of Object.keys(state.symbols)) if (!(settings.symbols || []).includes(s)) delete state.symbols[s];
      state.lastRunAt = now();
      state.lastRunMs = state.lastRunAt - started;
      save();
      logger.log(`[tuning] measured ${measured} symbol(s) in ${Math.round(state.lastRunMs / 1000)}s`);
      return { measured };
    } finally {
      busy = false;
    }
  }

  function start() {
    first = setTimeout(() => { runOnce().catch((e) => logger.warn(`[tuning] ${e.message}`)); }, firstAfterMs);
    if (first.unref) first.unref();
    nextRunAt = now() + firstAfterMs;
    timer = setInterval(() => {
      nextRunAt = now() + everyMs;
      runOnce().catch((e) => logger.warn(`[tuning] ${e.message}`));
    }, everyMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (first) clearTimeout(first);
    if (timer) clearInterval(timer);
  }

  function snapshot() {
    return {
      everyMs, lastRunAt: state.lastRunAt, lastRunMs: state.lastRunMs,
      nextRunAt: busy ? null : nextRunAt, measuring: busy,
      symbols: state.symbols,
    };
  }

  return { runOnce, start, stop, snapshot, get busy() { return busy; } };
}

module.exports = { createTuningMonitor, measureSymbol, runningSetting, lastClosed, loadModules, TIMEFRAMES };

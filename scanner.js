'use strict';

/**
 * Polls candles on an interval, runs PatternDesk's own detection modules
 * against them, and hands qualifying setups to executeTrade.
 *
 * Two rules shape everything here:
 *
 *   1. Only closed candles are evaluated. The forming candle repaints, so a
 *      pattern detected on it can vanish before the bar ends — that is the
 *      single most common way a backtested edge evaporates live.
 *   2. One signal per symbol per candle. The clientOrderId is derived from
 *      symbol + timeframe + candle timestamp, so a restart, a retry, or an
 *      overlapping scan cannot open a second position on the same bar.
 *
 * The detection logic is imported from ../src, not reimplemented, so the bot
 * and the chart can never disagree about what a pattern is.
 */

const path = require('path');
const fs = require('fs');
const { executeTrade, validateTradeRequest } = require('./trading');

// The app's modules are ES modules; this package is CommonJS. Loaded lazily
// via dynamic import, which works across both.
let detectPatterns = null;
let indicators = null;

async function loadDetectors(logger = console) {
  if (detectPatterns) return;
  const vendorDir = path.resolve(__dirname, 'vendor');
  try {
    ({ detectPatterns } = await import(`file://${path.join(vendorDir, 'detect.js')}`));
    indicators = await import(`file://${path.join(vendorDir, 'indicators.js')}`);
  } catch (err) {
    throw new Error(
      `Could not load the detection modules from ${vendorDir}: ${err.message}. ` +
      `They are copied from src/patterns and src/indicators — re-copy them if they moved.`
    );
  }
  logger.log('[scanner] detection modules loaded');
}

/* ------------------------------------------------------------------ *
 * Candles
 * ------------------------------------------------------------------ */

/** ccxt OHLCV rows -> the {o,h,l,c,v,t} shape the app's modules expect. */
function toCandles(ohlcv) {
  return ohlcv.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
}

/**
 * Drops the final candle when it is still forming. ccxt returns the in-progress
 * bar as the last row; comparing its timestamp against the wall clock is the
 * only reliable way to tell, since exchanges differ on whether they include it.
 */
function dropFormingCandle(candles, timeframeMs, now = Date.now()) {
  if (candles.length === 0) return candles;
  const last = candles[candles.length - 1];
  return last.t + timeframeMs > now ? candles.slice(0, -1) : candles;
}

function timeframeToMs(exchange, timeframe) {
  const ms = exchange.parseTimeframe(timeframe) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`Unrecognised timeframe "${timeframe}".`);
  }
  return ms;
}

/* ------------------------------------------------------------------ *
 * Signal derivation
 * ------------------------------------------------------------------ */

/**
 * Turns a detection result into a trade intent, or null.
 *
 * Deliberately strict. A pattern badge alone is not a signal: it must have
 * confirmed (not "forming"), carry a measured-move projection, and clear the
 * configured risk:reward floor. Widening this is where you tune the strategy —
 * and where you can quietly destroy it, so change one condition at a time and
 * measure.
 */
function deriveSignal(candles, rules, logger = console) {
  const { badges } = detectPatterns(candles);
  if (!badges || badges.length === 0) return null;

  const confirmed = badges.filter((b) => {
    if (rules.requireConfirmed && b.status === 'forming') return false;
    if (!b.proj) return false;
    if (rules.minRR !== null && (b.proj.rr === null || b.proj.rr < rules.minRR)) return false;
    if (rules.requireFirm && !b.proj.firm) return false;
    return true;
  });

  if (confirmed.length === 0) {
    const why = badges.map((b) => `${b.name}(${b.status}${b.proj ? `, rr=${b.proj.rr?.toFixed(2)}` : ', no projection'})`);
    logger.log(`[scanner]   ${badges.length} pattern(s) seen, none qualified: ${why.join('; ')}`);
    return null;
  }

  // Strongest first by risk:reward.
  confirmed.sort((a, b) => (b.proj.rr ?? 0) - (a.proj.rr ?? 0));
  const best = confirmed[0];

  const side = best.proj.dir === 'up' ? 'buy' : 'sell';

  // Optional trend filter: refuse signals that fight the Supertrend direction.
  if (rules.requireTrendAgreement) {
    const st = indicators.supertrend(candles);
    const dir = st[st.length - 1]?.dir;
    const wanted = side === 'buy' ? 1 : -1;
    if (dir !== wanted) {
      logger.log(`[scanner]   ${best.name} ${side} rejected: Supertrend disagrees (dir=${dir})`);
      return null;
    }
  }

  return {
    side,
    pattern: best.name,
    status: best.status,
    rr: best.proj.rr,
    entry: best.proj.entry,
    stop: best.proj.stop,
    target: best.proj.target,
  };
}

/**
 * Supertrend flip as a signal.
 *
 * A different shape of strategy from the pattern detector above. That one
 * looks for a formation and waits for it to break; this fires the moment the
 * trend line flips, which is unambiguous — the indicator either changed
 * direction on the last closed bar or it did not.
 *
 * The stop writes itself: the Supertrend line IS the invalidation level, so a
 * trade is wrong exactly when the indicator says the trend is over. No
 * measured move to guess at, and no "forming" state — a flip has happened or
 * it has not.
 *
 * The target does have to be chosen, so it is expressed as a multiple of the
 * risk rather than a percentage: risk is set by the indicator's own distance
 * from price, which varies with volatility, and a fixed percentage would be
 * a different R:R on every bar.
 */
/**
 * Whether a stop can actually stop the trade: below the entry for a long,
 * above it for a short, and both real numbers.
 *
 * Extracted because Supertrend's own construction makes this practically
 * unreachable through the indicator — the line is on the correct side of the
 * bar that flips, by definition. Testing it through a generated series proved
 * nothing (the altered bar simply stopped flipping), so the rule is tested
 * directly instead of pretending a fixture covered it.
 */
function usableStop(side, entry, stop) {
  if (!Number.isFinite(entry) || !Number.isFinite(stop)) return false;
  return side === 'buy' ? stop < entry : stop > entry;
}

function deriveSupertrendSignal(candles, opts, logger = console) {
  const { period, multiplier, rewardRisk, minRR } = opts;
  const st = indicators.supertrend(candles, period, multiplier);
  const n = st.length;
  if (n < 2) return null;

  const now = st[n - 1];
  const prev = st[n - 2];
  if (!now || !prev) return null;

  // Only the bar that FLIPS is a signal. Without this it would fire on every
  // scan for as long as the trend held, re-entering a position it is already
  // in on every pass.
  if (now.dir === prev.dir) {
    logger.log(`[scanner]   supertrend still ${now.dir === 1 ? 'long' : 'short'}, no flip on the last closed bar`);
    return null;
  }

  const side = now.dir === 1 ? 'buy' : 'sell';
  const entry = candles[candles.length - 1].c;
  const stop = now.v;

  if (!usableStop(side, entry, stop)) {
    logger.warn(`[scanner]   supertrend flipped ${side} but its line (${stop}) is not a usable stop against ${entry}`);
    return null;
  }

  const risk = Math.abs(entry - stop);
  const target = side === 'buy' ? entry + risk * rewardRisk : entry - risk * rewardRisk;
  const rr = rewardRisk;

  if (minRR !== null && rr < minRR) {
    logger.log(`[scanner]   supertrend ${side} rejected: R:R ${rr} below SIGNAL_MIN_RR ${minRR}`);
    return null;
  }

  return {
    side,
    pattern: `Supertrend ${period}/${multiplier}`,
    status: 'flip',
    rr,
    entry,
    stop,
    target,
  };
}

/* ------------------------------------------------------------------ *
 * Circuit breaker
 *
 * The guards in trading.js protect individual trades. Nothing protected the
 * account across a run of them — an unattended bot can lose money steadily
 * while every single order passes its own checks. This measures equity against
 * a daily baseline and stops opening positions when the day's loss limit is
 * reached.
 * ------------------------------------------------------------------ */

function utcDay(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

function utcMidnight(ts = Date.now()) {
  return Date.parse(`${utcDay(ts)}T00:00:00.000Z`);
}

// Ledger entries that represent trading outcomes. Deposits, withdrawals and
// transfers move equity without being a gain or a loss, so counting them
// would let a withdrawal trip the breaker and a deposit clear it.
const PNL_LEDGER_TYPES = new Set([
  'trade', 'fee', 'commission', 'rebate', 'settlement', 'funding', 'realized_pnl',
]);

/**
 * Works out what equity was at the start of the UTC day by subtracting the
 * day's trading result from what it is now.
 *
 * This exists because persisting the baseline to disk assumes a disk that
 * survives a restart, and on an ephemeral host there isn't one. The exchange
 * is the one place the history genuinely lives, so ask it.
 *
 * Returns null if the answer cannot be established. The caller must treat
 * that as "do not trade", never as "start fresh" — a loss limit that resets
 * itself on restart is not a loss limit.
 */
/**
 * The signed value of a ledger entry, or null when it cannot be determined.
 *
 * ccxt's documented shape is an unsigned `amount` plus a `direction` of
 * "in"/"out", but not every implementation fills `direction` in — and reading
 * a missing one as "in" turns every loss into a gain. That is how a Weex
 * account produced a baseline of -98.72: outflows were added instead of
 * subtracted, so the day's total came out larger than the balance itself.
 *
 * Three sources, most trustworthy first. Returning null is a real answer:
 * the caller refuses rather than totalling entries it only half understood.
 */
function signedLedgerAmount(entry) {
  const amount = Number(entry.amount);

  if (entry.direction === 'out') return -Math.abs(amount || 0);
  if (entry.direction === 'in') return Math.abs(amount || 0);

  // Some exchanges skip `direction` and sign the amount instead. A negative
  // amount is unambiguous; a positive one with no direction is not, since it
  // could be either.
  if (Number.isFinite(amount) && amount < 0) return amount;

  // Balance either side of the entry settles it beyond doubt.
  const before = Number(entry.before);
  const after = Number(entry.after);
  if (Number.isFinite(before) && Number.isFinite(after)) return after - before;

  return null;
}

async function reconstructBaseline({ exchange, equity, code = 'USDT', logger = console }) {
  if (!exchange.has || !exchange.has.fetchLedger) {
    logger.warn('[breaker] this exchange cannot report a ledger; baseline cannot be reconstructed.');
    return null;
  }

  const since = utcMidnight();

  // Exchanges disagree about which arguments fetchLedger will accept, and they
  // disagree in different directions: Bybit is content with no currency at
  // all, Weex demands one ("could not resolve currency") and then rejects the
  // timestamp anyway ("Parameter 'startTime' is invalid"). Rather than guess,
  // try the combinations from most specific to least.
  //
  // Dropping `since` costs nothing: every entry is filtered against it below,
  // so a wider query returns more rows and the same answer. What we must not
  // do is give up, because a baseline that cannot be established halts trading.
  const attempts = [
    { code, since, label: `${code} since midnight` },
    { code, since: undefined, label: `${code}, no time filter` },
    { code: undefined, since, label: 'no currency, since midnight' },
    { code: undefined, since: undefined, label: 'no currency, no time filter' },
  ];

  let entries = null;
  const failures = [];
  for (const attempt of attempts) {
    try {
      const got = await exchange.fetchLedger(attempt.code, attempt.since, 500);
      if (Array.isArray(got)) { entries = got; break; }
      failures.push(`${attempt.label}: not an array`);
    } catch (err) {
      failures.push(`${attempt.label}: ${err.message}`);
    }
  }

  if (entries === null) {
    logger.warn(`[breaker] every ledger query failed — ${failures.join(' | ')}`);
    return null;
  }

  let net = 0;
  let counted = 0;
  let unsigned = 0;
  const directions = new Set();
  let sampleCounted = null;
  for (const e of entries) {
    if (!e || !Number.isFinite(Number(e.timestamp)) || Number(e.timestamp) < since) continue;
    if (!PNL_LEDGER_TYPES.has(String(e.type))) continue;
    const signed = signedLedgerAmount(e);
    if (signed === null) { unsigned += 1; continue; }
    net += signed;
    counted += 1;
    directions.add(signed < 0 ? 'out' : 'in');
    if (!sampleCounted) sampleCounted = e;
  }

  // An entry whose direction cannot be established is worse than a missing
  // one: counting a withdrawal as a gain moves the baseline the wrong way by
  // twice its size. Refuse rather than average over the ones we understood.
  if (unsigned > 0) {
    logger.warn(
      `[breaker] ${unsigned} of ${unsigned + counted} ledger entries carry no usable direction `
      + '(no `direction`, no signed `amount`, no before/after). Cannot total the day reliably.'
    );
    return null;
  }

  const baseline = equity - net;
  if (!Number.isFinite(baseline) || baseline <= 0) {
    // Deliberately NOT diagnosed as "the ledger only reports inflows": a day
    // whose entries are all one direction is an ordinary winning or losing
    // day, so that tells us nothing. The implausible total is the real signal
    // — it says the arithmetic cannot be trusted, without pretending to know
    // which field is at fault.
    logger.warn(
      `[breaker] reconstructed baseline is implausible (${baseline}) from ${counted} entries `
      + `totalling ${net.toFixed(4)} against equity ${equity} (directions seen: `
      + `${[...directions].join(', ') || 'none'}); refusing to guess. If this exchange's ledger `
      + 'cannot be totalled, BREAKER_FALLBACK_TO_EQUITY=true baselines from current equity instead '
      + '— a limit measured from process start rather than UTC midnight.'
    );
    // Sample one of the entries actually COUNTED. Sampling the whole response
    // printed a row from four days earlier that the timestamp filter had
    // already discarded — a diagnostic describing the wrong data.
    if (sampleCounted) {
      logger.warn(`[breaker] sample counted entry: ${JSON.stringify({
        type: sampleCounted.type, direction: sampleCounted.direction, amount: sampleCounted.amount,
        before: sampleCounted.before, after: sampleCounted.after,
        currency: sampleCounted.currency, timestamp: sampleCounted.timestamp,
      })}`);
    }
    return null;
  }

  logger.log(
    `[breaker] baseline reconstructed from ${counted} ledger entries: ` +
    `${baseline.toFixed(2)} (today's result so far ${net >= 0 ? '+' : ''}${net.toFixed(2)})`
  );
  return baseline;
}

class DailyLossBreaker {
  /**
   * `statePath` makes the breaker survive a restart. Without it the state is
   * in memory only, which is how a daily loss limit quietly stops being one:
   * the process exits on any unhandled rejection, the supervisor restarts it,
   * and the fresh baseline is taken at the already-reduced equity — so the
   * same percentage can be lost again, repeatedly, within one UTC day.
   */
  constructor({
    maxDailyLossPercent,
    maxConsecutiveLosses,
    statePath = null,
    failClosed = false,
    logger = console,
  }) {
    this.maxDailyLossPercent = maxDailyLossPercent;
    this.maxConsecutiveLosses = maxConsecutiveLosses;
    // Only refuse to trade over an unknown baseline when trades are real.
    this.failClosed = failClosed;
    this.day = null;
    this.baseline = null;
    this.tripped = false;
    this.reason = null;
    this.consecutiveLosses = 0;
    this.lastEquity = null;

    this.statePath = statePath;
    this.saveFailed = false;
    if (statePath) this.load(logger);
  }

  /**
   * Restores today's state. Yesterday's is deliberately ignored — update()
   * re-baselines on a new UTC day anyway, and restoring a stale trip would
   * halt trading for a day that already ended.
   */
  load(logger = console) {
    let raw;
    try {
      raw = fs.readFileSync(this.statePath, 'utf8');
    } catch (err) {
      // No file yet is the normal first run, not a problem worth reporting.
      if (err.code !== 'ENOENT') {
        logger.warn(`[breaker] could not read ${this.statePath} (${err.message}) — starting cold.`);
      }
      return;
    }

    let s;
    try {
      s = JSON.parse(raw);
    } catch {
      logger.warn(`[breaker] ${this.statePath} is not valid JSON — starting cold.`);
      return;
    }

    if (!s || typeof s.day !== 'string' || s.day !== utcDay()) return;

    this.day = s.day;
    this.baseline = Number.isFinite(s.baseline) ? s.baseline : null;
    this.tripped = s.tripped === true;
    this.reason = typeof s.reason === 'string' ? s.reason : null;
    this.consecutiveLosses = Number.isInteger(s.consecutiveLosses) ? s.consecutiveLosses : 0;
    this.lastEquity = Number.isFinite(s.lastEquity) ? s.lastEquity : null;

    if (this.tripped) {
      logger.warn(`[breaker] restored from disk: STILL TRIPPED for ${s.day} — ${this.reason}`);
    } else {
      logger.log(`[breaker] restored from disk: ${s.day}, baseline ${Number(this.baseline).toFixed(2)}`);
    }
  }

  /** Written via a temp file and rename so a crash mid-write cannot truncate it. */
  save(logger = console) {
    if (!this.statePath) return;
    const payload = JSON.stringify({
      day: this.day,
      baseline: this.baseline,
      tripped: this.tripped,
      reason: this.reason,
      consecutiveLosses: this.consecutiveLosses,
      lastEquity: this.lastEquity,
    });
    const tmp = `${this.statePath}.tmp`;
    try {
      fs.writeFileSync(tmp, payload, { mode: 0o600 });
      fs.renameSync(tmp, this.statePath);
      this.saveFailed = false;
    } catch (err) {
      // Say it once, loudly. Repeating it every 60s would bury the reason.
      if (!this.saveFailed) {
        this.saveFailed = true;
        logger.error(
          `[breaker] CANNOT PERSIST STATE to ${this.statePath} (${err.message}). ` +
          'The daily loss limit will reset if this process restarts.'
        );
      }
    }
  }

  /**
   * True when this is a cold start part-way through a UTC day: we have no
   * baseline, but the account has clearly been trading before now. Only then
   * is it worth spending an API call to reconstruct one.
   */
  needsBaseline(equity) {
    if (!Number.isFinite(equity) || equity <= 0) return false;
    // A day that rolled over while the process was running needs no
    // reconstruction — current equity IS the new day's opening balance.
    // Only a cold start with nothing to go on does.
    if (this.day !== null && this.day !== utcDay()) return false;
    return this.baseline === null;
  }

  /**
   * Takes a reconstructed baseline, or trips if one could not be established.
   *
   * Failing closed is the whole point. The alternative — carry on with a
   * fresh baseline — is exactly the behaviour that let a restart hand back
   * the full daily loss allowance, which is the bug this is here to close.
   */
  adoptBaseline(baseline, logger = console, equity = null) {
    const today = utcDay();
    if (Number.isFinite(baseline) && baseline > 0) {
      this.day = today;
      this.baseline = baseline;
      this.tripped = false;
      this.reason = null;
      this.save(logger);
      return true;
    }

    this.day = today;

    // When no real orders can be placed, halting would stop you ever watching
    // the thing work. Fall back loudly instead; nothing is at stake.
    if (!this.failClosed) {
      this.baseline = Number.isFinite(equity) && equity > 0 ? equity : null;
      logger.warn(
        '[breaker] could not establish today\'s baseline; using current equity. ' +
        'Harmless here because orders are not being sent, but this would halt an armed scanner.'
      );
      this.save(logger);
      return false;
    }

    this.baseline = null;
    this.trip(
      'baseline for today could not be established after a restart, so the daily loss limit ' +
      'cannot be enforced',
      logger
    );
    this.save(logger);
    return false;
  }

  /**
   * Rebuilds today's baseline from the exchange ledger.
   *
   * Exposed as a method so trading.js can reach it through the breaker it was
   * handed: scanner.js already requires trading.js, so importing the other way
   * would be a cycle.
   */
  async reconstruct(exchange, equity, logger = console) {
    return reconstructBaseline({ exchange, equity, logger });
  }

  /** Called before each scan. Re-baselines on a new UTC day. */
  update(equity, logger = console) {
    if (!Number.isFinite(equity) || equity <= 0) return;
    this.evaluate(equity, logger);
    this.save(logger);
  }

  evaluate(equity, logger = console) {
    const today = utcDay();
    if (this.day !== today) {
      this.day = today;
      this.baseline = equity;
      this.tripped = false;
      this.reason = null;
      this.consecutiveLosses = 0;
      logger.log(`[breaker] new day ${today}, baseline equity ${equity.toFixed(2)}`);
    }

    // A drop since the last observation counts as a losing outcome. Coarse,
    // but it needs no trade-by-trade accounting and cannot be fooled by an
    // order that filled while the process was restarting.
    if (this.lastEquity !== null) {
      if (equity < this.lastEquity) this.consecutiveLosses += 1;
      else if (equity > this.lastEquity) this.consecutiveLosses = 0;
    }
    this.lastEquity = equity;

    if (this.tripped) return;

    if (this.maxDailyLossPercent !== null && this.baseline > 0) {
      const lossPct = ((this.baseline - equity) / this.baseline) * 100;
      if (lossPct >= this.maxDailyLossPercent) {
        this.trip(`down ${lossPct.toFixed(2)}% today (limit ${this.maxDailyLossPercent}%)`, logger);
        return;
      }
    }

    if (this.maxConsecutiveLosses !== null && this.consecutiveLosses >= this.maxConsecutiveLosses) {
      this.trip(`${this.consecutiveLosses} consecutive losing observations (limit ${this.maxConsecutiveLosses})`, logger);
    }
  }

  trip(reason, logger = console) {
    this.tripped = true;
    this.reason = reason;
    logger.error(`[breaker] TRIPPED — ${reason}. No new positions until ${utcDay(Date.now() + 86_400_000)} UTC.`);
    logger.error('[breaker] Open positions are untouched; their stops and targets remain with the exchange.');
  }

  get blocked() {
    return this.tripped;
  }
}

/* ------------------------------------------------------------------ *
 * Scanning
 * ------------------------------------------------------------------ */

/** Short, deterministic id: same bar always produces the same value. */
function signalId(symbol, timeframe, candleTime) {
  const compact = symbol.replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
  return `${compact}-${timeframe}-${candleTime}`.slice(0, 36);
}

async function scanSymbol({ exchange, symbol, timeframe, config, settings, dedupe, lastBar, logger }) {
  const scanner = settings || config.scanner;
  const tf = timeframe || scanner.timeframe;
  const timeframeMs = timeframeToMs(exchange, tf);

  const raw = await exchange.fetchOHLCV(symbol, tf, undefined, scanner.candleLimit);
  const candles = dropFormingCandle(toCandles(raw), timeframeMs);

  if (candles.length < scanner.minCandles) {
    logger.warn(`[scanner] ${symbol}: only ${candles.length} closed candles, need ${scanner.minCandles}`);
    return null;
  }

  const bar = candles[candles.length - 1].t;
  const key = `${symbol}:${tf}`;
  if (lastBar.get(key) === bar) return null; // already evaluated this bar
  lastBar.set(key, bar);

  const stamp = new Date(bar).toISOString();
  logger.log(`[scanner] ${symbol} ${tf} bar ${stamp} close=${candles[candles.length - 1].c}`);

  // Which engine produces the signal. Both return the same shape, so
  // everything downstream — the guards, sizing, the order — is identical.
  const signal = scanner.strategy === 'supertrend'
    ? deriveSupertrendSignal(candles, scanner.supertrend, logger)
    : deriveSignal(candles, scanner.rules, logger);
  if (!signal) return null;

  logger.log(
    `[scanner]   SIGNAL ${signal.side.toUpperCase()} — ${signal.pattern} (${signal.status}), ` +
    `rr=${signal.rr?.toFixed(2)}, entry=${signal.entry?.toFixed(2)}, stop=${signal.stop?.toFixed(2)}`
  );

  if (!scanner.execute) {
    logger.log('[scanner]   SCANNER_EXECUTE is false — signal logged, not sent.');
    return { signal, sent: false };
  }

  const request = validateTradeRequest(
    {
      exchange: exchange.id,
      symbol,
      side: signal.side,
      clientOrderId: signalId(symbol, tf, bar),
      // The pattern's own invalidation level and measured-move target. More
      // meaningful than a fixed percentage, and what the R:R filter was
      // computed from — so the trade taken matches the trade evaluated.
      stopPrice: Number.isFinite(signal.stop) ? signal.stop : undefined,
      targetPrice: Number.isFinite(signal.target) ? signal.target : undefined,
    },
    { [exchange.id]: exchange }
  );

  try {
    const result = await executeTrade(request, {
      config,
      dedupe,
      logger,
      requestId: `scan-${bar}`,
    });
    return { signal, sent: true, result };
  } catch (err) {
    // A refused signal is normal operation (position cap, opposite position,
    // size below minimum). It must not stop the scan loop.
    logger.warn(`[scanner]   not executed: ${err.message}`);
    return { signal, sent: false, error: err.message };
  }
}

async function runScan({ exchanges, config, settings, dedupe, lastBar, breaker, breakers, logger = console }) {
  const scanner = settings || config.scanner;
  const exchange = exchanges[scanner.exchange];

  // Resolved per scan, not bound at construction. The exchange is a runtime
  // setting now, and a breaker latched at boot would keep measuring the daily
  // loss of the venue the scanner USED to trade — reading one account's
  // drawdown while placing orders on another.
  if (breakers) breaker = breakers.for(scanner.exchange);
  if (!exchange) {
    logger.warn(`[scanner] exchange "${scanner.exchange}" is not configured; scan skipped`);
    return;
  }

  if (breaker) {
    try {
      const balance = await exchange.fetchBalance();
      const equity = Number(balance?.total?.USDT ?? balance?.USDT?.total);

      // Cold start mid-day: no persisted baseline, and taking the current
      // (already reduced) equity as the baseline would hand back the full
      // daily allowance. Ask the exchange what the day actually did.
      if (breaker.needsBaseline(equity)) {
        const baseline = await reconstructBaseline({ exchange, equity, logger });
        breaker.adoptBaseline(baseline, logger, equity);
      }

      breaker.update(equity, logger);
    } catch (err) {
      // Without an equity reading the breaker cannot do its job. Refusing to
      // scan is the safe response for an unattended system.
      logger.warn(`[scanner] equity check failed, skipping scan: ${err.message}`);
      return;
    }
    if (breaker.blocked) {
      logger.warn(`[scanner] halted by circuit breaker: ${breaker.reason}`);
      return;
    }
  }

  // Every symbol against every timeframe. The per-bar dedupe already keys on
  // symbol AND timeframe, so the same market on 15m and 1h are independent
  // signals rather than one shadowing the other.
  const timeframes = scanner.timeframes && scanner.timeframes.length
    ? scanner.timeframes
    : [scanner.timeframe];

  const startedAt = Date.now();
  let combinations = 0;

  for (const symbol of scanner.symbols) {
    for (const timeframe of timeframes) {
      combinations += 1;
      try {
        await scanSymbol({ exchange, symbol, timeframe, config, settings: scanner, dedupe, lastBar, logger });
      } catch (err) {
        // One bad symbol/timeframe must not take down the rest of the sweep.
        logger.warn(`[scanner] ${symbol} ${timeframe}: ${err.message}`);
      }
    }
  }

  // A sweep that outlasts the interval means the next tick is skipped (the
  // loop refuses to overlap), so signals arrive late and the cause is
  // invisible. Saying it is the difference between "add more symbols" and
  // "why is this missing flips".
  const elapsed = Date.now() - startedAt;
  if (elapsed > scanner.intervalMs) {
    logger.warn(
      `[scanner] sweep of ${combinations} symbol/timeframe pairs took ${Math.round(elapsed / 1000)}s, `
      + `longer than the ${Math.round(scanner.intervalMs / 1000)}s interval — ticks are being skipped. `
      + 'Raise SCANNER_INTERVAL_MS or watch fewer pairs.'
    );
  }
}

/** Account equity in the quote currency the breaker measures against. */
function readEquity(balance) {
  return Number(balance?.total?.USDT ?? balance?.USDT?.total);
}

/**
 * Builds the circuit breaker.
 *
 * Deliberately separate from startScanner: the daily loss limit is an ACCOUNT
 * guard, not a scanner feature. Creating it inside the scanner meant that with
 * SCANNER_ENABLED=false it did not exist at all, so MAX_DAILY_LOSS_PERCENT was
 * silently inert for every trade sent to /api/trade by hand.
 */
/**
 * One breaker per exchange.
 *
 * A single shared breaker was fine while Bybit was the only venue. With two,
 * the equity it saw came from whichever exchange the trade happened to target,
 * so a Bybit tap set the baseline from one account and a Weex tap compared a
 * different account against it. The "daily loss" it measured was then just the
 * gap between two balances, and it could trip on a loss nobody had taken.
 */
/**
 * A mutable snapshot of the scanner's settings.
 *
 * config is frozen at boot, which is right — it is what the environment said.
 * But changing a strategy or a timeframe should not require a redeploy, so the
 * running loop reads this instead and the API can update it in place.
 *
 * Deliberately a COPY, not a reference: the frozen config remains the record
 * of what the service started with, which is what makes a runtime change
 * visible as a difference rather than rewriting history.
 */
function createScannerSettings(config) {
  return {
    ...config.scanner,
    symbols: [...config.scanner.symbols],
    timeframes: [...(config.scanner.timeframes || [config.scanner.timeframe])],
    rules: { ...config.scanner.rules },
    supertrend: { ...config.scanner.supertrend },
  };
}

function createBreakers({ config, logger = console }) {
  const breakers = new Map();
  return {
    for(exchangeId) {
      if (!breakers.has(exchangeId)) {
        breakers.set(exchangeId, createBreaker({ config, logger, exchangeId }));
      }
      return breakers.get(exchangeId);
    },
    entries() {
      return [...breakers.entries()];
    },
  };
}

function mayFallBack(config, exchangeId) {
  const allowed = config.breakerFallbackExchanges || [];
  if (allowed.length === 0) return false;
  const wanted = allowed.map((x) => String(x).toLowerCase());
  if (wanted.includes('all') || wanted.includes('true')) return true;
  return exchangeId !== null && wanted.includes(String(exchangeId).toLowerCase());
}

function createBreaker({ config, logger = console, exchangeId = null }) {
  const { scanner } = config;

  // The breaker is the only guard that has to outlive the process: every
  // other check re-derives itself from the exchange on the next request.
  let statePath = null;
  if (config.stateDir) {
    try {
      fs.mkdirSync(config.stateDir, { recursive: true });
      statePath = path.join(config.stateDir, exchangeId ? `breaker-state-${exchangeId}.json` : 'breaker-state.json');
    } catch (err) {
      logger.error(`[breaker] STATE_DIR ${config.stateDir} is unusable (${err.message}) — state will not persist.`);
    }
  }

  return new DailyLossBreaker({
    maxDailyLossPercent: scanner.maxDailyLossPercent,
    maxConsecutiveLosses: scanner.maxConsecutiveLosses,
    statePath,
    // Real orders only: halt over an unknown baseline when money is at stake,
    // and merely complain when it is not. Manual trades count as real whenever
    // DRY_RUN is off, whether or not the scanner is executing.
    // Per exchange: a venue whose ledger cannot be read is allowed to fall
    // back only if it was named, so unblocking one never quietly relaxes
    // another that was working.
    failClosed: !config.dryRun && !mayFallBack(config, exchangeId),
    logger,
  });
}

function startScanner({ exchanges, config, settings, dedupe, breaker, breakers, logger = console }) {
  const scanner = settings || config.scanner;
  if (!scanner.enabled) {
    logger.log('[scanner] disabled (SCANNER_ENABLED=false) — the loop still runs so it can be enabled without a redeploy');
  }

  const lastBar = new Map();
  let running = false;
  let stopped = false;
  let lastTickAt = null;

  const tick = async () => {
    if (running || stopped) return; // never overlap scans
    // Read every tick: the setting is mutable so it can be flipped at
    // runtime, and a loop that latched it at construction could never see it.
    if (!scanner.enabled) return;
    running = true;

    // A gap far larger than the interval means the process was suspended —
    // on a sleeping PaaS instance, for example. Autonomous trading with
    // unpredictable downtime is worth knowing about loudly.
    const now = Date.now();
    if (lastTickAt !== null) {
      const gap = now - lastTickAt;
      if (gap > scanner.intervalMs * 3) {
        logger.warn(
          `[scanner] gap of ${Math.round(gap / 1000)}s between scans (interval is ` +
          `${Math.round(scanner.intervalMs / 1000)}s). The process was suspended or blocked — ` +
          `on a Free PaaS instance this means it was asleep and not scanning.`
        );
      }
    }
    lastTickAt = now;

    try {
      await runScan({ exchanges, config, settings: scanner, dedupe, lastBar, breaker, breakers, logger });
    } catch (err) {
      logger.error(`[scanner] scan failed: ${err.message}`);
    } finally {
      running = false;
    }
  };

  loadDetectors(logger)
    .then(() => {
      logger.log(
        // "watching ... every 60s" printed while disabled read as though the
        // scanner were running, directly under a line saying it was not. It
        // describes what the loop WOULD do until it is enabled.
        `[scanner] ${scanner.enabled ? 'watching' : 'idle — would watch'} `
        + `${scanner.symbols.length} symbol(s) x ${(scanner.timeframes || [scanner.timeframe]).length} timeframe(s): `
        + `${scanner.symbols.join(', ')} on ${(scanner.timeframes || [scanner.timeframe]).join(', ')} `
        + `every ${Math.round(scanner.intervalMs / 1000)}s `
        + `(${scanner.execute ? 'EXECUTING' : 'log only'})`
      );
      tick();
    })
    .catch((err) => logger.error(`[scanner] ${err.message}`));

  // Fixed at construction: changing the poll interval at runtime would mean
  // tearing down and rebuilding the timer, and the interval is the one
  // setting that genuinely wants a restart.
  const timer = setInterval(tick, scanner.intervalMs);
  timer.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    // exposed for tests and /health
    tick,
    lastBar,
    breaker,
    get lastTickAt() { return lastTickAt; },
  };
}

module.exports = {
  startScanner,
  createBreaker,
  createBreakers,
  createScannerSettings,
  mayFallBack,
  readEquity,
  DailyLossBreaker,
  reconstructBaseline,
  signedLedgerAmount,
  runScan,
  scanSymbol,
  deriveSignal,
  deriveSupertrendSignal,
  usableStop,
  dropFormingCandle,
  toCandles,
  signalId,
  loadDetectors,
};

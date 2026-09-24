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
const { executeTrade, validateTradeRequest, breakerEquity } = require('./trading');
const { findPosition } = require('./positions');
const { riskConfig } = require('./risk');
const { classifyLedgerRow, cashFlowAmount, walkLedger, isRealisedPnl: sharedIsRealisedPnl } = require('./pnl');

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

/**
 * One position read per sweep, shared by every symbol that asks.
 *
 * A resync checks the symbol is flat before entering, and asking per symbol
 * turned one private call into up to nineteen — arriving in a burst, on a
 * venue that was already refusing calls. The read is made at most once and
 * only if something actually needs it; a failure is remembered too, so a bad
 * sweep does not retry nineteen times before giving up.
 */
function makePositionBook(exchange) {
  let pending = null;
  return {
    async openFor(symbol) {
      if (!pending) {
        pending = exchange.fetchPositions().then((raw) => (raw || []).filter((p) => {
          const contracts = Number(p?.contracts ?? 0);
          return Number.isFinite(contracts) && Math.abs(contracts) > 0;
        }));
      }
      const open = await pending;
      return open.filter((p) => p.symbol === symbol);
    },
  };
}

/**
 * Closed bars since the direction last changed. 0 means the flip is the last
 * closed bar — an ordinary signal. null means the whole series is one
 * direction, so there is no flip in view to be near.
 */
function barsSinceFlip(st) {
  const n = st.length;
  const dir = st[n - 1] && st[n - 1].dir;
  if (dir === undefined) return null;
  let bars = 0;
  for (let i = n - 2; i >= 0; i--) {
    if (!st[i]) return null;          // warm-up, not a direction change
    if (st[i].dir !== dir) return bars;
    bars += 1;
  }
  return null;
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
  //
  // That leaves one hole, and it is not theoretical: if the exchange stop
  // closes the position mid-trend, or the circuit breaker halts the sweep
  // across the flip, there is no second flip to act on. The symbol sits flat
  // for the rest of the move — waiting for the trend to end and begin again.
  // resyncBars re-opens that window for a few bars after the flip, and only
  // while genuinely flat, which the caller checks.
  let resync = false;
  if (now.dir === prev.dir) {
    const since = barsSinceFlip(st);
    const window = Number(opts.resyncBars) || 0;
    if (window <= 0 || since === null || since > window) {
      logger.log(`[scanner]   supertrend still ${now.dir === 1 ? 'long' : 'short'}, no flip on the last closed bar`);
      return null;
    }
    resync = true;
    logger.log(
      `[scanner]   supertrend still ${now.dir === 1 ? 'long' : 'short'}, ${since} bar(s) since the flip `
      + `— within the ${window}-bar resync window, so a flat symbol may still enter`
    );
  }

  const side = now.dir === 1 ? 'buy' : 'sell';
  const entry = candles[candles.length - 1].c;
  const stop = now.v;

  if (!usableStop(side, entry, stop)) {
    logger.warn(`[scanner]   supertrend ${resync ? 'is' : 'flipped'} ${side} but its line (${stop}) is not a usable stop against ${entry}`);
    return null;
  }

  const risk = Math.abs(entry - stop);

  // rewardRisk 0 means "no target": ride the trend and let the Supertrend
  // line be the only exit. The position then runs until the stop is hit,
  // which is the point — a fixed multiple of risk caps a trend follower at
  // exactly the moment it is working.
  //
  // With no target there is no reward to divide by risk, so R:R is not a
  // number that exists here. Reporting it as 0 would be a lie that the minRR
  // filter would then act on, rejecting every signal; the filter is skipped
  // instead, because "is this trade's R:R good enough" has no meaning when
  // the trade has no predetermined reward.
  const noTarget = !(rewardRisk > 0);
  const target = noTarget
    ? null
    : (side === 'buy' ? entry + risk * rewardRisk : entry - risk * rewardRisk);
  const rr = noTarget ? null : rewardRisk;

  if (!noTarget && minRR !== null && rr < minRR) {
    logger.log(`[scanner]   supertrend ${side} rejected: R:R ${rr} below SIGNAL_MIN_RR ${minRR}`);
    return null;
  }

  return {
    side,
    pattern: `Supertrend ${period}/${multiplier}`,
    status: resync ? 'resync' : 'flip',
    // The caller gates on this: a resync is only valid while flat, and a flip
    // is what the reversal path is for. Reading it off `status` would work
    // until someone changed that string for the log line it also feeds.
    kind: resync ? 'resync' : 'flip',
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

/**
 * Whether a ledger entry is a CLOSED TRADE's profit or loss.
 *
 * Funding, fees, transfers and deposits all move equity without a trade
 * having finished, and counting them as outcomes is what made the old
 * counter meaningless.
 *
 * This used to match on the type name — /realis|realiz|pnl|settle|close/ —
 * which matches NOTHING on Bybit: ccxt normalises every v5 trading row to the
 * single type `trade`. The consecutive-loss limit was therefore reading zero
 * closed trades and could never have tripped, while the daily-loss baseline
 * two hundred lines below used a type set that included `trade` and worked
 * fine. One venue, two readings of the same rows, disagreeing silently.
 *
 * There is now one classifier, in pnl.js, and both the breaker and the P&L
 * panel use it.
 */
const isRealisedPnl = sharedIsRealisedPnl;

/**
 * Consecutive losing CLOSED TRADES, read from the exchange's own ledger.
 *
 * The counter this replaces incremented on every equity observation lower
 * than the last, sampled once a minute. One position drifting against you for
 * half an hour was thirty "losses", and a limit of 30 halted a whole day of
 * trading on what was only a slow tick down — while the name said something
 * quite different was being measured.
 *
 * Returns null when the venue cannot answer, and null must NOT be treated as
 * zero: "no losing trades" and "cannot tell" are different, and only one of
 * them should reset a streak.
 */
async function readLedgerDay({ exchange, since, code = 'USDT', logger = console }) {
  if (!exchange.has || !exchange.has.fetchLedger) return null;

  // The whole day, not one page. A single fetchLedger call gets Bybit's
  // default of 20 rows, newest first — so once a day had more than 20 rows
  // the morning's deposit dropped off the page, the transfer total was
  // recomputed from what was left as zero, and the daily limit went back to
  // measuring against the pre-deposit balance. This is the walk the P&L panel
  // already relies on, which pages through windows the venue will answer.
  let entries;
  let complete = true;
  try {
    const walked = await walkLedger({ exchange, since, code, logger });
    entries = walked.entries;
    complete = !walked.truncated;
  } catch (err) {
    // Some venues reject a time filter outright (Weex: "startTime is
    // invalid"). One unfiltered page is still enough to count a losing
    // streak from, but it is a PART of the day, so it must not be allowed to
    // decide how much was deposited.
    try {
      entries = await exchange.fetchLedger(code);
      complete = false;
    } catch (inner) {
      logger.warn(`[breaker] could not read the ledger for trade outcomes: ${inner.message}`);
      return null;
    }
  }
  if (!Array.isArray(entries)) return null;

  const inWindow = (ts) => !since || (Number.isFinite(Number(ts)) && Number(ts) >= since);

  // The amount is the row's NET, not its gross trade result: on orders at the
  // exchange minimum a small gross win can still be a loss to the account once
  // the closing fee is taken, and the streak this counts is meant to be a
  // streak of the account losing money.
  const outcomes = entries
    .map((e) => classifyLedgerRow(e, exchange))
    .filter((r) => r !== null && r.closed)
    .filter((r) => inWindow(r.timestamp))
    .sort((a, b) => Number(a.timestamp) - Number(b.timestamp))
    .map((r) => ({ timestamp: Number(r.timestamp), amount: r.net }))
    .filter((e) => Number.isFinite(e.amount) && e.amount !== 0);

  // The rows classifyLedgerRow deliberately drops: money moved in or out
  // rather than won or lost. The two views are exclusive by construction, so
  // no row can be both a trade result and a deposit.
  const cash = entries
    .map((e) => ({ timestamp: Number(e && e.timestamp), amount: cashFlowAmount(e) }))
    .filter((r) => Number.isFinite(r.amount) && r.amount !== 0)
    .filter((r) => Number.isFinite(r.timestamp) && inWindow(r.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);

  // A partial day reports no transfer total at all. The breaker keeps the
  // last figure it had rather than recomputing one from whatever rows
  // happened to fit — which is exactly how a deposit went missing.
  return { outcomes, cash: complete ? cash : null, complete };
}

/** The trade outcomes alone, for callers that do not care about transfers. */
async function readClosedTradeOutcomes(opts) {
  const day = await readLedgerDay(opts);
  return day === null ? null : day.outcomes;
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
    // When the baseline was taken, and the deposits/withdrawals seen since.
    // Kept apart from the baseline rather than folded into it: the figure on
    // disk stays the raw opening balance, so a restart re-reads the transfers
    // from the ledger instead of adding them to a total that already has them.
    this.baselineAt = null;
    this.cashFlow = 0;
    this.tripped = false;
    this.reason = null;
    this.consecutiveLosses = 0;
    // The last outcome folded in, so a re-read of the same ledger page cannot
    // count one loss twice.
    this.lastOutcomeAt = null;
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
    this.baselineAt = Number.isFinite(s.baselineAt) ? s.baselineAt : null;
    this.cashFlow = Number.isFinite(s.cashFlow) ? s.cashFlow : 0;
    this.tripped = s.tripped === true;
    this.reason = typeof s.reason === 'string' ? s.reason : null;
    this.consecutiveLosses = Number.isInteger(s.consecutiveLosses) ? s.consecutiveLosses : 0;
    this.lastOutcomeAt = Number.isFinite(s.lastOutcomeAt) ? s.lastOutcomeAt : null;
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
      baselineAt: this.baselineAt,
      cashFlow: this.cashFlow,
      tripped: this.tripped,
      reason: this.reason,
      consecutiveLosses: this.consecutiveLosses,
      lastOutcomeAt: this.lastOutcomeAt,
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
      // The reconstruction already has today's deposits inside it: it totals
      // the trading rows only and subtracts them from current equity, so a
      // transfer that landed earlier today is part of the figure. Only later
      // ones are added.
      this.takeBaselineAt();
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
      this.takeBaselineAt();
      logger.warn(
        '[breaker] could not establish today\'s baseline; using current equity. ' +
        'Harmless here because orders are not being sent, but this would halt an armed scanner.'
      );
      this.save(logger);
      return false;
    }

    this.baseline = null;
    this.takeBaselineAt();
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

  /** Marks the baseline as taken now, and restarts the transfer total. */
  takeBaselineAt(ts = Date.now()) {
    this.baselineAt = ts;
    this.cashFlow = 0;
  }

  /**
   * The balance today's loss is measured against.
   *
   * A deposit raises equity without anything having been earned, so unless
   * the baseline rises with it the limit measures the wrong thing: fund $50
   * into a $4 account and a 50% limit would have to watch the whole deposit
   * disappear before it fires. A withdrawal is the mirror — it reads as a
   * loss and could halt trading on a transfer.
   */
  effectiveBaseline() {
    if (!Number.isFinite(this.baseline)) return this.baseline;
    return this.baseline + (Number.isFinite(this.cashFlow) ? this.cashFlow : 0);
  }

  /**
   * Folds in the day's deposits and withdrawals from the ledger.
   *
   * Takes the whole day's rows and recomputes the total, rather than adding
   * an increment: the caller re-reads the same ledger every sweep, and
   * accumulating would count one deposit once a minute. Rows at or before
   * the moment the baseline was taken are skipped, because the balance that
   * was read already contains them.
   *
   * A ledger that could not be read arrives as null and leaves the last
   * known total alone — "cannot tell" is not "nothing moved".
   */
  noteCashFlow(rows, logger = console) {
    if (!Array.isArray(rows)) return false;
    const taken = Number.isFinite(this.baselineAt) ? this.baselineAt : 0;
    let total = 0;
    for (const r of rows) {
      const ts = Number(r && r.timestamp);
      const amount = Number(r && r.amount);
      if (!Number.isFinite(ts) || !Number.isFinite(amount)) continue;
      if (ts <= taken) continue;
      total += amount;
    }

    const was = Number.isFinite(this.cashFlow) ? this.cashFlow : 0;
    if (Math.abs(total - was) < 1e-9) return false;
    this.cashFlow = total;
    this.save(logger);

    const moved = total - was;
    logger.warn(
      `[breaker] ${moved >= 0 ? 'deposit' : 'withdrawal'} of ${Math.abs(moved).toFixed(2)} `
      + `seen today — the day's loss is now measured against `
      + `${Number(this.effectiveBaseline()).toFixed(2)}, not the `
      + `${Number(this.baseline).toFixed(2)} the day opened at.`
    );
    return true;
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
      this.takeBaselineAt();
      this.tripped = false;
      this.reason = null;
      this.consecutiveLosses = 0;
      logger.log(`[breaker] new day ${today}, baseline equity ${equity.toFixed(2)}`);
    }

    // Equity is tracked for the daily-loss test only. It deliberately does NOT
    // drive the consecutive-loss counter any more: sampling equity once a
    // minute counted one position drifting for half an hour as thirty losses,
    // so the limit fired on drift rather than on losing trades. Outcomes now
    // arrive from the ledger through recordOutcomes().
    this.lastEquity = equity;

    if (this.tripped) return;

    const measuredAgainst = this.effectiveBaseline();
    if (this.maxDailyLossPercent !== null && measuredAgainst > 0) {
      const lossPct = ((measuredAgainst - equity) / measuredAgainst) * 100;
      if (lossPct >= this.maxDailyLossPercent) {
        this.trip(`down ${lossPct.toFixed(2)}% today (limit ${this.maxDailyLossPercent}%)`, logger);
        return;
      }
    }

    if (this.maxConsecutiveLosses !== null && this.consecutiveLosses >= this.maxConsecutiveLosses) {
      this.trip(`${this.consecutiveLosses} consecutive losing observations (limit ${this.maxConsecutiveLosses})`, logger);
    }
  }

  /**
   * Folds closed-trade results into the streak, newest last.
   *
   * Only entries after the last one already seen are counted, so a sweep that
   * re-reads the same ledger page does not count the same loss twice — which
   * would trip the breaker on a single bad trade given enough scans.
   */
  recordOutcomes(outcomes, logger = console) {
    if (!Array.isArray(outcomes)) return;      // null means "cannot tell"
    let counted = 0;
    for (const o of outcomes) {
      if (this.lastOutcomeAt !== null && o.timestamp <= this.lastOutcomeAt) continue;
      this.lastOutcomeAt = o.timestamp;
      counted += 1;
      if (o.amount < 0) this.consecutiveLosses += 1;
      else this.consecutiveLosses = 0;
    }
    if (counted > 0) {
      logger.log(`[breaker] ${counted} closed trade(s) recorded; consecutive losses now ${this.consecutiveLosses}`);
      // Persisted here, not only on trip: both the streak and how far the
      // ledger has been read have to survive a restart. Without the read
      // position a restart re-counts trades already accounted for, and trips
      // on losses that were taken hours ago.
      this.save(logger);
    }
    if (this.tripped) return;
    if (this.maxConsecutiveLosses !== null && this.consecutiveLosses >= this.maxConsecutiveLosses) {
      this.trip(`${this.consecutiveLosses} consecutive losing trades (limit ${this.maxConsecutiveLosses})`, logger);
    }
  }

  trip(reason, logger = console) {
    this.tripped = true;
    this.reason = reason;
    logger.error(`[breaker] TRIPPED — ${reason}. No new positions until ${utcDay(Date.now() + 86_400_000)} UTC.`);
    logger.error('[breaker] Open positions are untouched; their stops and targets remain with the exchange.');
  }

  /**
   * Clears a trip on purpose, and starts the day's measurement again from here.
   *
   * Clearing the flag alone would achieve nothing: equity is still below the
   * threshold that tripped it, so the next evaluation would trip again within
   * the minute. So the baseline is re-taken at current equity and the losing
   * streak reset — the day's allowance genuinely restarts.
   *
   * That is the same effect as the restart bug this class exists to close, and
   * the difference is the whole point: there it happened silently, on every
   * crash, handing back the allowance nobody chose to hand back. Here it takes
   * a human, a confirmation, and leaves a warn-level record of who gave the
   * account permission to lose another slice of itself today.
   *
   * @returns {boolean} whether anything was actually cleared
   */
  resume(logger = console) {
    if (!this.tripped) return false;

    const was = this.reason;
    const from = this.baseline;
    // lastEquity is the most recent reading; without one there is nothing
    // honest to re-baseline to, so the old baseline stands and the allowance
    // is whatever is left of it.
    if (Number.isFinite(this.lastEquity) && this.lastEquity > 0) {
      this.baseline = this.lastEquity;
      // The reading being re-baselined to already contains any deposit made
      // today. Restarting the cash-flow total here is what stops it being
      // counted a second time.
      this.takeBaselineAt();
    }
    this.tripped = false;
    this.reason = null;
    this.consecutiveLosses = 0;
    this.save(logger);

    logger.warn(
      `[breaker] MANUALLY RESUMED after "${was}". Baseline re-taken at `
      + `${Number(this.baseline).toFixed(2)} (was ${Number(from).toFixed(2)}), losing streak reset — `
      + 'the daily allowance starts again from here.'
    );
    return true;
  }

  get blocked() {
    return this.tripped;
  }
}

/* ------------------------------------------------------------------ *
 * Scanning
 * ------------------------------------------------------------------ */

/** Short, deterministic id: same bar always produces the same value. */
function signalId(symbol, timeframe, candleTime, kind = '') {
  const compact = symbol.replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
  // The two legs of a reversal must not share an id: the dedupe cache keys on
  // clientOrderId, so a repeated id makes the entry look like a repeat of the
  // close it follows and drops it — leaving the account flat after a flip.
  //
  // Appending after truncation guarantees they differ without depending on how
  // the base string truncates. (A prefix would work too — slice keeps the head
  // — but then the id's meaningful tail is what gets cut, and the timestamp is
  // the part that distinguishes one bar's order from the next.)
  return `${compact}-${timeframe}-${candleTime}`.slice(0, 35) + kind;
}

async function scanSymbol({ exchange, symbol, timeframe, config, settings, dedupe, lastBar, breaker, positionBook = null, logger }) {
  const scanner = settings || config.scanner;
  const tf = timeframe || scanner.timeframe;
  const timeframeMs = timeframeToMs(exchange, tf);

  const key = `${symbol}:${tf}`;

  // Ask the exchange only when a new bar can actually have closed.
  //
  // The dedupe below already threw away repeats — but it did so AFTER the
  // call, so a 30m symbol was fetched sixty times an hour to use two of them.
  // Nineteen symbols on a 60s sweep was enough for Bybit to start answering
  // "Too many visits. Exceeded the API Rate Limit." and for the scanner to
  // skip that symbol's bar entirely, which is a missed flip and not just a
  // wasted request.
  //
  // `seen` is the OPEN time of the last closed bar, so the next one closes a
  // further two timeframes on. If the exchange is late publishing it,
  // dropFormingCandle discards it, lastBar is unchanged, and the next sweep
  // simply asks again.
  const seen = lastBar.get(key);
  if (seen !== undefined && Date.now() < seen + 2 * timeframeMs) return null;

  const raw = await exchange.fetchOHLCV(symbol, tf, undefined, scanner.candleLimit);
  const candles = dropFormingCandle(toCandles(raw), timeframeMs);

  if (candles.length < scanner.minCandles) {
    logger.warn(`[scanner] ${symbol}: only ${candles.length} closed candles, need ${scanner.minCandles}`);
    return null;
  }

  const bar = candles[candles.length - 1].t;
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
    `rr=${signal.rr == null ? 'no target — stop only' : signal.rr.toFixed(2)}, ` +
    `entry=${signal.entry?.toFixed(2)}, stop=${signal.stop?.toFixed(2)}`
  );

  if (!scanner.execute) {
    logger.log('[scanner]   SCANNER_EXECUTE is false — signal logged, not sent.');
    return { signal, sent: false };
  }

  // Always-in trend following. A Supertrend flip means the trend it was
  // trading has ended, so the position it opened is what the new signal is
  // arguing against — closing it first is the whole point of the signal, not
  // a side effect. Without this the first flip opens a position and every
  // later one is refused while it is still open, so a symbol trades once and
  // then goes quiet until its stop is hit.
  //
  // The close is attempted rather than predicated on a position lookup: the
  // order path already reads the position book to size a reduceOnly order,
  // and asking first would be a second read of the same thing that can
  // disagree with it.
  // A resync is an entry into a trend that already started, so it is only
  // ever right when the symbol is flat. Asked here rather than inferred from
  // a failed reduceOnly close: adding to a position that is already on the
  // correct side would be the one outcome nobody asked for, and it would look
  // like the feature working.
  if (signal.kind === 'resync') {
    // findPosition THROWS a 404 when there is nothing open — flat is the case
    // this feature exists for, so it is the success path here, not an error.
    // Reading it as a failure made the resync skip in both directions, which
    // is a feature that silently does nothing.
    let open = null;
    try {
      if (positionBook) {
        // Shared across the sweep. Returns [] when flat rather than throwing.
        const rows = await positionBook.openFor(symbol);
        open = rows.length > 0 ? rows : null;
      } else {
        // findPosition THROWS a 404 when nothing is open — flat is the case
        // this feature exists for, so it is the success path here, not an
        // error. Reading it as a failure made the resync skip in both
        // directions: a feature that silently did nothing.
        open = await findPosition(exchange, symbol);
      }
    } catch (err) {
      if (!/No open position/i.test(err.message)) {
        logger.warn(`[scanner]   could not read the position book (${err.message}) — resync skipped`);
        return { signal, sent: false, error: err.message };
      }
    }
    if (open) {
      const sides = [...new Set(open.map((p) => p.side))].join('/');
      logger.log(`[scanner]   already ${sides} on ${symbol} — nothing to resync`);
      return { signal, sent: false };
    }
    logger.warn(`[scanner]   RESYNC ${symbol}: flat inside the trend, entering ${signal.side} at the current line`);
  }

  let justClosed = false;
  // Nothing to reverse out of on a resync — being flat is what qualified it.
  if (scanner.reverse && signal.kind !== 'resync') {
    // Ask whether the entry could go in BEFORE giving up the position that is
    // open. A reversal that closes and then fails to enter leaves the account
    // flat after a signal that asked to be reversed — out of the market, with
    // nothing on screen saying so, which is the worst outcome available here
    // and the one that was reported. Evaluated as though the symbol were
    // already flat, because the position about to be closed is what would
    // otherwise refuse it.
    try {
      await executeTrade(
        validateTradeRequest(
          {
            exchange: exchange.id,
            symbol,
            side: signal.side,
            stopPrice: Number.isFinite(signal.stop) ? signal.stop : undefined,
            targetPrice: Number.isFinite(signal.target) ? signal.target : undefined,
          },
          { [exchange.id]: exchange }
        ),
        { config, dedupe, breaker, logger, requestId: `scan-${bar}-check`,
          preflight: true, ignoreOpenPosition: true }
      );
    } catch (err) {
      logger.warn(
        `[scanner]   NOT reversing ${symbol}: the ${signal.side} entry would be refused `
        + `(${err.message}). The open position is left alone rather than closed into nothing.`
      );
      return { signal, sent: false, error: err.message };
    }

    const closeRequest = validateTradeRequest(
      {
        exchange: exchange.id,
        symbol,
        // Selling closes a long and buying closes a short, so the closing leg
        // takes the same side as the signal that replaces it.
        side: signal.side,
        reduceOnly: true,
        clientOrderId: signalId(symbol, tf, bar, 'x'),
      },
      { [exchange.id]: exchange }
    );
    try {
      const closed = await executeTrade(closeRequest, {
        config,
        dedupe,
        breaker,
        logger,
        requestId: `scan-${bar}-close`,
      });
      logger.log(`[scanner]   reversed out of the opposite position first (${closed.status || 'sent'})`);
      justClosed = true;
    } catch (err) {
      // Flat already is the ordinary case — most flips arrive with nothing to
      // close — so it is not worth a warning.
      if (/No open position/i.test(err.message)) {
        logger.log('[scanner]   nothing open to reverse out of');
      } else {
        // Any other failure means the old position may still be there. Opening
        // the opposite now would either be refused as a flip, or in a hedge
        // account leave both directions on at once — neither is what the
        // signal asked for, so the entry is abandoned and retried next bar.
        logger.warn(`[scanner]   could not close the opposite position (${err.message}) — entry skipped`);
        return { signal, sent: false, error: err.message };
      }
    }
  }

  const request = validateTradeRequest(
    {
      exchange: exchange.id,
      symbol,
      side: signal.side,
      // A resync gets its own id: same symbol, same bar, different
      // intention — and the dedupe cache must not treat them as one.
      clientOrderId: signalId(symbol, tf, bar, signal.kind === 'resync' ? 'r' : undefined),
      // The pattern's own invalidation level and measured-move target. More
      // meaningful than a fixed percentage, and what the R:R filter was
      // computed from — so the trade taken matches the trade evaluated.
      stopPrice: Number.isFinite(signal.stop) ? signal.stop : undefined,
      targetPrice: Number.isFinite(signal.target) ? signal.target : undefined,
    },
    { [exchange.id]: exchange }
  );

  const opts = {
    config,
    dedupe,
    // A sweep can fire several entries. Without this the breaker was
    // consulted once before the sweep and never again, so the trades after
    // the one that broke the limit still went out.
    breaker,
    logger,
    requestId: `scan-${bar}`,
  };

  try {
    // A reversal reads the position book twice: once to size the close, once
    // to check the entry is not fighting an open position. Between those two
    // reads the exchange has to have registered the fill. Bybit usually has,
    // but "usually" on an unattended loop means the occasional flip closes
    // and then refuses to enter — leaving the account FLAT after a signal
    // that asked to be reversed, which looks like nothing happened at all.
    //
    // Only retried when this pass actually closed something, and only on that
    // one refusal: the flip guard is a real answer when reverse is off, and
    // retrying it there would be arguing with a correct refusal. Nothing has
    // been sent to the exchange when it throws, so re-attempting places no
    // duplicate order.
    let result = null;
    for (let attempt = 1; ; attempt += 1) {
      try {
        result = await executeTrade(request, opts);
        break;
      } catch (err) {
        const stale = justClosed && /opposite \w+ position is open/i.test(err.message);
        if (!stale || attempt >= 3) throw err;
        logger.log(
          `[scanner]   position book still shows the position just closed; `
          + `retrying the entry (${attempt}/3)`
        );
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
    return { signal, sent: true, result };
  } catch (err) {
    // A refused signal is normal operation (position cap, opposite position,
    // size below minimum). It must not stop the scan loop.
    logger.warn(`[scanner]   not executed: ${err.message}`);
    return { signal, sent: false, error: err.message };
  }
}

async function runScan({ exchanges, config, riskSettings, settings, dedupe, lastBar, breaker, breakers, logger = console }) {
  // Resolved per sweep, not captured at startup. Size and leverage are runtime
  // settings now, and a config merged once at boot would keep sending orders
  // at yesterday's size however many times the panel was changed.
  config = riskConfig(config, riskSettings);
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
      // Equity, not the wallet: an open position's loss counts toward the
      // day as it happens, not only once it is closed.
      const equity = breakerEquity(balance, 'USDT');

      // Cold start mid-day: no persisted baseline, and taking the current
      // (already reduced) equity as the baseline would hand back the full
      // daily allowance. Ask the exchange what the day actually did.
      if (breaker.needsBaseline(equity)) {
        const baseline = await reconstructBaseline({ exchange, equity, logger });
        breaker.adoptBaseline(baseline, logger, equity);
      }

      // One ledger read answers both questions below.
      const ledger = await readLedgerDay({ exchange, since: utcMidnight(), logger });

      // Transfers first, and before the loss is measured: a deposit that has
      // not been folded in yet makes the baseline too low, and the very next
      // reading would be judged against the balance from before the money
      // arrived.
      breaker.noteCashFlow(ledger && ledger.cash, logger);

      breaker.update(equity, logger);

      // Closed-trade results, which is what the consecutive-loss limit is
      // actually about. A venue that cannot report them leaves the streak
      // untouched rather than resetting it — "cannot tell" is not "no losses".
      breaker.recordOutcomes(ledger && ledger.outcomes, logger);
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

  // Built per sweep and read at most once, only if a resync needs it.
  const positionBook = makePositionBook(exchange);

  const startedAt = Date.now();
  let combinations = 0;

  for (const symbol of scanner.symbols) {
    // A tuned symbol is scanned on its own timeframe and parameters. Only
    // those two: strategy, exchange, execute and reverse are decisions about
    // the ACCOUNT, and letting a per-symbol entry change them would make the
    // panel's own switches describe only some of what is running.
    const tuning = (scanner.overrides || {})[symbol] || null;
    const symbolTimeframes = tuning && tuning.timeframe ? [tuning.timeframe] : timeframes;
    const symbolSettings = tuning
      ? { ...scanner, supertrend: { ...scanner.supertrend, ...(tuning.supertrend || {}) } }
      : scanner;

    for (const timeframe of symbolTimeframes) {
      combinations += 1;
      try {
        await scanSymbol({ exchange, symbol, timeframe, config, settings: symbolSettings, dedupe, lastBar, breaker, positionBook, logger });
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
    overrides: JSON.parse(JSON.stringify(config.scanner.overrides || {})),
  };
}

function createBreakers({ config, logger = console }) {
  const breakers = new Map();

  // Limits set at runtime, applied on the way out of for() rather than only
  // when they change. A venue's breaker is created lazily, on its first
  // signal, so one created after a change would otherwise be born with the
  // boot value — a halt limit that silently differs per exchange depending on
  // which one traded first.
  let live = null;
  const apply = (breaker) => {
    if (live) {
      breaker.maxDailyLossPercent = live.maxDailyLossPercent;
      breaker.maxConsecutiveLosses = live.maxConsecutiveLosses;
    }
    return breaker;
  };

  return {
    for(exchangeId) {
      if (!breakers.has(exchangeId)) {
        breakers.set(exchangeId, createBreaker({ config, logger, exchangeId }));
      }
      return apply(breakers.get(exchangeId));
    },
    entries() {
      return [...breakers.entries()];
    },
    /** Takes effect on the next check, on every venue, without a restart. */
    setLimits(limits) {
      live = limits;
      for (const [, breaker] of breakers) apply(breaker);
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

function startScanner({ exchanges, config, riskSettings, settings, dedupe, breaker, breakers, logger = console }) {
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
      await runScan({ exchanges, config, riskSettings, settings: scanner, dedupe, lastBar, breaker, breakers, logger });
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
  readClosedTradeOutcomes,
  readLedgerDay,
  isRealisedPnl,
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

'use strict';

/**
 * Paper-trading the stock opening-range breakout, forward, on Weex.
 *
 * The backtest (orb-stocks.mjs) found one candidate worth watching: the 15
 * minute range after the New York open, on whichever stock perp is most
 * unusually active. It made +17.8bp a trade after costs over a year — and
 * missed its own pre-set bar, and lost everything without its best 5 of 217
 * trades, and there is no older data to check it against. The only honest
 * test left is the future.
 *
 * This runs that test. It PLACES NOTHING. Each New York session it:
 *
 *   09:45  picks the symbol, from Weex's own 15-minute bars
 *   ...    watches the pick; the moment it breaks, reads Weex's order book and
 *          records what a $50 and a $500 order would actually have paid —
 *          the thing a year of Bitget bars could not say, and the thing most
 *          likely to sink the strategy, since its whole profit came from
 *          big-move days on thin books
 *   16:05  settles the day with the same orb-core code the backtest used, for
 *          the pick AND for every other candidate, so the random-symbol and
 *          random-direction controls can be computed on forward data too
 *
 * State lives in STATE_DIR so a redeploy mid-session resumes rather than
 * forgets, and a day missed while the server was down is settled on the next
 * tick while Weex still has its bars.
 */

const fs = require('fs');
const path = require('path');
const nytime = require('./nytime');

const STATE_FILE = 'paper-orb.json';

const OR_MIN = 15;
const MIN1 = 60000;
const MIN5 = 5 * MIN1;
const MIN15 = 15 * MIN1;
const HOLD = 6.5 * 3600000;
const LOOKBACK = 10;
const MIN_LOOKBACK = 5;
const SELECT_DELAY = 30 * 1000;          // let the 09:30 bar close and publish
const SETTLE_DELAY = 5 * MIN1;           // let the 15:55 bar close and publish
const STALE_AFTER = 150 * 1000;          // a break seen this late: book read is not a fill
const FILL_SIZES = [50, 500];
const SLIP_BPS = 4;
const DEFAULT_TAKER_BPS = 8;

/** The stock perps the backtest ran on — listed on both Bitget and Weex. */
const BASES = [
  'MSTR', 'NVDA', 'TSLA', 'AAPL', 'COIN', 'HOOD', 'AMD', 'META', 'GOOGL', 'AMZN',
  'MSFT', 'SPY', 'QQQ', 'CRCL', 'GME', 'PLTR', 'NFLX', 'AVGO', 'BABA', 'INTC',
  'MARA', 'TSM',
];

const RULE = {
  name: 'Stock opening-range breakout',
  range: '09:30-09:45 New York',
  pick: `the stock perp whose 15-minute volume is highest against its previous ${LOOKBACK} sessions`,
  entry: 'the first break of that range, long above or short below',
  stop: 'the other side of the range',
  exit: 'the stop, or 16:00 New York',
  costs: `taker ${DEFAULT_TAKER_BPS}bp a side plus ${SLIP_BPS}bp slippage per stop fill`,
};

/* ------------------------------------------------------------------ *
 * Pure pieces
 * ------------------------------------------------------------------ */

/** Today's session times, or null when New York is not trading. */
function sessionFor(now) {
  const day = Math.floor(now / 86400000) * 86400000;
  if (!nytime.isNyseSession(day)) return null;
  const anchor = nytime.nyOpenUtc(day);
  return {
    date: nytime.isoDate(day),
    day,
    anchor,
    orEnd: anchor + OR_MIN * MIN1,
    close: anchor + HOLD,
    settleAt: anchor + HOLD + SETTLE_DELAY,
  };
}

/**
 * What the tracker should be doing now.
 *
 * Selection can happen late — after a restart — because the pick depends only
 * on the opening-range bars, so it is the same pick whenever it is computed.
 * What a late selection cannot do is measure the fill; `watch` flags that.
 */
function phaseOf(now, session, rec) {
  if (!session) return 'closed';
  if (now < session.orEnd + SELECT_DELAY) return 'waiting';
  if (!rec || !rec.selectedAt) return 'select';
  if (rec.settled) return 'done';
  if (now >= session.settleAt) return 'settle';
  if (rec.pick && !rec.break && now < session.close) return 'watch';
  return 'holding';
}

/**
 * The opening range from bars of any size, or null if any bar is missing.
 *
 * Quote volume (base volume times close) so symbols with very different
 * prices compare on the same footing.
 */
function rangeFromBars(rows, anchor, barMs, orMin = OR_MIN) {
  const need = (orMin * MIN1) / barMs;
  let hi = -Infinity, lo = Infinity, vol = 0, count = 0;
  for (const [t, , h, l, c, v] of rows || []) {
    if (t < anchor || t >= anchor + orMin * MIN1) continue;
    hi = Math.max(hi, h);
    lo = Math.min(lo, l);
    vol += (Number(v) || 0) * (Number(c) || 0);
    count += 1;
  }
  if (count !== need || !(hi > lo)) return null;
  return { hi, lo, vol };
}

/**
 * The previous `LOOKBACK` sessions before `day`, most recent first.
 *
 * Sessions, not calendar days: a Monday's lookback reaches back past the
 * weekend, and a holiday is skipped rather than counted as a quiet day.
 */
function previousSessions(day, count = LOOKBACK, maxDaysBack = 40) {
  const out = [];
  for (let d = day - 86400000, n = 0; n < maxDaysBack && out.length < count; d -= 86400000, n += 1) {
    if (nytime.isNyseSession(d)) out.push(d);
  }
  return out;
}

/**
 * Rank today's candidates by opening-range volume against their own history.
 *
 * `history[symbol]` maps a session date to that session's range volume. A
 * symbol with fewer than MIN_LOOKBACK past sessions is not a candidate: a
 * relative figure against two days is noise, and a newly listed perp would
 * otherwise look extraordinarily busy on its second day.
 */
function rankCandidates(today, history, pastDates) {
  const candidates = [];
  for (const [symbol, range] of Object.entries(today)) {
    if (!range) continue;
    const past = pastDates.map((d) => history[symbol]?.[d]).filter((v) => Number.isFinite(v) && v > 0);
    if (past.length < MIN_LOOKBACK) continue;
    const avg = past.reduce((a, b) => a + b, 0) / past.length;
    candidates.push({ symbol, hi: range.hi, lo: range.lo, vol: range.vol, relVol: range.vol / avg, lookback: past.length });
  }
  candidates.sort((a, b) => b.relVol - a.relVol);
  return candidates;
}

/**
 * The first break of the range among 1-minute bars in [from, until).
 *
 * The forming bar counts: if its high is already through the level, a trade
 * happened there and a stop order would have triggered. A bar through both
 * sides is reported as such — which came first cannot be known.
 */
function detectBreak(rows, hi, lo, from, until) {
  const sorted = [...(rows || [])].sort((a, b) => a[0] - b[0]);
  for (const [t, , h, l] of sorted) {
    if (t < from || t >= until) continue;
    const up = h > hi;
    const dn = l < lo;
    if (up && dn) return { both: true, at: t };
    if (up) return { dir: 1, at: t, level: hi };
    if (dn) return { dir: -1, at: t, level: lo };
  }
  return null;
}

/**
 * What an order of `notionalUsd` would pay crossing one side of the book.
 *
 * A long buys through the asks, a short sells through the bids — the same
 * asymmetry entry.js exists for. `complete` is false when the whole visible
 * book could not absorb the order, which on these perps is a real outcome.
 */
function sideFill(book, dir, notionalUsd) {
  const levels = (dir === 1 ? book?.asks : book?.bids) || [];
  const best = Number(levels[0]?.[0]);
  let need = notionalUsd, spent = 0, base = 0;
  for (const level of levels) {
    const p = Number(level[0]);
    const a = Number(level[1]);
    if (!(p > 0) || !(a > 0)) continue;
    const take = Math.min(p * a, need);
    spent += take;
    base += take / p;
    need -= take;
    if (need <= 1e-9) break;
  }
  const avg = base > 0 ? spent / base : NaN;
  return {
    best: Number.isFinite(best) ? best : NaN,
    avg,
    filledUsd: spent,
    complete: spent >= notionalUsd * 0.999,
  };
}

const bps = (x) => x * 10000;

/**
 * Totals across settled sessions, with the controls as exact expectations.
 *
 * No random draws: the expected result of picking a random candidate is the
 * average over all of them, and of flipping a coin on the pick is the average
 * of its two directions. Both are recorded at settlement, so the comparison is
 * exact rather than one noisy sample.
 */
function summarise(state) {
  const sessions = Object.values(state.sessions || {}).sort((a, b) => (a.date < b.date ? -1 : 1));
  const settled = sessions.filter((s) => s.settled);
  const traded = settled.filter((s) => Number.isFinite(s.settled.result?.net));
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const median = (xs) => {
    if (!xs.length) return NaN;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  const nets = traded.map((s) => s.settled.result.net);
  const realistic = traded.map((s) => s.settled.realisticNet).filter(Number.isFinite);

  // Controls, only on sessions where the pick itself traded, so all three
  // averages describe the same days.
  const randomSymbol = [];
  const randomDirection = [];
  for (const s of traded) {
    const c = s.settled.controls || {};
    const naturals = Object.values(c).map((x) => x?.natural).filter(Number.isFinite);
    if (naturals.length) randomSymbol.push(mean(naturals));
    const own = c[s.pick.symbol];
    if (own && Number.isFinite(own.natural) && Number.isFinite(own.against)) {
      randomDirection.push((own.natural + own.against) / 2);
    }
  }

  // Fill quality counts only readings taken close to the break: a book read
  // minutes later describes a different market.
  const fills = {};
  for (const size of FILL_SIZES) {
    const usable = sessions.filter((s) => s.break?.fills && !s.break.stale)
      .map((s) => s.break.fills.find((f) => f.usd === size))
      .filter(Boolean);
    fills[size] = {
      n: usable.length,
      meanSlipBps: mean(usable.map((f) => f.slipBps).filter(Number.isFinite)),
      completeShare: usable.length ? usable.filter((f) => f.complete).length / usable.length : NaN,
    };
  }

  return {
    sessions: sessions.length,
    settled: settled.length,
    trades: traded.length,
    noTrade: settled.length - traded.length,
    meanBps: bps(mean(nets)),
    medianBps: bps(median(nets)),
    winShare: nets.length ? nets.filter((x) => x > 0).length / nets.length : NaN,
    // No trades is no total, not a total of zero — the same distinction as
    // everything else here.
    totalBps: nets.length ? bps(nets.reduce((a, b) => a + b, 0)) : NaN,
    realistic: { n: realistic.length, meanBps: bps(mean(realistic)) },
    controls: {
      randomSymbolBps: bps(mean(randomSymbol)),
      randomDirectionBps: bps(mean(randomDirection)),
      n: randomSymbol.length,
    },
    fills,
    staleBreaks: sessions.filter((s) => s.break?.stale).length,
  };
}

/* ------------------------------------------------------------------ *
 * The running tracker
 * ------------------------------------------------------------------ */

function emptyState() {
  return { version: 1, venue: null, sessions: {}, lastError: null };
}

function createPaperOrb({
  getExchange,
  stateDir = null,
  venue = 'weex',
  logger = console,
  now = Date.now,
  loadCore = () => import('./orb-core.mjs'),
} = {}) {
  const file = stateDir ? path.join(stateDir, STATE_FILE) : null;
  let state = load();
  let busy = false;
  let timer = null;

  function load() {
    if (!file) return emptyState();
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && parsed.version === 1 && parsed.sessions) return parsed;
    } catch (err) {
      if (err.code !== 'ENOENT') logger.warn(`[paper-orb] could not read ${file}: ${err.message} — starting empty`);
    }
    return emptyState();
  }

  function save() {
    if (!file) return;
    try {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, file);
    } catch (err) {
      logger.warn(`[paper-orb] could not save state: ${err.message}`);
    }
  }

  function exchange() {
    const ex = getExchange && getExchange();
    if (!ex) throw new Error(`no ${venue} exchange configured`);
    return ex;
  }

  function symbolsOn(ex) {
    return BASES.map((b) => `${b}/USDT:USDT`).filter((s) => ex.markets?.[s]?.swap);
  }

  function takerBps(ex, symbol) {
    const t = ex.markets?.[symbol]?.taker;
    return Number.isFinite(t) && t > 0 ? t * 10000 : DEFAULT_TAKER_BPS;
  }

  async function select(session, t) {
    const ex = exchange();
    const symbols = symbolsOn(ex);
    const pastDays = previousSessions(session.day);
    const pastDates = pastDays.map((d) => nytime.isoDate(d));

    const today = {};
    const history = {};
    for (const symbol of symbols) {
      let rows;
      try {
        rows = await ex.fetchOHLCV(symbol, '15m', undefined, 1000);
      } catch (err) {
        logger.warn(`[paper-orb] ${symbol} 15m: ${err.message}`);
        continue;
      }
      today[symbol] = rangeFromBars(rows, session.anchor, MIN15);
      history[symbol] = {};
      for (const d of pastDays) {
        const r = rangeFromBars(rows, nytime.nyOpenUtc(d), MIN15);
        if (r) history[symbol][nytime.isoDate(d)] = r.vol;
      }
    }

    // Weex keeps about ten days of 15-minute bars. Sessions older than that
    // come from what this tracker recorded when it saw them.
    for (const date of pastDates) {
      const old = state.sessions[date];
      for (const c of old?.candidates || []) {
        history[c.symbol] = history[c.symbol] || {};
        if (!Number.isFinite(history[c.symbol][date])) history[c.symbol][date] = c.vol;
      }
      for (const [symbol, vol] of Object.entries(old?.rangeVolumes || {})) {
        history[symbol] = history[symbol] || {};
        if (!Number.isFinite(history[symbol][date])) history[symbol][date] = vol;
      }
    }

    const candidates = rankCandidates(today, history, pastDates);
    const rangeVolumes = {};
    for (const [symbol, r] of Object.entries(today)) if (r) rangeVolumes[symbol] = r.vol;

    const rec = {
      date: session.date,
      anchor: session.anchor,
      selectedAt: t,
      lateSelection: t > session.orEnd + SELECT_DELAY + 2 * MIN1,
      candidates,
      rangeVolumes,
      pick: candidates[0] ? { symbol: candidates[0].symbol, hi: candidates[0].hi, lo: candidates[0].lo, relVol: candidates[0].relVol } : null,
      skipReason: candidates.length ? null : 'no symbol had enough history to rank',
      break: null,
      settled: null,
    };
    state.sessions[session.date] = rec;
    save();
    logger.log(`[paper-orb] ${session.date}: ${rec.pick
      ? `picked ${rec.pick.symbol} (${rec.pick.relVol.toFixed(2)}x usual), range ${rec.pick.lo}-${rec.pick.hi}`
      : rec.skipReason}`);
  }

  async function watch(session, rec, t) {
    const ex = exchange();
    // A short read when the last look was recent; a full one after a restart,
    // so a break that happened while the server was down is still found.
    const recent = rec.watchedAt && t - rec.watchedAt < 20 * MIN1;
    const rows = await ex.fetchOHLCV(rec.pick.symbol, '1m', undefined, recent ? 30 : 1000);
    rec.watchedAt = t;
    const brk = detectBreak(rows, rec.pick.hi, rec.pick.lo, session.orEnd, session.close);
    if (!brk) { save(); return; }

    if (brk.both) {
      rec.break = { both: true, at: brk.at, detectedAt: t };
      save();
      return;
    }

    const book = await ex.fetchOrderBook(rec.pick.symbol, 50);
    const lagMs = t - brk.at;
    const fills = FILL_SIZES.map((usd) => {
      const f = sideFill(book, brk.dir, usd);
      return {
        usd,
        ...f,
        // Against the range level: what the order paid beyond the price the
        // backtest assumed. Against the best price: the crossing alone.
        slipBps: Number.isFinite(f.avg) ? bps((brk.dir * (f.avg - brk.level)) / brk.level) : NaN,
        crossBps: Number.isFinite(f.avg) && f.best > 0 ? bps((brk.dir * (f.avg - f.best)) / f.best) : NaN,
      };
    });
    rec.break = {
      dir: brk.dir,
      at: brk.at,
      level: brk.level,
      detectedAt: t,
      lagSec: Math.round(lagMs / 1000),
      // Seen too long after it happened, the book no longer shows what a stop
      // order would have met, so this reading is kept but not counted.
      stale: Boolean(rec.lateSelection) || lagMs > STALE_AFTER,
      fills,
    };
    save();
    logger.log(`[paper-orb] ${session.date}: ${rec.pick.symbol} broke ${brk.dir === 1 ? 'up' : 'down'}` +
      ` — $50 would have paid ${fills[0].slipBps.toFixed(1)}bp past the level`);
  }

  async function settle(session, rec, t) {
    const ex = exchange();
    const core = await loadCore();
    const symbols = rec.candidates.map((c) => c.symbol);
    const controls = {};
    let result = null;

    for (const symbol of symbols) {
      const cost = core.makeCosts({ takerBps: takerBps(ex, symbol), slipBps: SLIP_BPS });
      let rows;
      try {
        rows = await ex.fetchOHLCV(symbol, '5m', undefined, 1000);
      } catch (err) {
        controls[symbol] = null;
        continue;
      }
      const idx = core.indexBars(rows);
      const range = core.openingRange(idx, session.anchor, OR_MIN);
      if (!range) { controls[symbol] = null; continue; }
      const nat = core.tradeBreakout(idx, session.anchor, OR_MIN, range, undefined, cost);
      if (nat.skipped) {
        controls[symbol] = { natural: null, against: null, dir: null, skipped: nat.skipped };
      } else {
        const against = core.tradeBreakout(idx, session.anchor, OR_MIN, range, -nat.dir, cost);
        controls[symbol] = { natural: nat.net, against: against.skipped ? null : against.net, dir: nat.dir };
      }
      if (symbol === rec.pick?.symbol) {
        result = nat.skipped
          ? { skipped: nat.skipped }
          : { dir: nat.dir, entry: nat.entry, exit: nat.exit, how: nat.how, gross: nat.gross, net: nat.net, riskFrac: nat.riskFrac };
      }
    }

    // The same trade, entered at the price Weex's book actually offered when
    // the break was seen — only when that reading is trustworthy and agrees
    // with the model about which way the break went.
    let realisticNet = null;
    const f50 = rec.break?.fills?.find((f) => f.usd === 50);
    if (result && Number.isFinite(result.net) && rec.break && !rec.break.stale && !rec.break.both
        && rec.break.dir === result.dir && f50 && f50.complete && Number.isFinite(f50.avg)) {
      const cost = core.makeCosts({ takerBps: takerBps(ex, rec.pick.symbol), slipBps: SLIP_BPS });
      realisticNet = (result.dir * (result.exit - f50.avg)) / f50.avg - cost.fee;
    }

    rec.settled = {
      at: t,
      result: result || (rec.pick ? { skipped: 'no bars for the pick' } : { skipped: rec.skipReason }),
      realisticNet,
      controls,
    };
    save();
    logger.log(`[paper-orb] ${session.date}: settled — ${Number.isFinite(result?.net)
      ? `${result.how}, ${bps(result.net).toFixed(1)}bp` : (rec.settled.result.skipped || 'no trade')}`);
  }

  /**
   * Settle any earlier session left open by downtime, while Weex still has
   * its 5-minute bars (about three days). Older than that, it is recorded as
   * unsettleable rather than guessed at.
   */
  async function settleBacklog(t) {
    const todayDate = nytime.isoDate(Math.floor(t / 86400000) * 86400000);
    for (const rec of Object.values(state.sessions)) {
      if (rec.date >= todayDate || rec.settled || !rec.selectedAt) continue;
      const day = Date.parse(`${rec.date}T00:00:00Z`);
      const session = sessionFor(day + 12 * 3600000);
      if (!session) continue;
      if (t - session.close > 3 * 86400000) {
        rec.settled = { at: t, result: { skipped: 'bars no longer available — server was down at the close' }, realisticNet: null, controls: {} };
        save();
        continue;
      }
      await settle(session, rec, t);
    }
  }

  async function tick() {
    if (busy) return 'busy';
    busy = true;
    const t = now();
    let phase = 'closed';
    try {
      await settleBacklog(t);
      const session = sessionFor(t);
      const rec = session ? state.sessions[session.date] : null;
      phase = phaseOf(t, session, rec);
      if (phase === 'select') await select(session, t);
      else if (phase === 'watch') await watch(session, rec, t);
      else if (phase === 'settle') await settle(session, rec, t);
      state.venue = venue;
      state.lastTickAt = t;
    } catch (err) {
      state.lastError = { at: t, phase, message: err.message };
      save();
      logger.warn(`[paper-orb] ${phase}: ${err.message}`);
    } finally {
      busy = false;
    }
    return phase;
  }

  function snapshot() {
    const t = now();
    const session = sessionFor(t);
    const rec = session ? state.sessions[session.date] || null : null;
    const recent = Object.values(state.sessions)
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .slice(0, 30)
      .map((s) => ({
        date: s.date,
        pick: s.pick,
        skipReason: s.skipReason,
        break: s.break ? { dir: s.break.dir, both: s.break.both, stale: s.break.stale, lagSec: s.break.lagSec, fills: s.break.fills } : null,
        result: s.settled?.result || null,
        realisticNet: s.settled?.realisticNet ?? null,
      }));
    return {
      venue,
      rule: RULE,
      now: t,
      holidaysUntil: nytime.NYSE_HOLIDAYS_UNTIL,
      today: session
        ? { date: session.date, opensAt: session.anchor, rangeEndsAt: session.orEnd, closesAt: session.close,
            phase: phaseOf(t, session, rec), record: rec }
        : { phase: 'closed' },
      summary: summarise(state),
      recent,
      lastError: state.lastError,
      lastTickAt: state.lastTickAt || null,
    };
  }

  function start(intervalMs = 20 * 1000) {
    if (timer) return;
    timer = setInterval(() => { tick(); }, intervalMs);
    if (timer.unref) timer.unref();
    tick();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { tick, snapshot, start, stop, _state: () => state };
}

module.exports = {
  createPaperOrb,
  sessionFor,
  phaseOf,
  rangeFromBars,
  previousSessions,
  rankCandidates,
  detectBreak,
  sideFill,
  summarise,
  RULE,
  BASES,
  FILL_SIZES,
  STATE_FILE,
};

'use strict';

/**
 * The forward paper tracker.
 *
 * Its whole value is being a fair test of a strategy that a year of backtest
 * could not settle, so most of what is asserted is fairness: the pick uses
 * only what was knowable at 09:45, the settlement uses exactly the backtest's
 * code, a book reading taken too late is not counted as a fill, and the
 * controls describe the same days as the result. And, above everything, that
 * it never places an order.
 *
 * The fake venue builds every candle from a per-minute script, so 1m, 5m and
 * 15m bars always agree with each other the way a real venue's do.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const nytime = require('../nytime');
const po = require('../paperorb');

const DAY = 86400000;
const MIN = 60000;
const THU = Date.UTC(2026, 8, 17);                 // Thursday, New York on EDT
const ANCHOR = THU + 13.5 * 3600000;               // 09:30 New York
const OR_END = ANCHOR + 15 * MIN;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const quiet = { log() {}, warn() {}, error() {} };

/**
 * A fake Weex.
 *
 * `orVol(symbol, date)` is the opening-range quote volume for a session.
 * `scripts[symbol](offsetMs)` gives a minute's [o, h, l, c] on THU after the
 * range, or null for a flat minute. `lateVol[symbol]` floods volume in AFTER
 * the range, which a fair pick must not see.
 */
function fakeWeex({ clock, orVol, scripts = {}, lateVol = {}, books = {}, symbols = ['NVDA', 'GME', 'HOOD', 'TSLA'], failOhlcv = false }) {
  const calls = [];
  const markets = {};
  for (const b of symbols) markets[`${b}/USDT:USDT`] = { swap: true, taker: 0.0008 };
  const ex = { markets, calls };

  for (const m of ['createOrder', 'createOrders', 'editOrder', 'cancelOrder', 'cancelAllOrders',
    'setLeverage', 'setMarginMode', 'setPositionMode', 'transfer', 'withdraw']) {
    ex[m] = async () => { calls.push(`TRADE:${m}`); throw new Error('the paper tracker must never trade'); };
  }

  function minute(symbol, m) {
    const day = Math.floor(m / DAY) * DAY;
    const anchor = nytime.nyOpenUtc(day);
    const open = nytime.isNyseSession(day) && m >= anchor && m < anchor + 6.5 * 3600000;
    const off = m - anchor;
    if (open && off < 15 * MIN) {
      // The range: a high of 101 in minute 2, a low of 99 in minute 7.
      const v = (orVol(symbol, iso(day)) || 0) / 15 / 100;
      if (off === 2 * MIN) return [100, 101, 99.95, 100, v];
      if (off === 7 * MIN) return [100, 100.05, 99, 100, v];
      return [100, 100.05, 99.95, 100, v];
    }
    const extra = open && day === THU ? (lateVol[symbol] || 0) : 0;
    const scripted = open && day === THU && scripts[symbol] ? scripts[symbol](off) : null;
    if (scripted) return [...scripted, 1 + extra];
    return [100, 100.05, 99.95, 100, 0.01 + extra];
  }

  ex.fetchOHLCV = async (symbol, tf, since, limit = 1000) => {
    calls.push(`ohlcv ${symbol.split('/')[0]} ${tf} ${limit}`);
    if (failOhlcv) throw new Error('venue is down');
    const ms = { '1m': MIN, '5m': 5 * MIN, '15m': 15 * MIN }[tf];
    const now = clock();
    const lastOpen = Math.floor(now / ms) * ms;
    const lastMinute = Math.floor(now / MIN) * MIN;
    const base = symbol.split('/')[0];
    const rows = [];
    for (let t = lastOpen - (limit - 1) * ms; t <= lastOpen; t += ms) {
      let o, h = -Infinity, l = Infinity, c, v = 0;
      for (let m = t; m < t + ms && m <= lastMinute; m += MIN) {
        const [mo, mh, ml, mc, mv] = minute(base, m);
        if (o === undefined) o = mo;
        h = Math.max(h, mh); l = Math.min(l, ml); c = mc; v += mv;
      }
      rows.push([t, o, h, l, c, v]);
    }
    return rows;
  };

  ex.fetchOrderBook = async (symbol) => {
    calls.push(`book ${symbol.split('/')[0]}`);
    return books[symbol.split('/')[0]] || { bids: [[99.9, 100]], asks: [[100.1, 100]] };
  };
  return ex;
}

const PAST = ['2026-09-16', '2026-09-15', '2026-09-14', '2026-09-11', '2026-09-10',
  '2026-09-09', '2026-09-08', '2026-09-04', '2026-09-03', '2026-09-02'];

/** GME breaks up at 09:55 and holds; NVDA breaks down at 10:30 and is stopped at 11:00. */
const SCRIPTS = {
  GME: (off) => {
    if (off < 25 * MIN) return null;
    if (off === 25 * MIN) return [100, 101.5, 99.98, 101.4];
    return [101.8, 101.85, 101.75, 101.8];
  },
  NVDA: (off) => {
    if (off < 60 * MIN) return null;
    if (off === 60 * MIN) return [100, 100.02, 98.6, 98.7];
    if (off < 90 * MIN) return [98.7, 98.75, 98.65, 98.7];
    if (off === 90 * MIN) return [98.7, 101.5, 98.65, 101.4];
    return [101.4, 101.45, 101.35, 101.4];
  },
};

/**
 * GME is quiet usually and busy today: 5x. NVDA is always busy and today
 * merely busier: 2x, but the larger absolute number. HOOD is ordinary in the
 * range and floods AFTER it. TSLA has only three sessions of history.
 */
function orVol(symbol, date) {
  const today = date === iso(THU);
  if (symbol === 'GME') return today ? 2500 : 500;
  if (symbol === 'NVDA') return today ? 8000 : 4000;
  if (symbol === 'HOOD') return 1000;
  if (symbol === 'TSLA') return ['2026-09-16', '2026-09-15', '2026-09-14'].includes(date) || today ? 1000 : 0;
  return 0;
}

const BOOKS = {
  GME: { bids: [[100.9, 50]], asks: [[101.02, 0.2], [101.10, 5]] },
  NVDA: { bids: [[98.97, 10]], asks: [[99.05, 10]] },
};

function rig(overrides = {}) {
  let t = overrides.start ?? ANCHOR - 3600000;
  const clock = () => t;
  const ex = fakeWeex({ clock, orVol, scripts: SCRIPTS, lateVol: { HOOD: 1e9 }, books: BOOKS, ...overrides.venue });
  const dir = overrides.stateDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'paperorb-'));
  const make = () => po.createPaperOrb({ getExchange: () => ex, stateDir: dir, logger: quiet, now: clock });
  return { ex, dir, make, tracker: make(), at: (ms) => { t = ms; }, clock };
}

/* ------------------------------------------------------------------ *
 * The calendar
 * ------------------------------------------------------------------ */

test('a session opens at 09:30 New York, in either season', () => {
  const s = po.sessionFor(THU + 15 * 3600000);
  assert.equal(s.anchor, ANCHOR);
  assert.equal(s.orEnd, ANCHOR + 15 * MIN);
  assert.equal(s.close, ANCHOR + 6.5 * 3600000);
  const winter = po.sessionFor(Date.UTC(2026, 10, 4, 15));
  assert.equal(new Date(winter.anchor).toISOString().slice(11, 16), '14:30');
});

test('weekends and NYSE holidays have no session', () => {
  assert.equal(po.sessionFor(Date.UTC(2026, 8, 19, 15)), null, 'Saturday');
  assert.equal(po.sessionFor(Date.UTC(2026, 10, 26, 15)), null, 'Thanksgiving');
});

test('the previous sessions skip weekends and holidays', () => {
  const prev = po.previousSessions(THU).map(iso);
  assert.deepEqual(prev, PAST, 'Labor Day and two weekends are stepped over');
});

test('the phases run in order', () => {
  const s = po.sessionFor(THU + 15 * 3600000);
  assert.equal(po.phaseOf(OR_END + 10 * 1000, s, null), 'waiting', 'the 09:30 bar has not published yet');
  assert.equal(po.phaseOf(OR_END + 60 * 1000, s, null), 'select');
  const picked = { selectedAt: 1, pick: { symbol: 'X' }, break: null, settled: null };
  assert.equal(po.phaseOf(OR_END + 5 * MIN, s, picked), 'watch');
  assert.equal(po.phaseOf(OR_END + 5 * MIN, s, { ...picked, break: { dir: 1 } }), 'holding');
  assert.equal(po.phaseOf(s.close + 1, s, picked), 'holding', 'no new watching after the bell');
  assert.equal(po.phaseOf(s.settleAt, s, picked), 'settle');
  assert.equal(po.phaseOf(s.settleAt, s, { ...picked, settled: {} }), 'done');
  assert.equal(po.phaseOf(OR_END + 5 * MIN, null, null), 'closed');
});

/* ------------------------------------------------------------------ *
 * Pure pieces
 * ------------------------------------------------------------------ */

test('the range is read from whichever bar size is available', () => {
  const rows15 = [[ANCHOR, 100, 101, 99, 100, 10]];
  assert.deepEqual(po.rangeFromBars(rows15, ANCHOR, 15 * MIN), { hi: 101, lo: 99, vol: 1000 });
  const rows5 = [0, 1, 2].map((k) => [ANCHOR + k * 5 * MIN, 100, 100 + k, 100 - k, 100, 1]);
  assert.deepEqual(po.rangeFromBars(rows5, ANCHOR, 5 * MIN), { hi: 102, lo: 98, vol: 300 });
  assert.equal(po.rangeFromBars(rows5.slice(0, 2), ANCHOR, 5 * MIN), null, 'a missing bar is no range');
  assert.equal(po.rangeFromBars([...rows15, [ANCHOR + 15 * MIN, 100, 200, 1, 100, 1]], ANCHOR, 15 * MIN).hi, 101,
    'a bar after the range does not widen it');
});

test('candidates rank by volume against their own history, not by size', () => {
  const pastDates = PAST;
  const hist = (v, n = 10) => Object.fromEntries(pastDates.slice(0, n).map((d) => [d, v]));
  const ranked = po.rankCandidates(
    { BIG: { hi: 1, lo: 0, vol: 8000 }, QUIET: { hi: 1, lo: 0, vol: 2500 }, NEW: { hi: 1, lo: 0, vol: 99999 } },
    { BIG: hist(4000), QUIET: hist(500), NEW: hist(1, 3) },
    pastDates,
  );
  assert.deepEqual(ranked.map((c) => c.symbol), ['QUIET', 'BIG'], 'NEW has too little history to be ranked');
  assert.equal(ranked[0].relVol, 5);
  assert.equal(ranked[0].lookback, 10);
});

test('the first break wins, and a bar through both sides is reported as such', () => {
  const at = (m) => ANCHOR + m * MIN;
  const rows = [
    [at(20), 100, 100.5, 99.5, 100],
    [at(30), 100, 99.8, 98.5, 98.6],            // down first
    [at(10), 100, 105, 95, 100],                 // inside the range window: ignored
    [at(40), 100, 101.5, 99.9, 101],
  ];
  assert.deepEqual(po.detectBreak(rows, 101, 99, OR_END, ANCHOR + 6.5 * 3600000), { dir: -1, at: at(30), level: 99 });
  assert.deepEqual(po.detectBreak([[at(20), 100, 102, 98, 100]], 101, 99, OR_END, at(400)), { both: true, at: at(20) });
  assert.equal(po.detectBreak([[at(400), 100, 102, 100, 100]], 101, 99, OR_END, at(390)), null, 'after the bell');
});

test('a long pays through the asks and a short through the bids', () => {
  const book = { bids: [[99, 1], [98, 100]], asks: [[101, 1], [102, 100]] };
  const long = po.sideFill(book, 1, 200);
  const short = po.sideFill(book, -1, 200);
  assert.equal(long.best, 101);
  assert.equal(short.best, 99);
  assert.ok(long.avg > 101 && long.avg < 102, `long average ${long.avg}`);
  assert.ok(short.avg < 99 && short.avg > 98, `short average ${short.avg}`);
  assert.equal(long.complete, true);
  const thin = po.sideFill({ asks: [[101, 0.1]] }, 1, 200);
  assert.equal(thin.complete, false, 'a book that cannot absorb the order says so');
  assert.ok(Math.abs(thin.filledUsd - 10.1) < 1e-9);
});

/* ------------------------------------------------------------------ *
 * The tracker, end to end
 * ------------------------------------------------------------------ */

test('nothing is fetched on a weekend or before the range has closed', async () => {
  const r = rig({ start: Date.UTC(2026, 8, 19, 15) });
  assert.equal(await r.tracker.tick(), 'closed');
  r.at(OR_END + 10 * 1000);
  assert.equal(await r.tracker.tick(), 'waiting');
  assert.equal(r.ex.calls.length, 0);
});

test('the pick is the most unusual symbol, judged only on the range', async () => {
  const r = rig();
  r.at(OR_END + 60 * 1000);
  assert.equal(await r.tracker.tick(), 'select');
  const rec = r.tracker._state().sessions[iso(THU)];
  assert.equal(rec.pick.symbol, 'GME/USDT:USDT', 'GME is 5x its usual; NVDA is bigger but only 2x');
  assert.equal(rec.pick.hi, 101);
  assert.equal(rec.pick.lo, 99);
  assert.ok(!rec.candidates.some((c) => c.symbol === 'TSLA/USDT:USDT'), 'three sessions of history is not enough');
  const hood = rec.candidates.find((c) => c.symbol === 'HOOD/USDT:USDT');
  assert.ok(Math.abs(hood.relVol - 1) < 1e-9, 'the flood of volume after 09:45 was not seen');
  assert.equal(rec.lateSelection, false);
});

test('older sessions come from what was recorded, when the venue no longer has them', async () => {
  const r = rig();
  // Weex's 15m window reaches seven sessions back. Seed the three older ones
  // with a volume that would change GME's ratio if it were used.
  const state = { version: 1, sessions: {} };
  for (const d of ['2026-09-04', '2026-09-03', '2026-09-02']) {
    state.sessions[d] = { date: d, rangeVolumes: { 'GME/USDT:USDT': 2500 } };
  }
  fs.writeFileSync(path.join(r.dir, po.STATE_FILE), JSON.stringify(state));
  const tracker = r.make();
  r.at(OR_END + 60 * 1000);
  await tracker.tick();
  const gme = tracker._state().sessions[iso(THU)].candidates.find((c) => c.symbol === 'GME/USDT:USDT');
  assert.equal(gme.lookback, 10, 'seven from the venue, three from the record');
  const expectedAvg = (7 * 500 + 3 * 2500) / 10;
  assert.ok(Math.abs(gme.relVol - 2500 / expectedAvg) < 1e-9);
});

test('the break is measured against the book the moment it is seen', async () => {
  const r = rig();
  r.at(OR_END + 60 * 1000);
  await r.tracker.tick();                                  // select
  r.at(ANCHOR + 20 * MIN);
  assert.equal(await r.tracker.tick(), 'watch');
  assert.equal(r.tracker._state().sessions[iso(THU)].break, null, 'nothing yet');
  r.at(ANCHOR + 26 * MIN);
  await r.tracker.tick();
  const brk = r.tracker._state().sessions[iso(THU)].break;
  assert.equal(brk.dir, 1);
  assert.equal(brk.level, 101);
  assert.equal(brk.stale, false);
  const f50 = brk.fills.find((f) => f.usd === 50);
  // $20.20 at 101.02, the rest at 101.10.
  const base = 0.2 + (50 - 101.02 * 0.2) / 101.10;
  assert.ok(Math.abs(f50.avg - 50 / base) < 1e-9);
  assert.ok(Math.abs(f50.slipBps - ((50 / base - 101) / 101) * 10000) < 1e-9);
  assert.ok(f50.slipBps > 6 && f50.slipBps < 7.5, `about 6.7bp past the level (${f50.slipBps})`);
  assert.equal(f50.complete, true);
  assert.ok(r.ex.calls.includes('book GME'));
  r.at(ANCHOR + 90 * MIN);
  assert.equal(await r.tracker.tick(), 'holding', 'once broken, nothing more to watch');
});

test('a break seen long after it happened is kept but not counted as a fill', async () => {
  const r = rig();
  r.at(ANCHOR + 60 * MIN);                                 // server came up late
  await r.tracker.tick();                                  // select, late
  await r.tracker.tick();                                  // watch finds the 09:55 break
  const rec = r.tracker._state().sessions[iso(THU)];
  assert.equal(rec.lateSelection, true);
  assert.equal(rec.break.stale, true);
  r.at(ANCHOR + 6.5 * 3600000 + 6 * MIN);
  await r.tracker.tick();                                  // settle
  const s = po.summarise(r.tracker._state());
  assert.equal(s.fills[50].n, 0, 'a stale reading is not fill evidence');
  assert.equal(r.tracker._state().sessions[iso(THU)].settled.realisticNet, null);
  assert.ok(Number.isFinite(s.meanBps), 'the model result still counts — the pick did not depend on timing');
});

test('settlement runs the backtest code, for the pick and every candidate', async () => {
  const core = await import('../orb-core.mjs');
  const r = rig();
  r.at(OR_END + 60 * 1000); await r.tracker.tick();
  r.at(ANCHOR + 26 * MIN); await r.tracker.tick();
  r.at(ANCHOR + 6.5 * 3600000 + 6 * MIN);
  assert.equal(await r.tracker.tick(), 'settle');
  const rec = r.tracker._state().sessions[iso(THU)];

  // The same computation, done directly with orb-core on the venue's 5m bars.
  const cost = core.makeCosts({ takerBps: 8, slipBps: 4 });
  const direct = async (symbol, forceDir) => {
    const idx = core.indexBars(await r.ex.fetchOHLCV(symbol, '5m', undefined, 1000));
    return core.tradeBreakout(idx, ANCHOR, 15, core.openingRange(idx, ANCHOR, 15), forceDir, cost);
  };
  const gme = await direct('GME/USDT:USDT');
  assert.equal(rec.settled.result.net, gme.net);
  assert.equal(rec.settled.result.how, 'time');
  assert.equal(rec.settled.result.dir, 1);

  const nvda = await direct('NVDA/USDT:USDT');
  assert.equal(rec.settled.controls['NVDA/USDT:USDT'].natural, nvda.net);
  assert.equal(nvda.how, 'stop', 'NVDA broke down and was stopped');
  assert.equal(rec.settled.controls['GME/USDT:USDT'].against, (await direct('GME/USDT:USDT', -1)).net);
  assert.equal(rec.settled.controls['HOOD/USDT:USDT'].natural, null, 'HOOD never broke');
  assert.equal(Object.keys(rec.settled.controls).length, rec.candidates.length, 'every candidate, not just the pick');

  // The realistic figure enters where the book said, and exits where the model did.
  const f50 = rec.break.fills.find((f) => f.usd === 50);
  const expected = (gme.exit - f50.avg) / f50.avg - cost.fee;
  assert.ok(Math.abs(rec.settled.realisticNet - expected) < 1e-12);
  assert.ok(rec.settled.realisticNet < rec.settled.result.net + 1e-12 || f50.avg < gme.entry,
    'paying through the book costs something');

  r.at(ANCHOR + 7 * 3600000);
  assert.equal(await r.tracker.tick(), 'done');
});

test('the summary compares the pick with the controls on the same days', async () => {
  const r = rig();
  r.at(OR_END + 60 * 1000); await r.tracker.tick();
  r.at(ANCHOR + 26 * MIN); await r.tracker.tick();
  r.at(ANCHOR + 6.5 * 3600000 + 6 * MIN); await r.tracker.tick();
  const rec = r.tracker._state().sessions[iso(THU)];
  const s = po.summarise(r.tracker._state());
  const c = rec.settled.controls;
  assert.equal(s.trades, 1);
  assert.ok(Math.abs(s.meanBps - rec.settled.result.net * 10000) < 1e-9);
  const naturals = Object.values(c).map((x) => x.natural).filter(Number.isFinite);
  assert.equal(naturals.length, 2, 'GME and NVDA broke; HOOD did not');
  assert.ok(Math.abs(s.controls.randomSymbolBps - (naturals.reduce((a, b) => a + b, 0) / 2) * 10000) < 1e-9);
  const g = c['GME/USDT:USDT'];
  assert.ok(Math.abs(s.controls.randomDirectionBps - ((g.natural + g.against) / 2) * 10000) < 1e-9);
  assert.equal(s.fills[50].n, 1);
  assert.equal(s.realistic.n, 1);
});

test('a restart resumes the session rather than starting it again', async () => {
  const r = rig();
  r.at(OR_END + 60 * 1000); await r.tracker.tick();
  const first = r.tracker._state().sessions[iso(THU)].selectedAt;
  r.tracker.stop();
  const again = r.make();                                  // a redeploy
  r.at(ANCHOR + 26 * MIN);
  assert.equal(await again.tick(), 'watch', 'it carries on watching');
  assert.equal(again._state().sessions[iso(THU)].selectedAt, first, 'the pick was not remade');
  assert.equal(again._state().sessions[iso(THU)].break.dir, 1);
});

test('a session missed at the close is settled the next day', async () => {
  const r = rig();
  r.at(OR_END + 60 * 1000); await r.tracker.tick();
  // The server is down from here until Friday morning.
  r.at(THU + DAY + 12 * 3600000);
  await r.tracker.tick();
  const rec = r.tracker._state().sessions[iso(THU)];
  assert.ok(rec.settled, 'Thursday was settled on Friday');
  assert.ok(Number.isFinite(rec.settled.result.net));
});

test('a session missed by days is marked, not guessed at', async () => {
  const r = rig();
  r.at(OR_END + 60 * 1000); await r.tracker.tick();
  r.at(THU + 5 * DAY + 12 * 3600000);                      // the following Tuesday
  await r.tracker.tick();
  const rec = r.tracker._state().sessions[iso(THU)];
  assert.match(rec.settled.result.skipped, /no longer available/);
  assert.equal(po.summarise(r.tracker._state()).trades, 0);
});

test('a venue failure is recorded, not thrown', async () => {
  const r = rig({ venue: { failOhlcv: true } });
  r.at(OR_END + 60 * 1000);
  const phase = await r.tracker.tick();
  assert.equal(phase, 'select');
  const rec = r.tracker._state().sessions[iso(THU)];
  assert.equal(rec.pick, null, 'no data, no pick');
  assert.match(rec.skipReason, /enough history/);
});

test('an unconfigured venue is an error on the record, not a crash', async () => {
  let t = OR_END + 60 * 1000;
  const tracker = po.createPaperOrb({ getExchange: () => null, stateDir: null, logger: quiet, now: () => t });
  assert.equal(await tracker.tick(), 'select');
  assert.match(tracker.snapshot().lastError.message, /no weex exchange/);
});

test('it never places, edits or cancels anything', async () => {
  // Run a whole session, a restart and a backlog, then look at every call.
  const r = rig();
  for (const t of [ANCHOR - 3600000, OR_END + 60 * 1000, ANCHOR + 20 * MIN, ANCHOR + 26 * MIN,
    ANCHOR + 3 * 3600000, ANCHOR + 6.5 * 3600000 + 6 * MIN, ANCHOR + 7 * 3600000, THU + DAY + 15 * 3600000]) {
    r.at(t);
    await r.tracker.tick();
  }
  const trading = r.ex.calls.filter((c) => c.startsWith('TRADE:'));
  assert.deepEqual(trading, []);
  // Not vacuous: the session really was selected, watched, booked and settled.
  for (const kind of ['15m', '1m', '5m']) {
    assert.ok(r.ex.calls.some((c) => c.startsWith('ohlcv') && c.includes(` ${kind} `)), `it read ${kind} bars`);
  }
  assert.ok(r.ex.calls.includes('book GME'), 'and the order book');
});

test('state survives on disk and an unreadable file starts empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperorb-'));
  fs.writeFileSync(path.join(dir, po.STATE_FILE), '{not json');
  const tracker = po.createPaperOrb({ getExchange: () => null, stateDir: dir, logger: quiet, now: () => THU });
  assert.deepEqual(tracker._state().sessions, {});
});

test('the snapshot says what today is doing', async () => {
  const r = rig();
  r.at(OR_END + 60 * 1000); await r.tracker.tick();
  r.at(ANCHOR + 20 * MIN);
  const snap = r.tracker.snapshot();
  assert.equal(snap.today.date, iso(THU));
  assert.equal(snap.today.phase, 'watch');
  assert.equal(snap.today.record.pick.symbol, 'GME/USDT:USDT');
  assert.equal(snap.rule.range, '09:30-09:45 New York');
  assert.equal(snap.recent[0].date, iso(THU));
});

test('a short fill below the level is a cost, not a gain', async () => {
  // Every fill above was a long, where "times the direction" changes nothing.
  // Here NVDA is the pick and breaks down; selling at 98.97 against a 99 level
  // is paying 3bp, and must read as +3bp.
  const nvdaHot = (symbol, date) => {
    const today = date === iso(THU);
    if (symbol === 'NVDA') return today ? 9000 : 1000;
    return 1000;
  };
  let t = OR_END + 60 * 1000;
  const ex = fakeWeex({ clock: () => t, orVol: nvdaHot, scripts: SCRIPTS, books: BOOKS });
  const tracker = po.createPaperOrb({ getExchange: () => ex, stateDir: null, logger: quiet, now: () => t });
  await tracker.tick();
  assert.equal(tracker._state().sessions[iso(THU)].pick.symbol, 'NVDA/USDT:USDT');
  t = ANCHOR + 61 * MIN;
  await tracker.tick();
  const brk = tracker._state().sessions[iso(THU)].break;
  assert.equal(brk.dir, -1);
  const f50 = brk.fills.find((f) => f.usd === 50);
  assert.ok(Math.abs(f50.avg - 98.97) < 1e-9, `sold into the bid (${f50.avg})`);
  assert.ok(Math.abs(f50.slipBps - ((99 - 98.97) / 99) * 10000) < 1e-9, `a 3bp cost, got ${f50.slipBps}`);
  assert.ok(f50.slipBps > 0);
});

test('the controls leave out days the pick did not trade', () => {
  // Otherwise the pick's average and the controls' average describe different
  // days, and the comparison between them means nothing.
  const state = {
    version: 1,
    sessions: {
      '2026-09-16': {
        date: '2026-09-16', pick: { symbol: 'A' },
        settled: { result: { net: 0.01 }, controls: { A: { natural: 0.01, against: -0.02 }, B: { natural: 0.03 } } },
      },
      '2026-09-17': {
        date: '2026-09-17', pick: { symbol: 'A' },
        settled: { result: { skipped: 'no breakout' }, controls: { A: { natural: null }, B: { natural: 0.5 } } },
      },
    },
  };
  const s = po.summarise(state);
  assert.equal(s.trades, 1);
  assert.equal(s.noTrade, 1);
  assert.equal(s.controls.n, 1, 'only the day the pick traded');
  assert.ok(Math.abs(s.controls.randomSymbolBps - 200) < 1e-9, 'the average of A and B on the 16th, not B\'s 50% on the 17th');
  assert.ok(Math.abs(s.controls.randomDirectionBps - -50) < 1e-9);
});

test('no trades means no total, not a total of zero', () => {
  const s = po.summarise({ version: 1, sessions: { '2026-09-17': { date: '2026-09-17', pick: { symbol: 'A' }, selectedAt: 1 } } });
  assert.equal(s.trades, 0);
  assert.ok(Number.isNaN(s.totalBps), `got ${s.totalBps}`);
  assert.ok(Number.isNaN(s.meanBps));
});

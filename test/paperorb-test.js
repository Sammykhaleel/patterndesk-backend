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
  const topN = overrides.topN ?? 3;
  const make = () => po.createPaperOrb({ getExchange: () => ex, stateDir: dir, logger: quiet, now: clock, topN });
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
  const picked = { selectedAt: 1, picks: [{ symbol: 'X', break: null }, { symbol: 'Y', break: null }], settled: null };
  assert.equal(po.phaseOf(OR_END + 5 * MIN, s, picked), 'watch');
  const oneBroken = { ...picked, picks: [{ symbol: 'X', break: { dir: 1 } }, { symbol: 'Y', break: null }] };
  assert.equal(po.phaseOf(OR_END + 5 * MIN, s, oneBroken), 'watch', 'still watching while any pick is unbroken');
  const allBroken = { ...picked, picks: [{ symbol: 'X', break: { dir: 1 } }, { symbol: 'Y', break: { both: true } }] };
  assert.equal(po.phaseOf(OR_END + 5 * MIN, s, allBroken), 'holding');
  assert.equal(po.phaseOf(OR_END + 5 * MIN, s, { ...picked, picks: [] }), 'holding', 'no picks, nothing to watch');
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
 *
 * In the fake: GME is 5x its usual, NVDA 2x, HOOD 1x (with a flood of
 * volume after 09:45), TSLA too new to rank. So the top three are GME,
 * NVDA, HOOD. GME breaks up at 09:55 and holds; NVDA breaks down at 10:30
 * and is stopped at 11:00; HOOD never breaks.
 * ------------------------------------------------------------------ */

const today = (r) => r.tracker._state().sessions[iso(THU)];
const pickOf = (rec, base) => rec.picks.find((p) => p.symbol === `${base}/USDT:USDT`);

async function fullDay(r) {
  r.at(OR_END + 60 * 1000); await r.tracker.tick();          // select
  r.at(ANCHOR + 26 * MIN); await r.tracker.tick();           // GME breaks
  r.at(ANCHOR + 61 * MIN); await r.tracker.tick();           // NVDA breaks
  r.at(ANCHOR + 6.5 * 3600000 + 6 * MIN); await r.tracker.tick();   // settle
}

test('nothing is fetched on a weekend or before the range has closed', async () => {
  const r = rig({ start: Date.UTC(2026, 8, 19, 15) });
  assert.equal(await r.tracker.tick(), 'closed');
  r.at(OR_END + 10 * 1000);
  assert.equal(await r.tracker.tick(), 'waiting');
  assert.equal(r.ex.calls.length, 0);
});

test('the picks are the most unusual symbols, best first, judged only on the range', async () => {
  const r = rig();
  r.at(OR_END + 60 * 1000);
  assert.equal(await r.tracker.tick(), 'select');
  const rec = today(r);
  assert.deepEqual(rec.picks.map((p) => p.symbol.split('/')[0]), ['GME', 'NVDA', 'HOOD'],
    'GME is 5x, NVDA is bigger but only 2x, HOOD is 1x');
  assert.deepEqual(rec.picks.map((p) => p.rank), [1, 2, 3]);
  assert.equal(rec.topN, 3);
  assert.equal(rec.picks[0].hi, 101);
  assert.equal(rec.picks[0].lo, 99);
  assert.ok(!rec.candidates.some((c) => c.symbol === 'TSLA/USDT:USDT'), 'three sessions of history is not enough');
  assert.ok(Math.abs(pickOf(rec, 'HOOD').relVol - 1) < 1e-9, 'the flood of volume after 09:45 was not seen');
  assert.equal(rec.lateSelection, false);
});

test('one pick a day still works, and is exactly the first of the three', async () => {
  const r = rig({ topN: 1 });
  r.at(OR_END + 60 * 1000);
  await r.tracker.tick();
  assert.deepEqual(today(r).picks.map((p) => p.symbol), ['GME/USDT:USDT']);
});

test('older sessions come from what was recorded, when the venue no longer has them', async () => {
  const r = rig();
  // Weex's 15m window reaches seven sessions back. Seed the three older ones
  // with a volume that would change GME's ratio if it were used.
  const state = { version: 1, sessions: {} };
  for (const d of ['2026-09-04', '2026-09-03', '2026-09-02']) {
    state.sessions[d] = { date: d, rangeVolumes: { 'GME/USDT:USDT': 2500 }, picks: [], settled: { results: [], controls: {} } };
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

test('each break is measured against the book the moment it is seen', async () => {
  const r = rig();
  r.at(OR_END + 60 * 1000);
  await r.tracker.tick();                                  // select
  r.at(ANCHOR + 20 * MIN);
  assert.equal(await r.tracker.tick(), 'watch');
  assert.ok(today(r).picks.every((p) => !p.break), 'nothing yet');

  r.at(ANCHOR + 26 * MIN);
  await r.tracker.tick();
  const gme = pickOf(today(r), 'GME').break;
  assert.equal(gme.dir, 1);
  assert.equal(gme.level, 101);
  assert.equal(gme.stale, false);
  const f50 = gme.fills.find((f) => f.usd === 50);
  // $20.20 at 101.02, the rest at 101.10.
  const base = 0.2 + (50 - 101.02 * 0.2) / 101.10;
  assert.ok(Math.abs(f50.avg - 50 / base) < 1e-9);
  assert.ok(Math.abs(f50.slipBps - ((50 / base - 101) / 101) * 10000) < 1e-9);
  assert.ok(f50.slipBps > 6 && f50.slipBps < 7.5, `about 6.7bp past the level (${f50.slipBps})`);
  assert.equal(f50.complete, true);
  assert.equal(pickOf(today(r), 'NVDA').break, null, 'NVDA has not broken yet');

  r.at(ANCHOR + 40 * MIN);
  assert.equal(await r.tracker.tick(), 'watch', 'still watching the ones that have not broken');

  r.at(ANCHOR + 61 * MIN);
  await r.tracker.tick();
  assert.equal(pickOf(today(r), 'NVDA').break.dir, -1);
  assert.ok(r.ex.calls.includes('book GME') && r.ex.calls.includes('book NVDA'), 'a book read for each break');
  assert.ok(!r.ex.calls.includes('book HOOD'), 'and none for a symbol that has not broken');
  assert.equal(pickOf(today(r), 'HOOD').break, null);
});

test('a short fill below the level is a cost, not a gain', async () => {
  // NVDA breaks down. Selling at 98.97 against a 99 level is paying 3bp, and
  // must read as +3bp — every other fill here is a long, where "times the
  // direction" changes nothing.
  const r = rig();
  r.at(OR_END + 60 * 1000); await r.tracker.tick();
  r.at(ANCHOR + 61 * MIN); await r.tracker.tick();
  const f50 = pickOf(today(r), 'NVDA').break.fills.find((f) => f.usd === 50);
  assert.ok(Math.abs(f50.avg - 98.97) < 1e-9, `sold into the bid (${f50.avg})`);
  assert.ok(Math.abs(f50.slipBps - ((99 - 98.97) / 99) * 10000) < 1e-9, `a 3bp cost, got ${f50.slipBps}`);
  assert.ok(f50.slipBps > 0);
});

test('a break seen long after it happened is kept but not counted as a fill', async () => {
  const r = rig();
  r.at(ANCHOR + 70 * MIN);                                 // server came up late
  await r.tracker.tick();                                  // select, late
  await r.tracker.tick();                                  // watch finds both breaks
  const rec = today(r);
  assert.equal(rec.lateSelection, true);
  assert.equal(pickOf(rec, 'GME').break.stale, true);
  assert.equal(pickOf(rec, 'NVDA').break.stale, true);
  r.at(ANCHOR + 6.5 * 3600000 + 6 * MIN);
  await r.tracker.tick();                                  // settle
  const s = po.summarise(r.tracker._state());
  assert.equal(s.fills[50].n, 0, 'a stale reading is not fill evidence');
  assert.equal(s.staleBreaks, 2);
  assert.ok(today(r).settled.results.every((x) => x.realisticNet === null));
  assert.equal(s.trades, 2, 'the model results still count — the picks did not depend on timing');
});

test('one pick failing to read does not stop the others being watched', async () => {
  const r = rig();
  r.at(OR_END + 60 * 1000); await r.tracker.tick();
  const read = r.ex.fetchOHLCV;
  r.ex.fetchOHLCV = async (symbol, tf, ...rest) => {
    if (symbol.startsWith('GME') && tf === '1m') throw new Error('GME timed out');
    return read(symbol, tf, ...rest);
  };
  r.at(ANCHOR + 61 * MIN);
  await r.tracker.tick();
  assert.equal(pickOf(today(r), 'GME').break, null, 'GME could not be read');
  assert.equal(pickOf(today(r), 'NVDA').break.dir, -1, 'NVDA still was');
  assert.match(r.tracker.snapshot().lastError.message, /GME timed out/);
});

test('settlement runs the backtest code, for every pick and every candidate', async () => {
  const core = await import('../orb-core.mjs');
  const r = rig();
  r.at(OR_END + 60 * 1000); await r.tracker.tick();
  r.at(ANCHOR + 26 * MIN); await r.tracker.tick();
  r.at(ANCHOR + 61 * MIN); await r.tracker.tick();
  r.at(ANCHOR + 6.5 * 3600000 + 6 * MIN);
  assert.equal(await r.tracker.tick(), 'settle');
  const rec = today(r);
  const res = (base) => rec.settled.results.find((x) => x.symbol === `${base}/USDT:USDT`);

  // The same computation, done directly with orb-core on the venue's 5m bars.
  const cost = core.makeCosts({ takerBps: 8, slipBps: 4 });
  const direct = async (symbol, forceDir) => {
    const idx = core.indexBars(await r.ex.fetchOHLCV(symbol, '5m', undefined, 1000));
    return core.tradeBreakout(idx, ANCHOR, 15, core.openingRange(idx, ANCHOR, 15), forceDir, cost);
  };
  const gme = await direct('GME/USDT:USDT');
  const nvda = await direct('NVDA/USDT:USDT');
  assert.equal(res('GME').result.net, gme.net);
  assert.equal(res('GME').result.how, 'time');
  assert.equal(res('GME').rank, 1);
  assert.equal(res('NVDA').result.net, nvda.net);
  assert.equal(res('NVDA').result.how, 'stop', 'NVDA broke down and was stopped');
  assert.equal(res('NVDA').rank, 2);
  assert.match(res('HOOD').result.skipped, /no breakout/, 'HOOD never broke');

  assert.equal(rec.settled.controls['GME/USDT:USDT'].against, (await direct('GME/USDT:USDT', -1)).net);
  assert.equal(Object.keys(rec.settled.controls).length, rec.candidates.length, 'every candidate, not just the picks');

  // The realistic figures enter where each book said, and exit where the model did.
  const f50 = (base) => pickOf(rec, base).break.fills.find((f) => f.usd === 50);
  assert.ok(Math.abs(res('GME').realisticNet - ((gme.exit - f50('GME').avg) / f50('GME').avg - cost.fee)) < 1e-12);
  assert.ok(Math.abs(res('NVDA').realisticNet - (-(nvda.exit - f50('NVDA').avg) / f50('NVDA').avg - cost.fee)) < 1e-12);

  r.at(ANCHOR + 7 * 3600000);
  assert.equal(await r.tracker.tick(), 'done');
});

test('the summary counts every pick, keeps the first apart, and compares trade by trade', async () => {
  const r = rig();
  await fullDay(r);
  const rec = today(r);
  const s = po.summarise(r.tracker._state());
  const c = rec.settled.controls;
  const net = (base) => rec.settled.results.find((x) => x.symbol === `${base}/USDT:USDT`).result.net;

  assert.equal(s.topN, 3);
  assert.equal(s.trades, 2, 'GME and NVDA traded; HOOD did not');
  assert.ok(Math.abs(s.meanBps - ((net('GME') + net('NVDA')) / 2) * 10000) < 1e-9);
  assert.equal(s.byRank[1].trades, 1);
  assert.ok(Math.abs(s.byRank[1].meanBps - net('GME') * 10000) < 1e-9, 'the first pick on its own');
  assert.ok(Math.abs(s.byRank[2].meanBps - net('NVDA') * 10000) < 1e-9);
  assert.equal(s.byRank[3], undefined, 'no rank-3 trade to report');

  // Random symbol: the day's candidate average, once per trade taken.
  const naturals = Object.values(c).map((x) => x.natural).filter(Number.isFinite);
  const dayRandom = naturals.reduce((a, b) => a + b, 0) / naturals.length;
  assert.ok(Math.abs(s.controls.randomSymbolBps - dayRandom * 10000) < 1e-9);
  // Random direction: each traded pick's own two directions, averaged.
  const flip = (base) => (c[`${base}/USDT:USDT`].natural + c[`${base}/USDT:USDT`].against) / 2;
  assert.ok(Math.abs(s.controls.randomDirectionBps - ((flip('GME') + flip('NVDA')) / 2) * 10000) < 1e-9);
  assert.equal(s.controls.n, 2);

  assert.equal(s.fills[50].n, 2, 'a reading for each break');
  assert.equal(s.realistic.n, 2);
});

test('a day where no pick traded counts as a no-trade session, and adds nothing to the controls', () => {
  const state = {
    version: 1,
    sessions: {
      '2026-09-16': {
        date: '2026-09-16', topN: 2, picks: [{ symbol: 'A', rank: 1 }, { symbol: 'B', rank: 2 }],
        settled: {
          results: [
            { symbol: 'A', rank: 1, result: { net: 0.01 } },
            { symbol: 'B', rank: 2, result: { skipped: 'no breakout' } },
          ],
          controls: { A: { natural: 0.01, against: -0.02 }, B: { natural: null }, C: { natural: 0.03 } },
        },
      },
      '2026-09-17': {
        date: '2026-09-17', topN: 2, picks: [{ symbol: 'A', rank: 1 }],
        settled: { results: [{ symbol: 'A', rank: 1, result: { skipped: 'no breakout' } }], controls: { C: { natural: 0.5 } } },
      },
    },
  };
  const s = po.summarise(state);
  assert.equal(s.trades, 1);
  assert.equal(s.noTrade, 1);
  assert.equal(s.controls.n, 1, 'only the trade that happened');
  assert.ok(Math.abs(s.controls.randomSymbolBps - 200) < 1e-9, 'A and C on the 16th, not C\'s 50% on the 17th');
  assert.ok(Math.abs(s.controls.randomDirectionBps - -50) < 1e-9);
});

test('no trades means no total, not a total of zero', () => {
  const s = po.summarise({ version: 1, sessions: { '2026-09-17': { date: '2026-09-17', picks: [{ symbol: 'A', rank: 1 }], selectedAt: 1 } } });
  assert.equal(s.trades, 0);
  assert.ok(Number.isNaN(s.totalBps), `got ${s.totalBps}`);
  assert.ok(Number.isNaN(s.meanBps));
});

/* ------------------------------------------------------------------ *
 * Records written by the single-pick tracker
 * ------------------------------------------------------------------ */

test('an unsettled single-pick record widens to three and keeps what it saw', () => {
  // This is today's record on the live server: selected by the old code,
  // MSFT picked, candidates already ranked. Upgrading mid-session must add
  // the next two picks without losing MSFT's break.
  const old = {
    date: '2026-09-17', selectedAt: 1, lateSelection: true,
    candidates: [
      { symbol: 'MSFT', hi: 502.04, lo: 494.08, relVol: 20.77 },
      { symbol: 'INTC', hi: 107.14, lo: 104.84, relVol: 3.6 },
      { symbol: 'PLTR', hi: 177.38, lo: 172.82, relVol: 1.61 },
      { symbol: 'CRCL', hi: 83.94, lo: 82.71, relVol: 1.47 },
    ],
    pick: { symbol: 'MSFT', hi: 502.04, lo: 494.08, relVol: 20.77 },
    break: { dir: 1, at: 5, stale: true },
    settled: null,
  };
  const rec = po.normalise(old, 3);
  assert.deepEqual(rec.picks.map((p) => p.symbol), ['MSFT', 'INTC', 'PLTR']);
  assert.deepEqual(rec.picks[0].break, { dir: 1, at: 5, stale: true }, 'MSFT kept its break');
  assert.equal(rec.picks[1].break, null);
  assert.equal(rec.topN, 3);
  assert.equal(rec.pick, undefined, 'the old field is gone, so nothing reads it by mistake');
  assert.equal(rec.break, undefined);
});

test('a settled single-pick record stays a single pick', () => {
  // What was tested that day was one pick; rewriting it as three would claim
  // results for trades nobody was watching.
  const old = {
    date: '2026-09-16', selectedAt: 1,
    candidates: [{ symbol: 'GME' }, { symbol: 'NVDA' }],
    pick: { symbol: 'GME', hi: 101, lo: 99, relVol: 5 },
    break: { dir: 1 },
    settled: { at: 2, result: { net: 0.004, how: 'time' }, realisticNet: 0.003, controls: { GME: { natural: 0.004 } } },
  };
  const rec = po.normalise(old, 3);
  assert.equal(rec.topN, 1);
  assert.deepEqual(rec.picks.map((p) => p.symbol), ['GME']);
  assert.deepEqual(rec.settled.results, [{ symbol: 'GME', rank: 1, result: { net: 0.004, how: 'time' }, realisticNet: 0.003 }]);
  assert.equal(po.summarise({ sessions: { d: rec } }).trades, 1);
});

test('the live server upgrades today\'s record on restart and carries on', async () => {
  const r = rig();
  // Write the old single-pick shape, as the previous deploy did.
  const old = {
    version: 1,
    sessions: {
      [iso(THU)]: {
        date: iso(THU), anchor: ANCHOR, selectedAt: OR_END + 60 * 1000, lateSelection: false,
        candidates: [
          { symbol: 'GME/USDT:USDT', hi: 101, lo: 99, vol: 2500, relVol: 5 },
          { symbol: 'NVDA/USDT:USDT', hi: 101, lo: 99, vol: 8000, relVol: 2 },
          { symbol: 'HOOD/USDT:USDT', hi: 101, lo: 99, vol: 1000, relVol: 1 },
        ],
        rangeVolumes: {},
        pick: { symbol: 'GME/USDT:USDT', hi: 101, lo: 99, relVol: 5 },
        skipReason: null, break: null, settled: null,
      },
    },
  };
  fs.writeFileSync(path.join(r.dir, po.STATE_FILE), JSON.stringify(old));
  const tracker = r.make();
  r.at(ANCHOR + 61 * MIN);
  assert.equal(await tracker.tick(), 'watch', 'no re-selection');
  const rec = tracker._state().sessions[iso(THU)];
  assert.equal(rec.picks.length, 3);
  assert.equal(pickOf(rec, 'GME').break.dir, 1);
  assert.equal(pickOf(rec, 'NVDA').break.dir, -1);
});

/* ------------------------------------------------------------------ *
 * Restarts, gaps and failures
 * ------------------------------------------------------------------ */

test('a restart resumes the session rather than starting it again', async () => {
  const r = rig();
  r.at(OR_END + 60 * 1000); await r.tracker.tick();
  const first = today(r).selectedAt;
  r.tracker.stop();
  const again = r.make();                                  // a redeploy
  r.at(ANCHOR + 26 * MIN);
  assert.equal(await again.tick(), 'watch', 'it carries on watching');
  const rec = again._state().sessions[iso(THU)];
  assert.equal(rec.selectedAt, first, 'the picks were not remade');
  assert.equal(pickOf(rec, 'GME').break.dir, 1);
});

test('a session missed at the close is settled the next day', async () => {
  const r = rig();
  r.at(OR_END + 60 * 1000); await r.tracker.tick();
  // The server is down from here until Friday morning.
  r.at(THU + DAY + 12 * 3600000);
  await r.tracker.tick();
  const rec = today(r);
  assert.ok(rec.settled, 'Thursday was settled on Friday');
  assert.ok(Number.isFinite(rec.settled.results.find((x) => x.rank === 1).result.net));
});

test('a session missed by days is marked, not guessed at', async () => {
  const r = rig();
  r.at(OR_END + 60 * 1000); await r.tracker.tick();
  r.at(THU + 5 * DAY + 12 * 3600000);                      // the following Tuesday
  await r.tracker.tick();
  const rec = today(r);
  assert.match(rec.settled.unsettleable, /no longer available/);
  assert.ok(rec.settled.results.every((x) => /no longer available/.test(x.result.skipped)));
  assert.equal(po.summarise(r.tracker._state()).trades, 0);
});

test('a venue failure is recorded, not thrown', async () => {
  const r = rig({ venue: { failOhlcv: true } });
  r.at(OR_END + 60 * 1000);
  assert.equal(await r.tracker.tick(), 'select');
  const rec = today(r);
  assert.deepEqual(rec.picks, [], 'no data, no picks');
  assert.match(rec.skipReason, /enough history/);
});

test('an unconfigured venue is an error on the record, not a crash', async () => {
  const t = OR_END + 60 * 1000;
  const tracker = po.createPaperOrb({ getExchange: () => null, stateDir: null, logger: quiet, now: () => t });
  assert.equal(await tracker.tick(), 'select');
  assert.match(tracker.snapshot().lastError.message, /no weex exchange/);
});

test('it never places, edits or cancels anything', async () => {
  // Run a whole session, a restart and a backlog, then look at every call.
  const r = rig();
  for (const t of [ANCHOR - 3600000, OR_END + 60 * 1000, ANCHOR + 20 * MIN, ANCHOR + 26 * MIN,
    ANCHOR + 61 * MIN, ANCHOR + 3 * 3600000, ANCHOR + 6.5 * 3600000 + 6 * MIN, ANCHOR + 7 * 3600000,
    THU + DAY + 15 * 3600000]) {
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

test('the snapshot says what today is doing and lists each pick', async () => {
  const r = rig();
  r.at(OR_END + 60 * 1000); await r.tracker.tick();
  r.at(ANCHOR + 26 * MIN); await r.tracker.tick();
  const snap = r.tracker.snapshot();
  assert.equal(snap.today.date, iso(THU));
  assert.equal(snap.today.phase, 'watch');
  assert.equal(snap.today.record.picks.length, 3);
  assert.equal(snap.rule.picks, 3);
  assert.match(snap.rule.pick, /3 stock perps/);
  assert.equal(snap.recent[0].date, iso(THU));
  assert.deepEqual(snap.recent[0].picks.map((p) => p.rank), [1, 2, 3]);
  assert.equal(snap.recent[0].picks[0].break.dir, 1);
  assert.equal(snap.recent[0].settled, false);
});

test('the controls cover every candidate, not just the picks', async () => {
  // With three picks and three candidates the two sets coincide, so this
  // takes two picks: HOOD is a candidate that is not picked, and the
  // random-symbol control has to include it.
  const r = rig({ topN: 2 });
  await fullDay(r);
  const rec = today(r);
  assert.deepEqual(rec.picks.map((p) => p.symbol.split('/')[0]), ['GME', 'NVDA']);
  assert.ok('HOOD/USDT:USDT' in rec.settled.controls, 'the unpicked candidate is settled too');
  assert.equal(Object.keys(rec.settled.controls).length, 3);
  assert.equal(rec.settled.results.length, 2, 'while results cover only the picks');
});

test('a live break that disagrees with the model gets no real-book figure', async () => {
  // Weex's 1-minute and 5-minute feeds can disagree. If the live reading said
  // up and the model traded down, pricing the model's trade at the live
  // book's entry would mix two different trades into one number.
  const r = rig();
  r.at(OR_END + 60 * 1000); await r.tracker.tick();
  r.at(ANCHOR + 26 * MIN); await r.tracker.tick();
  pickOf(today(r), 'GME').break.dir = -1;               // the model will say up
  r.at(ANCHOR + 6.5 * 3600000 + 6 * MIN); await r.tracker.tick();
  const gme = today(r).settled.results.find((x) => x.symbol === 'GME/USDT:USDT');
  assert.equal(gme.result.dir, 1);
  assert.equal(gme.realisticNet, null);
  assert.ok(Number.isFinite(gme.result.net), 'the model result itself still stands');
});

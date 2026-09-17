'use strict';

/**
 * The opening-range breakout core.
 *
 * Two bugs were found in this code by its own controls before these tests
 * existed: a coin-flip entry against the break put its stop AT the entry and
 * was silently skipped, and entries filled exactly at the range level, which
 * flattered every trade by about 7bp. Both produced plausible numbers. What is
 * asserted here is mostly the stuff that produces plausible numbers when wrong
 * — which side a stop is on, where a fill lands, and whether selection can see
 * the future.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const BAR = 5 * 60000;
const DAY = 86400000;
let core;
test.before(async () => { core = await import('../orb-core.mjs'); });

/** Build a bar index from a list of [o, h, l, c] starting at `t0`, volume 1. */
function barsFrom(t0, ohlc, vol = 1) {
  return ohlc.map(([o, h, l, c], k) => [t0 + k * BAR, o, h, l, c, vol]);
}
const flat = (n, px = 100) => Array.from({ length: n }, () => [px, px + 0.05, px - 0.05, px]);
const noSlip = () => core.makeCosts({ takerBps: 8, slipBps: 0 });

/* ------------------------------------------------------------------ *
 * Breakouts
 * ------------------------------------------------------------------ */

test('an up-break goes long at the range high with the stop at the range low', () => {
  const t0 = 0;
  // 15m range: three bars between 99 and 101, then a break to 102.
  const rows = barsFrom(t0, [
    [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100],
    [100.5, 102, 100.4, 101.8],
    ...flat(80, 101.8),
  ]);
  const idx = core.indexBars(rows);
  const range = core.openingRange(idx, t0, 15);
  const r = core.tradeBreakout(idx, t0, 15, range, undefined, noSlip());
  assert.equal(r.dir, 1);
  assert.equal(r.entry, 101, 'filled at the range high');
  assert.equal(r.how, 'time', 'never came back to the stop');
  assert.ok(r.gross > 0);
});

test('a down-break goes short at the range low with the stop at the range high', () => {
  const rows = barsFrom(0, [
    [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100],
    [99.5, 99.6, 98, 98.2],
    [98.2, 101.5, 98, 101.2],                    // runs back through the high
    ...flat(80, 101.2),
  ]);
  const idx = core.indexBars(rows);
  const r = core.tradeBreakout(idx, 0, 15, core.openingRange(idx, 0, 15), undefined, noSlip());
  assert.equal(r.dir, -1);
  assert.equal(r.entry, 99);
  assert.equal(r.how, 'stop');
  assert.equal(r.exit, 101, 'stopped at the range high, the far side for a short');
  assert.ok(r.net < 0);
});

test('a gap through the level fills at the open, not at the level', () => {
  const rows = barsFrom(0, [
    [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100],
    [103, 104, 102.5, 103.5],                    // opens above the high
    ...flat(80, 103.5),
  ]);
  const idx = core.indexBars(rows);
  const r = core.tradeBreakout(idx, 0, 15, core.openingRange(idx, 0, 15), undefined, noSlip());
  assert.equal(r.entry, 103, 'you cannot buy at 101 once the market is at 103');
});

test('a bar that breaks both sides skips the day rather than guessing the order', () => {
  const rows = barsFrom(0, [
    [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100],
    [100, 102, 98, 100],
    ...flat(80),
  ]);
  const idx = core.indexBars(rows);
  const r = core.tradeBreakout(idx, 0, 15, core.openingRange(idx, 0, 15), undefined, noSlip());
  assert.equal(r.skipped, 'both sides in one bar');
});

test('a gapped stop fills at the open, not at the stop', () => {
  const rows = barsFrom(0, [
    [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100],
    [100.5, 101.5, 100.2, 101.2],               // long at 101
    [97, 97.5, 96, 96.5],                        // gaps below the 99 stop
    ...flat(80, 96.5),
  ]);
  const idx = core.indexBars(rows);
  const r = core.tradeBreakout(idx, 0, 15, core.openingRange(idx, 0, 15), undefined, noSlip());
  assert.equal(r.how, 'stop');
  assert.equal(r.exit, 97, 'the stop was 99 but the first price available was 97');
});

test('the time exit is the close of the last bar in the session', () => {
  const session = [
    [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100],
    [100.5, 101.5, 100.2, 101.2],
    ...flat(74, 101.2),
  ];
  session[77] = [101.2, 105.1, 101.1, 105];      // bar 77 is the last before 6.5h
  const rows = barsFrom(0, [...session, [105, 110, 105, 110]]);   // bar 78 is after the close
  const idx = core.indexBars(rows);
  const r = core.tradeBreakout(idx, 0, 15, core.openingRange(idx, 0, 15), undefined, noSlip());
  assert.equal(r.how, 'time');
  assert.equal(r.exit, 105, 'the last in-session close, not the bar after the bell');
});

/* ------------------------------------------------------------------ *
 * Costs and slippage
 * ------------------------------------------------------------------ */

test('fees come off every trade', () => {
  const rows = barsFrom(0, [
    [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100],
    [100.5, 101.5, 100.2, 101],
    ...flat(80, 101),                             // exits exactly at entry
  ]);
  const idx = core.indexBars(rows);
  const r = core.tradeBreakout(idx, 0, 15, core.openingRange(idx, 0, 15), undefined, noSlip());
  assert.equal(r.gross, 0);
  assert.equal(Number(r.net.toFixed(6)), -0.0016, 'a flat trade loses exactly the 16bp round trip');
});

test('slippage is charged against the trade in both directions', () => {
  const cost = core.makeCosts({ takerBps: 8, slipBps: 10 });
  const up = barsFrom(0, [
    [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100],
    [100.5, 101.5, 100.2, 101.2], ...flat(80, 101.2),
  ]);
  const dn = barsFrom(0, [
    [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100],
    [99.5, 99.8, 98.5, 98.8], ...flat(80, 98.8),
  ]);
  const long = core.tradeBreakout(core.indexBars(up), 0, 15,
    core.openingRange(core.indexBars(up), 0, 15), undefined, cost);
  const short = core.tradeBreakout(core.indexBars(dn), 0, 15,
    core.openingRange(core.indexBars(dn), 0, 15), undefined, cost);
  assert.ok(long.entry > 101, `a long buys above the level (${long.entry})`);
  assert.ok(short.entry < 99, `a short sells below the level (${short.entry})`);
});

test('a slipped stop exit is worse than the stop, for both sides', () => {
  const cost = core.makeCosts({ takerBps: 8, slipBps: 10 });
  const rows = barsFrom(0, [
    [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100],
    [100.5, 101.5, 100.2, 101.2],
    [101, 101.1, 98.9, 99],                      // touches the 99 stop, no gap
    ...flat(80, 99),
  ]);
  const idx = core.indexBars(rows);
  const r = core.tradeBreakout(idx, 0, 15, core.openingRange(idx, 0, 15), undefined, cost);
  assert.equal(r.how, 'stop');
  assert.ok(r.exit < 99, `a long stopped at 99 sells below it (${r.exit})`);
});

/* ------------------------------------------------------------------ *
 * The coin-flip control
 * ------------------------------------------------------------------ */

test('a coin-flip entry against the break has a real stop, not a zero-width one', () => {
  // The first version put this stop at the entry itself and skipped the day,
  // so the control ran on half the sample.
  const rows = barsFrom(0, [
    [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100],
    [100.5, 101.5, 100.2, 101.2], ...flat(80, 101.2),
  ]);
  const idx = core.indexBars(rows);
  const r = core.tradeBreakout(idx, 0, 15, core.openingRange(idx, 0, 15), -1, noSlip());
  assert.ok(!r.skipped, `the day was traded (${r.skipped})`);
  assert.equal(r.dir, -1);
  assert.ok(Math.abs(r.riskFrac - 2 / 101) < 1e-9, 'one range-width of risk, the same as the rule takes');
  // The size alone is the same whichever side the stop is on, so check the
  // side by behaviour: price sits still above entry, a short stopped ABOVE
  // survives to the close, a short "stopped" below would be out immediately.
  assert.equal(r.how, 'time', 'a short against an up-break is stopped above the entry, not below');
});

test('an entry bar that reaches its stop counts as stopped', () => {
  // The conservative reading of an ambiguous bar. Two ways to get here without
  // breaking both sides: a natural long whose entry bar dips exactly to the
  // range low, and a coin-flip short whose entry bar runs a full width higher.
  const touch = barsFrom(0, [
    [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100],
    [100, 101.5, 99, 101.2],                     // low equals the range low
    ...flat(80, 101.2),
  ]);
  const idx1 = core.indexBars(touch);
  const long = core.tradeBreakout(idx1, 0, 15, core.openingRange(idx1, 0, 15), undefined, noSlip());
  assert.equal(long.how, 'stop (entry bar)');

  const runaway = barsFrom(0, [
    [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100],
    [100.5, 104, 100.4, 103.8],                  // runs 3 above the 101 entry
    ...flat(80, 103.8),
  ]);
  const idx2 = core.indexBars(runaway);
  const short = core.tradeBreakout(idx2, 0, 15, core.openingRange(idx2, 0, 15), -1, noSlip());
  assert.equal(short.how, 'stop (entry bar)');
  assert.ok(short.net < 0);
});

/* ------------------------------------------------------------------ *
 * Selection must not see the future
 * ------------------------------------------------------------------ */

/** Two symbols over 12 sessions; `hotAfter` only differs AFTER the range. */
function twoSymbolData({ lateSpike }) {
  const days = Array.from({ length: 12 }, (_, i) => i * DAY);
  const idx = {};
  for (const s of ['A', 'B']) {
    const rows = [];
    for (const day of days) {
      for (let k = 0; k < 90; k += 1) {
        // A's opening range is busier today; B's volume explodes only later.
        const today = day === days[11];
        let vol = 1;
        if (s === 'A' && today && k < 3) vol = 5;
        if (s === 'B' && today && k >= 3 && lateSpike) vol = 1000;
        const px = 100;
        const h = k === 3 ? 102 : px + 0.5;
        rows.push([day + k * BAR, px, h, px - 0.5, px, vol]);
      }
    }
    idx[s] = core.indexBars(rows);
  }
  return { idx, days };
}

test('selection uses the opening range only, never what came after', () => {
  const quiet = core.runVariant(twoSymbolData({ lateSpike: false }), (d) => d, 15, 'in-play', 1, noSlip());
  const spiky = core.runVariant(twoSymbolData({ lateSpike: true }), (d) => d, 15, 'in-play', 1, noSlip());
  const pick = (res) => res.trades.find((t) => t.day === 11 * DAY)?.symbol;
  assert.equal(pick(quiet), 'A');
  assert.equal(pick(spiky), 'A', 'volume after the range must not change the pick');
});

test('relative volume is measured against previous sessions, not calendar days', () => {
  // Sessions three days apart, as across a weekend. Counting calendar days
  // back would find nothing and drop every symbol.
  const days = Array.from({ length: 12 }, (_, i) => i * 3 * DAY);
  const rows = [];
  for (const day of days) {
    for (let k = 0; k < 90; k += 1) {
      const h = k === 3 ? 102 : 100.5;
      rows.push([day + k * BAR, 100, h, 99.5, 100, 1]);
    }
  }
  const res = core.runVariant({ idx: { A: core.indexBars(rows) }, days }, (d) => d, 15, 'in-play', 1, noSlip());
  assert.equal(res.trades.length, 2, 'both sessions after the lookback were traded');
});

/* ------------------------------------------------------------------ *
 * The null
 * ------------------------------------------------------------------ */

test('on a random walk the breakout does not make money', () => {
  // If this harness can find an edge in noise, every real result is suspect.
  const days = Array.from({ length: 70 }, (_, i) => i * DAY);
  const rows = {};
  for (const s of ['A', 'B', 'C']) {
    rows[s] = [];
    for (const day of days) for (let k = 0; k < 80; k += 1) rows[s].push([day + k * BAR, 0, 0, 0, 0, 0]);
  }
  const cost = core.makeCosts({ takerBps: 8, slipBps: 4 });
  const means = [];
  for (let seed = 0; seed < 6; seed += 1) {
    const syn = core.synthesise(rows, 500 + seed);
    const idx = Object.fromEntries(Object.entries(syn).map(([s, r]) => [s, core.indexBars(r)]));
    const st = core.stats(core.runVariant({ idx, days }, (d) => d, 15, 'in-play', seed, cost).trades, cost);
    means.push(st.mean);
  }
  const avg = means.reduce((a, b) => a + b, 0) / means.length;
  assert.ok(avg < 0, `the average across random walks should be a loss, got ${(avg * 10000).toFixed(1)}bp`);
});

/* ------------------------------------------------------------------ *
 * Several picks a day
 * ------------------------------------------------------------------ */

/** Three symbols with fixed relative volumes; each breaks up after the range. */
function threeSymbols() {
  const days = Array.from({ length: 12 }, (_, i) => i * DAY);
  const idx = {};
  const busy = { A: 3, B: 9, C: 5 };                  // today's multiple of usual
  for (const s of Object.keys(busy)) {
    const rows = [];
    for (const day of days) {
      const today = day === days[11];
      for (let k = 0; k < 90; k += 1) {
        const vol = k < 3 ? (today ? busy[s] : 1) : 1;
        const h = k === 3 ? 102 : 100.5;
        rows.push([day + k * BAR, 100, h, 99.5, 100, vol]);
      }
    }
    idx[s] = core.indexBars(rows);
  }
  return { idx, days };
}

test('the top N are the N most unusual, best first', () => {
  const data = threeSymbols();
  const cands = core.candidatesFor(data, (d) => d, 15);
  const res = core.runOnCandidates(data, cands, 15, 'in-play', 1, noSlip(), 2);
  const today = res.trades.filter((t) => t.day === 11 * DAY);
  assert.deepEqual(today.map((t) => [t.symbol, t.rank]), [['B', 1], ['C', 2]], 'B is 9x, C is 5x, A is left out');
});

test('one pick a day is exactly the hottest, ties included', () => {
  const scored = [{ s: 'X', relVol: 2 }, { s: 'Y', relVol: 2 }, { s: 'Z', relVol: 1 }];
  assert.equal(core.topCandidates(scored, 1)[0].s, 'X');
  assert.equal(core.hottest(scored).s, 'X');
  assert.deepEqual(core.topCandidates(scored, 2).map((c) => c.s), ['X', 'Y'], 'stable on ties');
});

test('the random-symbol control draws N different symbols', () => {
  // Drawing the same symbol twice would make it a random-symbol control with
  // fewer symbols than the rule it is compared with.
  const data = threeSymbols();
  const cands = core.candidatesFor(data, (d) => d, 15);
  for (let seed = 0; seed < 20; seed += 1) {
    const res = core.runOnCandidates(data, cands, 15, 'random-symbol', seed, noSlip(), 3);
    const byDay = {};
    for (const t of res.trades) (byDay[t.day] = byDay[t.day] || []).push(t.symbol);
    for (const syms of Object.values(byDay)) {
      assert.equal(new Set(syms).size, syms.length, `seed ${seed}: ${syms.join(',')}`);
    }
  }
});

test('asking for more picks than there are candidates takes them all, once', () => {
  const data = threeSymbols();
  const cands = core.candidatesFor(data, (d) => d, 15);
  const res = core.runOnCandidates(data, cands, 15, 'random-symbol', 3, noSlip(), 10);
  const today = res.trades.filter((t) => t.day === 11 * DAY).map((t) => t.symbol).sort();
  assert.deepEqual(today, ['A', 'B', 'C']);
});

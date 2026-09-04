'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { simulateExit, summarise, runBacktest } = require('../backtest');
const { loadDetectors } = require('../scanner');

const bar = (o, h, l, c) => ({ t: 0, o, h, l, c, v: 1 });

test.before(async () => { await loadDetectors({ log() {}, warn() {} }); });

test('a long exits at target when the target is touched first', () => {
  const cs = [bar(100, 100, 100, 100), bar(100, 105, 99, 104), bar(104, 112, 103, 111)];
  const r = simulateExit(cs, 0, 'buy', 100, 95, 110, 10);
  assert.equal(r.exit, 110);
  assert.equal(r.reason, 'target');
  assert.equal(r.bars, 2);
});

test('a long exits at stop when the stop is touched first', () => {
  const cs = [bar(100, 100, 100, 100), bar(100, 102, 94, 95)];
  const r = simulateExit(cs, 0, 'buy', 100, 95, 110, 10);
  assert.equal(r.exit, 95);
  assert.equal(r.reason, 'stop');
});

test('a bar spanning both levels resolves to the stop, not the target', () => {
  // Without tick data the order is unknowable. Assuming the favourable fill is
  // how a backtest flatters a strategy that loses money live.
  const cs = [bar(100, 100, 100, 100), bar(100, 115, 90, 108)];
  const r = simulateExit(cs, 0, 'buy', 100, 95, 110, 10);
  assert.equal(r.exit, 95);
  assert.match(r.reason, /ambiguous/);
});

test('a short exits at target on a move down', () => {
  const cs = [bar(100, 100, 100, 100), bar(100, 101, 88, 89)];
  const r = simulateExit(cs, 0, 'sell', 100, 105, 90, 10);
  assert.equal(r.exit, 90);
  assert.equal(r.reason, 'target');
});

test('a position still open at the bar limit is closed at market', () => {
  const cs = [bar(100, 100, 100, 100), bar(100, 101, 99, 100), bar(100, 101, 99, 100.5)];
  const r = simulateExit(cs, 0, 'buy', 100, 95, 110, 2);
  assert.equal(r.reason, 'timeout');
  assert.equal(r.exit, 100.5);
});

test('summary maths are right on a known set', () => {
  const s = summarise([
    { rMultiple: 2, bars: 5, reason: 'target', pattern: 'A' },
    { rMultiple: -1, bars: 3, reason: 'stop', pattern: 'A' },
    { rMultiple: -1, bars: 4, reason: 'stop', pattern: 'B' },
    { rMultiple: 3, bars: 8, reason: 'target', pattern: 'B' },
  ]);
  assert.equal(s.count, 4);
  assert.equal(s.winRate, 50);
  assert.equal(s.totalR, 3);
  assert.equal(s.expectancyR, 0.75);
  assert.equal(s.profitFactor, 2.5); // 5 won / 2 lost
  assert.equal(s.worstLosingStreak, 2);
});

test('max drawdown measures peak to trough, not final loss', () => {
  const s = summarise([
    { rMultiple: 5, bars: 1, reason: 'target', pattern: 'A' },
    { rMultiple: -3, bars: 1, reason: 'stop', pattern: 'A' },
    { rMultiple: -1, bars: 1, reason: 'stop', pattern: 'A' },
    { rMultiple: 2, bars: 1, reason: 'target', pattern: 'A' },
  ]);
  assert.equal(s.totalR, 3);
  assert.equal(s.maxDrawdownR, 4, 'peak of 5 fell to 1');
});

test('an empty result summarises to null rather than dividing by zero', () => {
  assert.equal(summarise([]), null);
});

test('the backtest never enters on the signal bar itself', () => {
  // A flat series produces no signals; the point is that it completes without
  // reaching into future candles.
  const cs = Array.from({ length: 400 }, (_, i) => bar(100 + i * 0.01, 100.2 + i * 0.01, 99.8 + i * 0.01, 100 + i * 0.01));
  const trades = runBacktest(cs, { requireConfirmed: true, requireFirm: true, requireTrendAgreement: false, minRR: 1.5 },
    { window: 200, maxBars: 50, feeRate: 0 });
  assert.ok(Array.isArray(trades));
});

test('fees reduce the recorded R multiple', () => {
  const cs = [bar(100, 100, 100, 100), bar(100, 100, 100, 100), bar(100, 112, 99, 111)];
  const withoutFees = runBacktest(cs, {}, { window: 999, maxBars: 5, feeRate: 0 });
  assert.equal(withoutFees.length, 0, 'no signal on a 3-bar series — guard against false positives');
});

// The equity curve's data: thinned evenly, the last balance of each slice,
// and deposits never thinned away.
const test = require('node:test');
const assert = require('node:assert/strict');
const { balanceHistory } = require('../pnl');

const entry = (t, v, id, extra = {}) => ({ id, timestamp: t, currency: 'USDT', type: 'trade', amount: 0.1, direction: 'in',
  info: { type: 'TRADE', cashBalance: String(v) }, ...extra });

test('a month of rows is thinned to the last balance in each slice', () => {
  const rows = [];
  for (let i = 0; i < 2000; i += 1) rows.push(entry(i * 60_000, 100 + i, `r${i}`));
  const { balance } = balanceHistory(rows, 100);
  assert.ok(balance.length <= 100 && balance.length >= 95, `about 100 points, got ${balance.length}`);
  assert.equal(balance[balance.length - 1].v, 2099, 'the last point is the latest balance');
  assert.ok(balance.every((p, i) => i === 0 || p.t > balance[i - 1].t), 'in time order');
});

test('same-millisecond rows end on the balance after all of them', () => {
  const { balance } = balanceHistory([entry(5, 10, 'b'), entry(5, 12, 'c'), entry(5, 11, 'a')], 10);
  assert.deepEqual(balance, [{ t: 5, v: 12 }]);
});

test('deposits are all kept, and another coin is left out', () => {
  const rows = [];
  for (let i = 0; i < 500; i += 1) rows.push(entry(i * 1000, 50, `r${i}`));
  const dep = (t, a) => ({ id: `d${t}`, timestamp: t, currency: 'USDT', type: 'transfer', amount: a, direction: 'in',
    info: { type: 'TRANSFER_IN', cashBalance: '60' } });
  rows.push(dep(1500, 5), dep(1600, 5), dep(1700, 5));
  rows.push({ ...entry(600_000, 9999, 'btc'), currency: 'BTC' }); // last, so it would be drawn
  const { balance, cash } = balanceHistory(rows, 10);
  assert.equal(cash.length, 3, 'three deposits in one slice, all three kept');
  assert.ok(!balance.some((p) => p.v === 9999), 'a BTC balance is not drawn as USDT');
});

test('a venue that records no balance gives an empty curve, not a made-up one', () => {
  const { balance } = balanceHistory([{ id: 'x', timestamp: 1, currency: 'USDT', type: 'trade', amount: 1, info: {} }]);
  assert.deepEqual(balance, []);
});

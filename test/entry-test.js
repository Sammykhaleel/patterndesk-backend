'use strict';

/**
 * Planning an entry.
 *
 * Nearly every assertion here is about the two directions DISAGREEING in the
 * right way. A long rests at the bid and stops below; a short rests at the ask
 * and stops above. Both mistakes are invisible in a single-direction test —
 * the numbers all look reasonable — and both cost real money: one turns every
 * entry into a taker fill, the other turns a stop into an instant loss.
 *
 * So the long and short cases are asserted side by side, never one at a time.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { planEntry, sizeForRisk, entryParams, LONG, SHORT } = require('../entry');

/** A venue with sane precision and limits. */
function venue({ minAmount = 0.001, minCost = 0, priceDp = 4, amountDp = 3 } = {}) {
  const market = {
    symbol: 'X/USDT:USDT', swap: true, linear: true,
    limits: { amount: { min: minAmount }, cost: { min: minCost } },
  };
  return {
    markets: { 'X/USDT:USDT': market },
    priceToPrecision: (s, v) => Number(v).toFixed(priceDp),
    amountToPrecision: (s, v) => Number(v).toFixed(amountDp),
  };
}

const book = (bid = 99.99, ask = 100.01) => ({ bids: [[bid, 1000]], asks: [[ask, 1000]] });
const plan = (over = {}) => planEntry({
  exchange: venue(), symbol: 'X/USDT:USDT', notionalUsd: 100, book: book(), ...over,
});

/* ------------------------------------------------------------------ *
 * Resting, not crossing
 * ------------------------------------------------------------------ */

test('a long rests at the bid and a short rests at the ask', () => {
  // The fee difference on this venue is 2bp against 8bp. Backwards, every
  // entry crosses the spread and pays four times as much — and the intraday
  // analysis says that gap is most of the edge.
  const long = plan({ dir: LONG, stopPrice: 98 });
  const short = plan({ dir: SHORT, stopPrice: 102 });

  assert.equal(long.price, 99.99, 'a buy joins the bid queue');
  assert.equal(short.price, 100.01, 'a sell joins the ask queue');
  assert.notEqual(long.price, short.price, 'the two directions do not rest at the same price');
  assert.equal(long.side, 'buy');
  assert.equal(short.side, 'sell');
});

test('neither direction ever prices through the spread', () => {
  const b = book(50, 60);              // a deliberately wide book
  const long = plan({ dir: LONG, stopPrice: 40, book: b });
  const short = plan({ dir: SHORT, stopPrice: 70, book: b });
  assert.ok(long.price <= 50, `a long at ${long.price} must not reach the ask`);
  assert.ok(short.price >= 60, `a short at ${short.price} must not reach the bid`);
});

/* ------------------------------------------------------------------ *
 * Which side the stop belongs on
 * ------------------------------------------------------------------ */

test('a long stops below and a short stops above', () => {
  const long = plan({ dir: LONG, stopPrice: 98 });
  const short = plan({ dir: SHORT, stopPrice: 102 });
  assert.equal(long.ok, true);
  assert.equal(short.ok, true);
  assert.ok(long.stopPrice < long.price, 'a long loses when price falls');
  assert.ok(short.stopPrice > short.price, 'a short loses when price rises');
});

test('an inverted stop is refused, in both directions', () => {
  // The worst bug available here: a "stop" on the wrong side is a target that
  // fires immediately at a loss, on leverage.
  const long = plan({ dir: LONG, stopPrice: 102 });
  const short = plan({ dir: SHORT, stopPrice: 98 });
  assert.equal(long.ok, false);
  assert.match(long.reasons.join(' '), /not below a long entry/);
  assert.equal(short.ok, false);
  assert.match(short.reasons.join(' '), /not above a short entry/);
});

test('a stop that rounds onto the entry is refused', () => {
  // Precision can collapse a stop a hair away into the entry price itself,
  // leaving a position whose stop can never be the right side of it.
  const ex = venue({ priceDp: 0 });
  const long = planEntry({ exchange: ex, symbol: 'X/USDT:USDT', dir: LONG,
    notionalUsd: 100, book: book(99.99, 100.01), stopPrice: 99.996 });
  assert.equal(long.ok, false, 'rounded to the same price, so there is no stop');
  assert.match(long.reasons.join(' '), /not below/);
});

test('risk is measured in the direction the position loses', () => {
  const long = plan({ dir: LONG, stopPrice: 98 });
  const short = plan({ dir: SHORT, stopPrice: 102 });
  assert.ok(long.riskUsd > 0, 'a long risks the fall to its stop');
  assert.ok(short.riskUsd > 0, 'a short risks the rise to its stop');
  assert.equal(Number(long.riskUsd.toFixed(4)), Number((long.amount * (long.price - long.stopPrice)).toFixed(4)));
  assert.equal(Number(short.riskUsd.toFixed(4)), Number((short.amount * (short.stopPrice - short.price)).toFixed(4)));
});

/* ------------------------------------------------------------------ *
 * Refusing rather than guessing
 * ------------------------------------------------------------------ */

test('an entry against the current signal is refused', () => {
  // An approval is for a setup, not a symbol. Four shorts were once approved
  // and every one had flipped long 36 minutes later.
  const stale = plan({ dir: SHORT, stopPrice: 102, signalDir: LONG });
  assert.equal(stale.ok, false);
  assert.match(stale.reasons.join(' '), /setup gone/);

  const fresh = plan({ dir: SHORT, stopPrice: 102, signalDir: SHORT });
  assert.equal(fresh.ok, true, 'and allowed when they agree');
});

test('a missing signal is not treated as agreement', () => {
  // Passing no signal means "not checked", which is a caller's choice to make
  // explicitly; it must not be silently read as confirmation.
  const p = plan({ dir: SHORT, stopPrice: 102 });
  assert.equal(p.ok, true);
  assert.ok(!p.reasons.some((r) => /setup gone/.test(r)));
});

test('a size below the venue minimum is refused, not rounded up', () => {
  const ex = venue({ minAmount: 5 });
  const p = planEntry({ exchange: ex, symbol: 'X/USDT:USDT', dir: LONG,
    notionalUsd: 100, book: book(), stopPrice: 98 });
  assert.equal(p.ok, false);
  assert.match(p.reasons.join(' '), /below the venue minimum/);
});

test('a notional below the venue minimum is refused too', () => {
  const ex = venue({ minCost: 500 });
  const p = planEntry({ exchange: ex, symbol: 'X/USDT:USDT', dir: LONG,
    notionalUsd: 100, book: book(), stopPrice: 98 });
  assert.equal(p.ok, false);
  assert.match(p.reasons.join(' '), /notional .* below/);
});

test('a crossed or missing book is refused in both directions', () => {
  for (const dir of [LONG, SHORT]) {
    assert.equal(plan({ dir, stopPrice: dir === LONG ? 98 : 102, book: null }).ok, false);
    assert.equal(plan({ dir, stopPrice: dir === LONG ? 98 : 102, book: { bids: [], asks: [] } }).ok, false);
    const crossed = plan({ dir, stopPrice: dir === LONG ? 98 : 102, book: book(101, 99) });
    assert.equal(crossed.ok, false, 'an ask below the bid is a bad read');
  }
});

test('a spot market is refused', () => {
  const ex = venue();
  ex.markets['X/USDT:USDT'].swap = false;
  const p = planEntry({ exchange: ex, symbol: 'X/USDT:USDT', dir: LONG,
    notionalUsd: 100, book: book(), stopPrice: 98 });
  assert.equal(p.ok, false);
  assert.match(p.reasons.join(' '), /not a linear perp/);
});

test('every refusal reason is collected, not just the first', () => {
  // A caller placing four symbols wants "skipped, and here is why", not a
  // throw at the first problem.
  const ex = venue({ minAmount: 5 });
  const p = planEntry({ exchange: ex, symbol: 'X/USDT:USDT', dir: LONG,
    notionalUsd: 100, book: book(), stopPrice: 102, signalDir: SHORT });
  assert.ok(p.reasons.length >= 3, `expected several reasons, got ${JSON.stringify(p.reasons)}`);
});

test('a direction that is neither long nor short is refused', () => {
  assert.equal(plan({ dir: 0, stopPrice: 98 }).ok, false);
  assert.equal(plan({ dir: undefined, stopPrice: 98 }).ok, false);
});

/* ------------------------------------------------------------------ *
 * Sizing
 * ------------------------------------------------------------------ */

test('size scales so the stop costs the intended share of equity', () => {
  const size = sizeForRisk({ equityUsd: 100, riskFraction: 0.03, price: 100, stopPrice: 99 });
  assert.equal(size, 300, 'a 1% stop on $3 of risk is $300 of notional');
  const wider = sizeForRisk({ equityUsd: 100, riskFraction: 0.03, price: 100, stopPrice: 98 });
  assert.equal(wider, 150, 'a wider stop takes a smaller position');
});

test('a stop touching the price does not produce an enormous position', () => {
  // The trap seen live: a supertrend band ratcheted to within 0.02% of price
  // sized ETH at $2,165 of notional against $18 of equity. The formula was
  // right and the answer was absurd, because a stop inside the noise is not a
  // stop at all.
  assert.ok(Number.isNaN(sizeForRisk({ equityUsd: 18, riskFraction: 0.03, price: 100, stopPrice: 99.98 })),
    'a 0.02% stop is refused rather than sized');
  assert.ok(Number.isNaN(sizeForRisk({ equityUsd: 18, riskFraction: 0.03, price: 100, stopPrice: 100 })),
    'and a stop exactly at the price is not infinite');
  assert.ok(Number.isFinite(sizeForRisk({ equityUsd: 18, riskFraction: 0.03, price: 100, stopPrice: 99 })),
    'while a real stop still sizes');
});

test('sizing works the same for a short', () => {
  const long = sizeForRisk({ equityUsd: 100, riskFraction: 0.03, price: 100, stopPrice: 99 });
  const short = sizeForRisk({ equityUsd: 100, riskFraction: 0.03, price: 100, stopPrice: 101 });
  assert.equal(long, short, 'distance is what matters, not which side it is on');
});

test('nonsense inputs return nothing rather than a number', () => {
  assert.ok(Number.isNaN(sizeForRisk({ equityUsd: 0, riskFraction: 0.03, price: 100, stopPrice: 99 })));
  assert.ok(Number.isNaN(sizeForRisk({ equityUsd: 100, riskFraction: 0, price: 100, stopPrice: 99 })));
  assert.ok(Number.isNaN(sizeForRisk({ equityUsd: 100, riskFraction: 0.03, price: NaN, stopPrice: 99 })));
});

/* ------------------------------------------------------------------ *
 * Handing it to ccxt
 * ------------------------------------------------------------------ */

test('the stop goes on the order itself, not a follow-up call', () => {
  // A fill that lands while its stop is still being placed is a naked
  // leveraged position for the length of that gap.
  const p = plan({ dir: SHORT, stopPrice: 102 });
  assert.deepEqual(entryParams(p), { stopLoss: { triggerPrice: p.stopPrice } });
});

test('a size that rounds away to nothing is refused, not sent as zero', () => {
  // Coarse amount precision against a small notional: 0.1 of a contract on a
  // whole-number venue rounds to 0. Without this the order goes out asking for
  // nothing, and on a venue that tolerates it you get a position of zero with
  // a stop attached to it.
  const ex = {
    markets: { 'X/USDT:USDT': { symbol: 'X/USDT:USDT', swap: true, linear: true, limits: {} } },
    priceToPrecision: (s, v) => Number(v).toFixed(2),
    amountToPrecision: (s, v) => Number(v).toFixed(0),      // whole contracts only
  };
  const p = planEntry({
    exchange: ex, symbol: 'X/USDT:USDT', dir: LONG, notionalUsd: 10,
    book: { bids: [[100, 10]], asks: [[100.1, 10]] }, stopPrice: 98,
  });
  assert.equal(p.amount, 0, 'the venue precision genuinely rounds it to zero');
  assert.equal(p.ok, false);
  assert.match(p.reasons.join(' '), /rounded away to nothing/);
});

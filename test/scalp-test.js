'use strict';

/**
 * The intraday ranker.
 *
 * What is asserted here is mostly that the panel refuses to recommend a trade
 * that cannot win. The measured facts it is built on — Weex taker 8bp, maker
 * 2bp, typical 1-minute crypto range 4 to 8bp — mean the honest answer to
 * "what should I scalp on one-minute bars" is "nothing", and a ranker that
 * cannot say that is worse than no ranker.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  scoreSymbol, rankScores, medianRangeBps, readBook, isStockPerp, usSessionOpen, median,
  CAPTURE, MIN_RATIO,
} = require('../scalp');

/** Bars whose high-low range is a fixed number of basis points. */
const barsOf = (bps, count = 100, price = 100) =>
  Array.from({ length: count }, (_, i) => {
    const half = (price * bps) / 10000 / 2;
    return { t: i * 60000, o: price, h: price + half, l: price - half, c: price, v: 1 };
  });

const bookOf = (spreadBps, depthUsd = 1e6, mid = 100) => {
  const half = (mid * spreadBps) / 10000 / 2;
  const bid = mid - half, ask = mid + half;
  return { bids: [[bid, depthUsd / bid]], asks: [[ask, depthUsd / ask]] };
};

// Weex, measured live on 2026-09-16.
const WEEX = { takerBps: 8, makerBps: 2 };
const OPEN = Date.UTC(2026, 8, 16, 15, 0);    // Wednesday, 15:00 UTC — NY open
const CLOSED = Date.UTC(2026, 8, 16, 22, 34); // the hour the measurements were taken

/* ------------------------------------------------------------------ *
 * The arithmetic that decides everything
 * ------------------------------------------------------------------ */

test('one-minute taker scalping is refused, on every symbol', () => {
  // The finding this whole design turns on. A typical crypto major moves 4-8bp
  // in a minute and a taker round trip costs 16bp. The best ratio on the board
  // was 0.5 — not a hard edge to find, an impossible one.
  for (const moveBps of [4.3, 6.9, 7.5, 8.1]) {
    const s = scoreSymbol({ symbol: 'SOL/USDT:USDT', candles: barsOf(moveBps), book: bookOf(0.6), ...WEEX });
    assert.ok(s.takerRatio < 1, `${moveBps}bp move gave taker ratio ${s.takerRatio.toFixed(2)}`);
    assert.equal(s.tradeable, false, 'and the row is not offered');
    assert.ok(s.reasons.includes('move does not cover costs'));
  }
});

test('five minutes is still not enough for most crypto', () => {
  // SOL's real 5-minute bar is 25.8bp. Before the capture factor that looked
  // like a maker ratio of 5.6 and an easy yes; after it, 2.58 and a no. The
  // difference between those two numbers is the difference between a panel
  // that works and one that recommends losing trades all day.
  const s = scoreSymbol({ symbol: 'SOL/USDT:USDT', candles: barsOf(25.8), book: bookOf(0.6), ...WEEX });
  assert.ok(s.makerRatio < MIN_RATIO, `maker ratio ${s.makerRatio.toFixed(2)} should not clear ${MIN_RATIO}`);
  assert.equal(s.tradeable, false);
});

test('fifteen minutes is where a typical crypto major clears', () => {
  // SOL's real 15-minute bar: 38.7bp -> 15.5 capturable against a 4bp maker
  // round trip. This is the honest floor of the whole system.
  const s = scoreSymbol({ symbol: 'SOL/USDT:USDT', candles: barsOf(38.7), book: bookOf(0.6), ...WEEX });
  assert.ok(s.makerRatio >= MIN_RATIO, `maker ratio ${s.makerRatio.toFixed(2)}`);
  assert.equal(s.tradeable, true);
});

test('MSTR clears earlier than the rest', () => {
  // 30.7bp at five minutes — it tracks crypto sentiment round the clock and
  // moves more than the crypto majors do.
  const s = scoreSymbol({ symbol: 'MSTR/USDT:USDT', candles: barsOf(30.7), book: bookOf(0.8), now: OPEN, ...WEEX });
  assert.ok(s.makerRatio >= MIN_RATIO, `maker ratio ${s.makerRatio.toFixed(2)}`);
  assert.equal(s.tradeable, true);
});

test('a bar range is not treated as profit', () => {
  // Nobody buys the low and sells the high. Using the full range inflates every
  // ratio two to threefold — the same flattery as quoting P&L before fees.
  const s = scoreSymbol({ symbol: 'BTC/USDT:USDT', candles: barsOf(100), book: bookOf(0.6), ...WEEX });
  assert.equal(s.capturableBps, 100 * CAPTURE);
  assert.ok(s.capturableBps < s.moveBps, 'the assumption bites');
  assert.equal(s.capture, CAPTURE, 'and is reported, not hidden');
});

test('the maker and taker verdicts are both returned', () => {
  // On Weex the gap is fourfold — a bigger lever than which symbol you pick,
  // so it must not sit behind a default the user never sees.
  const s = scoreSymbol({ symbol: 'BTC/USDT:USDT', candles: barsOf(20), book: bookOf(0.6), ...WEEX });
  assert.ok(s.makerRatio > s.takerRatio * 3, 'resting is worth several times crossing');
  assert.ok(Math.abs(s.takerCostBps - 16.6) < 0.01, `a taker pays the spread and both fees (${s.takerCostBps})`);
  assert.equal(s.makerCostBps, 4, 'a resting order does not cross the spread');
});

test('a wide spread is a cost, not a footnote', () => {
  const tight = scoreSymbol({ symbol: 'A/USDT:USDT', candles: barsOf(40), book: bookOf(0.5), ...WEEX });
  const wide = scoreSymbol({ symbol: 'A/USDT:USDT', candles: barsOf(40), book: bookOf(30), ...WEEX });
  assert.ok(wide.takerRatio < tight.takerRatio, 'crossing a wide spread is worse');
  assert.ok(wide.takerCostBps > tight.takerCostBps);
});

/* ------------------------------------------------------------------ *
 * Measuring the move
 * ------------------------------------------------------------------ */

test('the typical bar is the median, not the mean', () => {
  // One spike must not make a flat symbol look tradeable. A mean of these is
  // over 100bp; the symbol is still flat.
  const bars = [...barsOf(2, 99), ...barsOf(10000, 1)];
  const m = medianRangeBps(bars);
  assert.ok(m < 5, `median ${m} should describe the 99 quiet bars, not the one spike`);
});

test('a symbol with no candles is not scored as flat', () => {
  // "It did not move" and "I could not measure it" are different answers.
  const s = scoreSymbol({ symbol: 'A/USDT:USDT', candles: [], book: bookOf(1), ...WEEX });
  assert.ok(Number.isNaN(s.moveBps));
  assert.equal(s.tradeable, false);
  assert.ok(s.reasons.includes('no candles'));
});

test('a missing or crossed book is refused rather than guessed', () => {
  assert.ok(Number.isNaN(readBook(null).spreadBps));
  assert.ok(Number.isNaN(readBook({ bids: [], asks: [] }).spreadBps));
  assert.ok(Number.isNaN(readBook({ bids: [[101, 1]], asks: [[100, 1]] }).spreadBps),
    'an ask below the bid is a bad read, not a negative spread');
});

test('median ignores gaps rather than turning them into zero', () => {
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.ok(Number.isNaN(median([])));
  assert.equal(median([NaN, 5, NaN]), 5, 'a hole is skipped, not counted as nothing');
});

/* ------------------------------------------------------------------ *
 * Depth
 * ------------------------------------------------------------------ */

test('a symbol too thin for the order is refused, in those words', () => {
  // Cheap to cross and unable to absorb the order are different failures and
  // need different words, or you go looking for the wrong fix.
  const s = scoreSymbol({
    symbol: 'THIN/USDT:USDT', candles: barsOf(40), book: bookOf(0.5, 12), orderUsd: 50, ...WEEX,
  });
  assert.equal(s.tradeable, false);
  assert.ok(s.reasons.includes('thin at your size'));
  assert.ok(s.fillableUsd < 50, 'and it reports how much it could actually fill');
  assert.ok(!s.reasons.includes('move does not cover costs'), 'the move was fine; the size was not');
});

test('the same symbol is fine for a smaller order', () => {
  const s = scoreSymbol({
    symbol: 'THIN/USDT:USDT', candles: barsOf(40), book: bookOf(0.5, 12), orderUsd: 10, ...WEEX,
  });
  assert.equal(s.tradeable, true);
});

/* ------------------------------------------------------------------ *
 * Stock perps and the session
 * ------------------------------------------------------------------ */

test('a stock perp outside US hours says so instead of scoring badly', () => {
  // At 22:34 UTC, NVDA showed a 0.8bp typical minute against MSTR's 7.1 — not
  // because it is a worse symbol, but because New York was shut. Without this,
  // every stock sits at the bottom all night and the list reorders at 13:30.
  const s = scoreSymbol({
    symbol: 'NVDA/USDT:USDT', candles: barsOf(0.8), book: bookOf(0.5), now: CLOSED, ...WEEX,
  });
  assert.equal(s.stock, true);
  assert.equal(s.sessionOpen, false);
  assert.ok(s.reasons.includes('US market closed'), 'the reason names the cause');
});

test('the same stock perp in session is judged on its numbers', () => {
  const s = scoreSymbol({
    symbol: 'NVDA/USDT:USDT', candles: barsOf(40), book: bookOf(0.5), now: OPEN, ...WEEX,
  });
  assert.equal(s.sessionOpen, true);
  assert.equal(s.tradeable, true);
  assert.ok(!s.reasons.includes('US market closed'));
});

test('crypto is never closed', () => {
  const s = scoreSymbol({
    symbol: 'DOGE/USDT:USDT', candles: barsOf(40), book: bookOf(0.5), now: CLOSED, ...WEEX,
  });
  assert.equal(s.stock, false);
  assert.equal(s.sessionOpen, true, 'a crypto perp at midnight is simply open');
  assert.equal(s.tradeable, true);
});

test('which symbols are stock trackers', () => {
  assert.equal(isStockPerp('MSTR/USDT:USDT'), true);
  assert.equal(isStockPerp('SPY/USDT:USDT'), true);
  assert.equal(isStockPerp('BTC/USDT:USDT'), false);
  assert.equal(isStockPerp('1000PEPE/USDT:USDT'), false, 'a 1000x wrapper is still the same asset');
});

test('the weekend is closed even at midday', () => {
  assert.equal(usSessionOpen(Date.UTC(2026, 8, 19, 15, 0)), false, 'Saturday');
  assert.equal(usSessionOpen(Date.UTC(2026, 8, 20, 15, 0)), false, 'Sunday');
  assert.equal(usSessionOpen(Date.UTC(2026, 8, 18, 15, 0)), true, 'Friday');
});

test('the session follows New York, not a fixed UTC hour', () => {
  // From November to March New York is UTC-5, so the cash session is
  // 14:30-21:00 UTC. A fixed 13:30-20:00 is right in September and wrong on
  // 4 November in both directions at once.
  const nov4 = (h, m) => Date.UTC(2026, 10, 4, h, m);
  assert.equal(usSessionOpen(nov4(13, 45)), false, '13:45 UTC in winter is still pre-market');
  assert.equal(usSessionOpen(nov4(14, 29)), false, 'a minute before the winter open');
  assert.equal(usSessionOpen(nov4(14, 30)), true, 'the winter open');
  assert.equal(usSessionOpen(nov4(20, 30)), true, 'still trading at 20:30 UTC in winter');
  assert.equal(usSessionOpen(nov4(21, 0)), false, 'the winter close');

  // And the same UTC minutes in summer mean the opposite.
  assert.equal(usSessionOpen(Date.UTC(2026, 8, 16, 13, 45)), true, '13:45 UTC in summer is trading');
  assert.equal(usSessionOpen(Date.UTC(2026, 8, 16, 20, 30)), false, '20:30 UTC in summer is after the close');
});

test('a stock perp is scored as open in the winter session', () => {
  // Through the scorer, not just the clock: the reason on the row is what the
  // user sees, and in winter the old code put "US market closed" on a stock
  // during its first hour of trading.
  const s = scoreSymbol({
    symbol: 'NVDA/USDT:USDT', candles: barsOf(40), book: bookOf(0.5),
    now: Date.UTC(2026, 10, 4, 14, 45), ...WEEX,
  });
  assert.equal(s.sessionOpen, true);
  assert.ok(!s.reasons.includes('US market closed'));
});

test('the session boundaries are the cash session, not the whole day', () => {
  assert.equal(usSessionOpen(Date.UTC(2026, 8, 16, 13, 29)), false, 'a minute before the open');
  assert.equal(usSessionOpen(Date.UTC(2026, 8, 16, 13, 30)), true, 'the open');
  assert.equal(usSessionOpen(Date.UTC(2026, 8, 16, 19, 59)), true, 'a minute before the close');
  assert.equal(usSessionOpen(Date.UTC(2026, 8, 16, 20, 0)), false, 'the close');
});

/* ------------------------------------------------------------------ *
 * The ranking
 * ------------------------------------------------------------------ */

test('the list is ranked the way the button trades', () => {
  // The send button posts a limit order, so the list ranks on the maker ratio.
  // Ranking on taker would put the order of the rows at odds with the order
  // underneath them.
  const mk = (symbol, moveBps, spread) =>
    scoreSymbol({ symbol, candles: barsOf(moveBps), book: bookOf(spread), ...WEEX });

  // Deliberately fed worst-first, and the wide-spread symbol moves most: a
  // ranking that merely preserved input order, or ranked on taker, would rank these wrongly.
  const ranked = rankScores([mk('SLOW/USDT:USDT', 20, 0.5), mk('WIDE/USDT:USDT', 60, 40), mk('BEST/USDT:USDT', 50, 0.5)]);
  assert.equal(ranked[0].symbol, 'WIDE/USDT:USDT',
    'a resting order does not pay the spread, so the widest symbol can still lead');
  assert.equal(ranked[1].symbol, 'BEST/USDT:USDT');
  assert.equal(ranked[2].symbol, 'SLOW/USDT:USDT');
});

test('untradeable symbols come last but are not hidden', () => {
  // A dimmed row saying "US market closed" is information. A symbol missing
  // from the list looks like it was never considered.
  const good = scoreSymbol({ symbol: 'GOOD/USDT:USDT', candles: barsOf(40), book: bookOf(0.5), ...WEEX });
  const shut = scoreSymbol({
    symbol: 'NVDA/USDT:USDT', candles: barsOf(200), book: bookOf(0.5), now: CLOSED, ...WEEX,
  });
  const ranked = rankScores([shut, good]);
  assert.equal(ranked[0].symbol, 'GOOD/USDT:USDT', 'the tradeable one leads');
  assert.equal(ranked[1].symbol, 'NVDA/USDT:USDT', 'despite moving five times as much');
  assert.equal(ranked.length, 2, 'and nothing was dropped');
});

test('a symbol that could not be measured ranks last, not first', () => {
  // NaN sorts unpredictably. An unmeasured symbol at the top of the list would
  // be the single most misleading thing this panel could do.
  const good = scoreSymbol({ symbol: 'GOOD/USDT:USDT', candles: barsOf(40), book: bookOf(0.5), ...WEEX });
  const broken = scoreSymbol({ symbol: 'BROKEN/USDT:USDT', candles: [], book: null, ...WEEX });
  const ranked = rankScores([broken, good]);
  assert.equal(ranked[0].symbol, 'GOOD/USDT:USDT');
  assert.equal(ranked[1].symbol, 'BROKEN/USDT:USDT');
});

test('ranking an empty list is not an error', () => {
  assert.deepEqual(rankScores([]), []);
  assert.deepEqual(rankScores(null), []);
});

/* ------------------------------------------------------------------ *
 * Sweeping a venue
 * ------------------------------------------------------------------ */

const { sweepSymbols } = require('../scalp');
const quiet = { log() {}, warn() {}, error() {} };

/** A venue that records how hard it was hit, and how hard at once. */
function sweepVenue(perSymbol, { markets = {}, fail = new Set() } = {}) {
  const venue = {
    markets,
    calls: 0,
    inFlight: 0,
    peak: 0,
    parseTimeframe: (tf) => ({ '1m': 60, '5m': 300, '15m': 900, '1h': 3600 }[tf]),
    async fetchOHLCV(symbol, tf, since, limit) {
      return venue.track(symbol, () => {
        const bps = perSymbol[symbol];
        if (bps === undefined) throw new Error('no such market');
        return Array.from({ length: limit }, (_, i) => {
          const half = (100 * bps) / 10000 / 2;
          return [i * 900000, 100, 100 + half, 100 - half, 100, 1];
        });
      });
    },
    async fetchOrderBook(symbol) {
      return venue.track(symbol, () => ({ bids: [[99.997, 1000]], asks: [[100.003, 1000]] }));
    },
    async track(symbol, fn) {
      venue.calls += 1;
      venue.inFlight += 1;
      venue.peak = Math.max(venue.peak, venue.inFlight);
      await new Promise((r) => setTimeout(r, 1));
      venue.inFlight -= 1;
      if (fail.has(symbol)) throw new Error('rate limited');
      return fn();
    },
  };
  return venue;
}

test('the sweep does not hit the venue in one burst', async () => {
  // The supertrend scanner was rate-limited off Bybit doing roughly nineteen
  // fetches a minute. This panel asks for two per symbol, so twenty symbols
  // unthrottled is forty requests at once.
  const symbols = Array.from({ length: 20 }, (_, i) => `S${i}/USDT:USDT`);
  const perSymbol = Object.fromEntries(symbols.map((s) => [s, 40]));
  const venue = sweepVenue(perSymbol);

  await sweepSymbols({ exchange: venue, symbols, timeframe: '15m', concurrency: 3, logger: quiet });
  assert.ok(venue.peak <= 3, `at most three requests in flight, saw ${venue.peak}`);
  assert.equal(venue.calls, 40, 'two per symbol, and every symbol was read');
});

test('a symbol the venue refuses is reported, not dropped', async () => {
  // A venue having a bad minute must not quietly shrink the list and leave the
  // survivors looking like the whole market.
  const symbols = ['GOOD/USDT:USDT', 'BAD/USDT:USDT'];
  const venue = sweepVenue({ 'GOOD/USDT:USDT': 40, 'BAD/USDT:USDT': 40 }, { fail: new Set(['BAD/USDT:USDT']) });

  const rows = await sweepSymbols({ exchange: venue, symbols, timeframe: '15m', logger: quiet });
  assert.equal(rows.length, 2, 'both symbols come back');
  const bad = rows.find((r) => r.symbol === 'BAD/USDT:USDT');
  assert.equal(bad.tradeable, false);
  assert.match(bad.reasons[0], /could not read/, 'and says why, rather than reading as flat');
  assert.equal(rows[0].symbol, 'GOOD/USDT:USDT', 'the readable one ranks first');
});

test('the sweep uses the venue own fees, not an assumption', async () => {
  // Weex is 8/2. Another venue is not, and a ranking built on the wrong fee is
  // a ranking of the wrong thing.
  const symbols = ['A/USDT:USDT'];
  const venue = sweepVenue({ 'A/USDT:USDT': 40 }, {
    markets: { 'A/USDT:USDT': { taker: 0.0002, maker: 0.00005 } },
  });
  const [row] = await sweepSymbols({ exchange: venue, symbols, timeframe: '15m', logger: quiet });
  assert.equal(row.makerCostBps, 1, 'a cheaper venue makes more symbols tradeable');
  assert.ok(Math.abs(row.takerCostBps - 4.6) < 0.01);
});

test('the forming bar is excluded from the measurement', async () => {
  // Same rule as the supertrend scanner: a partial bar has a partial range and
  // would make every symbol look quieter than it is.
  const venue = sweepVenue({ 'A/USDT:USDT': 40 });
  // One minute into the final bar, so it is genuinely still being built. At
  // exactly last.t + tfMs the bar has closed and keeping it is correct.
  const now = 149 * 900000 + 60000;
  const [row] = await sweepSymbols({
    exchange: venue, symbols: ['A/USDT:USDT'], timeframe: '15m', bars: 150, now, logger: quiet,
  });
  assert.equal(row.bars, 149, 'the bar still being built is not measured');
});

test('sweeping nothing is not an error', async () => {
  const venue = sweepVenue({});
  assert.deepEqual(await sweepSymbols({ exchange: venue, symbols: [], logger: quiet }), []);
  assert.equal(venue.calls, 0);
});

/* ------------------------------------------------------------------ *
 * Gaps that mutation testing found — each was hidden because another
 * failure fired first in the fixture that was supposed to cover it.
 * ------------------------------------------------------------------ */

test('a symbol with no order book is refused even though it moves plenty', () => {
  // A maker cost does not depend on the spread, so a big mover with an
  // unreadable book still produced a healthy maker ratio and offered itself.
  // You cannot place a resting order at a price you could not read.
  const s = scoreSymbol({ symbol: 'A/USDT:USDT', candles: barsOf(200), book: null, ...WEEX });
  assert.ok(Number.isFinite(s.makerRatio) && s.makerRatio > MIN_RATIO, 'the move alone looks fine');
  assert.equal(s.tradeable, false, 'and it is still refused');
  assert.ok(s.reasons.includes('no book'));
});

test('depth is judged on the thinner side of the book', () => {
  // You need both sides: one to get in, one to get out. A deep ask and an
  // empty bid is not a symbol you can trade $50 through, and taking the
  // larger of the two would have called it fine.
  const lopsided = { bids: [[99.99, 0.1]], asks: [[100.01, 1000]] };   // ~$10 bid, ~$100k ask
  const s = scoreSymbol({
    symbol: 'LOPSIDED/USDT:USDT', candles: barsOf(40), book: lopsided, orderUsd: 50, ...WEEX,
  });
  assert.equal(s.tradeable, false);
  assert.ok(s.reasons.includes('thin at your size'), 'the thin side decides');
});

test('an unmeasurable symbol ranks below a merely bad one', () => {
  // Both are untradeable, so the tradeable/untradeable split cannot separate
  // them and the raw comparison decides. NaN sorts unpredictably, and an
  // unmeasured symbol sitting above a measured one — even among the rejects —
  // is the panel claiming to know something it does not.
  const bad = scoreSymbol({ symbol: 'BAD/USDT:USDT', candles: barsOf(5), book: bookOf(0.5), ...WEEX });
  const unknown = scoreSymbol({ symbol: 'UNKNOWN/USDT:USDT', candles: [], book: bookOf(0.5), ...WEEX });
  assert.equal(bad.tradeable, false, 'both are rejects');
  assert.equal(unknown.tradeable, false);

  const ranked = rankScores([unknown, bad]);
  assert.equal(ranked[0].symbol, 'BAD/USDT:USDT', 'a measured bad symbol outranks an unmeasured one');
  assert.equal(ranked[1].symbol, 'UNKNOWN/USDT:USDT');
});

/* ------------------------------------------------------------------ *
 * Filling the order, rather than staring at the top of the book
 * ------------------------------------------------------------------ */

const { fillCost } = require('../scalp');

/** A book of `n` levels, each holding `perLevel` dollars, stepping by `stepBps`. */
const deepBook = (perLevel, n = 50, stepBps = 1, mid = 100) =>
  ({
    bids: Array.from({ length: n }, (_, i) => {
      const p = mid * (1 - ((i + 0.5) * stepBps) / 10000);
      return [p, perLevel / p];
    }),
    asks: Array.from({ length: n }, (_, i) => {
      const p = mid * (1 + ((i + 0.5) * stepBps) / 10000);
      return [p, perLevel / p];
    }),
  });

test('a tiny top level over a deep book is not thin', () => {
  // The bug this replaced. XRP's best level read $720 at one moment and $3,645
  // minutes later while its whole bid side held $475 million — and a $50 order
  // was refused on that flicker.
  const book = deepBook(20, 50);            // $20 a level, $1000 behind it
  const s = scoreSymbol({
    symbol: 'XRP/USDT:USDT', candles: barsOf(60), book, orderUsd: 500, ...WEEX,
  });
  assert.ok(!s.reasons.includes('thin at your size'), `refused with: ${s.reasons.join(', ')}`);
  assert.equal(s.tradeable, true);
});

test('a book that genuinely cannot absorb the order still says so', () => {
  const book = deepBook(2, 5);              // $10 in total
  const s = scoreSymbol({
    symbol: 'TINY/USDT:USDT', candles: barsOf(60), book, orderUsd: 500, ...WEEX,
  });
  assert.ok(s.reasons.includes('thin at your size'));
  assert.ok(s.fillableUsd < 500, 'and reports how much it could actually fill');
});

test('a bigger order costs more to cross, and the panel charges it', () => {
  // The cost of size, which a pass/fail depth test could not express at all.
  const book = deepBook(50, 50);
  const small = scoreSymbol({ symbol: 'A/USDT:USDT', candles: barsOf(60), book, orderUsd: 50, ...WEEX });
  const big = scoreSymbol({ symbol: 'A/USDT:USDT', candles: barsOf(60), book, orderUsd: 2000, ...WEEX });

  assert.ok(big.crossBps > small.crossBps, 'walking deeper costs more');
  assert.ok(big.takerCostBps > small.takerCostBps, 'and it lands in the taker cost');
  assert.equal(big.makerCostBps, small.makerCostBps, 'while a resting order is unaffected by size');
});

test('a wide side of the book raises the round-trip cost', () => {
  // A round trip needs one side to get in and the other to get out, and a book
  // can be tight one way and wide the other. BOTH sides must be able to fill
  // the order, or the partial fill decides instead and this asserts nothing.
  const tight = deepBook(1000, 50, 1);       // asks step 1bp
  const wide = deepBook(1000, 50, 20);       // bids step 20bp
  const book = { asks: tight.asks, bids: wide.bids };

  const both = fillCost(book, 5000);
  const tightOnly = fillCost({ asks: tight.asks, bids: tight.bids }, 5000);

  assert.equal(both.fillableUsd, 5000, 'both sides can fill it');
  assert.ok(both.roundTripBps > tightOnly.roundTripBps,
    `the wide side is what it costs you (${both.roundTripBps} vs ${tightOnly.roundTripBps})`);
  // Measuring each side against the mid instead would hide this: a lopsided
  // book drags the mid toward the thicker side and flatters the wide leg.

  // And the same, through the score the panel actually shows.
  const s = scoreSymbol({ symbol: 'A/USDT:USDT', candles: barsOf(200), book, orderUsd: 5000, ...WEEX });
  const sTight = scoreSymbol({
    symbol: 'A/USDT:USDT', candles: barsOf(200), book: { asks: tight.asks, bids: tight.bids },
    orderUsd: 5000, ...WEEX });
  assert.ok(s.takerCostBps > sTight.takerCostBps, 'and it reaches the taker cost');
});

test('with no size given it falls back to the spread', () => {
  // Half the spread each way is the same arithmetic for an order small enough
  // to fill at the touch, so the answer does not change shape.
  const s = scoreSymbol({ symbol: 'A/USDT:USDT', candles: barsOf(60), book: bookOf(4), ...WEEX });
  assert.ok(Math.abs(s.takerCostBps - (4 + 16)) < 0.01, `got ${s.takerCostBps}`);
});

test('fillCost refuses rather than guessing when it cannot read', () => {
  assert.ok(Number.isNaN(fillCost(null, 100).roundTripBps));
  assert.ok(Number.isNaN(fillCost({ bids: [], asks: [] }, 100).roundTripBps));
  assert.ok(Number.isNaN(fillCost(bookOf(1), 0).roundTripBps), 'no size is not a zero-cost fill');
});

test('a round trip on a symmetric book costs exactly the spread', () => {
  // The identity that pins the formula down. Buy at the ask, sell at the bid,
  // no impact: what you lose is the spread — not half of it, and not a
  // one-sided distance from the mid. Both of those look plausible and both
  // halve the cost, which is the direction that flatters every symbol.
  for (const spreadBps of [2, 8, 30]) {
    const mid = 100;
    const half = (mid * spreadBps) / 10000 / 2;
    const book = {
      bids: [[mid - half, 1000]],
      asks: [[mid + half, 1000]],
    };
    const { roundTripBps } = fillCost(book, 100);
    assert.ok(Math.abs(roundTripBps - spreadBps) < 0.001,
      `a ${spreadBps}bp spread should cost ${spreadBps}bp to round trip, got ${roundTripBps}`);
  }
});

test('the round trip does not move when the mid does', () => {
  // A lopsided book drags the mid toward the thicker side. The two prices you
  // actually trade at have not changed, so neither should the cost.
  const book = {
    bids: [[99.9, 1000], [99.8, 1000]],
    asks: [[100.1, 1000], [100.2, 1000]],
  };
  const balanced = fillCost(book, 50).roundTripBps;

  // Same touch prices, far more resting on the bid: the mid shifts down.
  const lopsided = fillCost({ bids: [[99.9, 100000], [99.8, 1000]], asks: book.asks }, 50).roundTripBps;
  assert.ok(Math.abs(balanced - lopsided) < 0.05,
    `the cost followed the mid instead of the fills (${balanced} vs ${lopsided})`);
});

'use strict';

/**
 * Replays the scanner's exact signal rules over historical candles and reports
 * what would have happened.
 *
 *   npm run backtest
 *   npm run backtest -- BTC/USDT:USDT 4h 2000
 *
 * This deliberately reuses deriveSignal() from scanner.js rather than
 * reimplementing it. A backtest that tests different logic to the live bot is
 * worse than no backtest, because it produces confident numbers about
 * something you are not going to run.
 *
 * Honest about its limits — read "Assumptions" in the output before believing
 * any of it.
 */

const path = require('path');
const ccxt = require('ccxt');
const { deriveSignal, loadDetectors, toCandles, dropFormingCandle } = require('./scanner');

require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const quiet = { log() {}, warn() {}, error() {} };

/* ------------------------------------------------------------------ *
 * Data
 * ------------------------------------------------------------------ */

async function fetchHistory(exchange, symbol, timeframe, wanted) {
  const timeframeMs = exchange.parseTimeframe(timeframe) * 1000;
  const perCall = 1000;
  const rows = [];
  let since = Date.now() - wanted * timeframeMs;

  while (rows.length < wanted) {
    const batch = await exchange.fetchOHLCV(symbol, timeframe, since, perCall);
    if (!batch || batch.length === 0) break;
    rows.push(...batch);
    const last = batch[batch.length - 1][0];
    if (last <= since) break; // no forward progress
    since = last + timeframeMs;
    if (batch.length < perCall) break;
    process.stdout.write(`\r  fetched ${rows.length} candles...`);
  }
  process.stdout.write('\r'.padEnd(40) + '\r');

  // Deduplicate by timestamp; some exchanges overlap batches.
  const seen = new Map();
  for (const r of rows) seen.set(r[0], r);
  const sorted = [...seen.values()].sort((a, b) => a[0] - b[0]);
  return dropFormingCandle(toCandles(sorted), timeframeMs);
}

/* ------------------------------------------------------------------ *
 * Simulation
 * ------------------------------------------------------------------ */

/**
 * Walks forward from the bar after entry until stop or target is touched.
 *
 * When a single candle spans both levels we assume the STOP filled first. That
 * is pessimistic and it is the right default: without tick data you cannot know
 * the order, and assuming the favourable one is how backtests come to flatter
 * strategies that lose money live.
 */
function simulateExit(candles, entryIndex, side, entry, stop, target, maxBars) {
  const isBuy = side === 'buy';
  const limit = Math.min(candles.length - 1, entryIndex + maxBars);

  for (let i = entryIndex + 1; i <= limit; i += 1) {
    const bar = candles[i];
    const hitStop = isBuy ? bar.l <= stop : bar.h >= stop;
    const hitTarget = isBuy ? bar.h >= target : bar.l <= target;

    if (hitStop && hitTarget) return { exit: stop, bars: i - entryIndex, reason: 'stop (ambiguous bar)' };
    if (hitStop) return { exit: stop, bars: i - entryIndex, reason: 'stop' };
    if (hitTarget) return { exit: target, bars: i - entryIndex, reason: 'target' };
  }

  if (limit <= entryIndex) return null;
  return { exit: candles[limit].c, bars: limit - entryIndex, reason: 'timeout' };
}

function runBacktest(candles, rules, { window, maxBars, feeRate }) {
  const trades = [];
  let openUntil = -1; // one position at a time, as the live bot enforces

  for (let i = window; i < candles.length - 1; i += 1) {
    if (i < openUntil) continue;

    const signal = deriveSignal(candles.slice(i - window, i + 1), rules, quiet);
    if (!signal) continue;
    if (!Number.isFinite(signal.stop) || !Number.isFinite(signal.target)) continue;

    // Enter at the next bar's open — the earliest price actually obtainable
    // after a bar closes. Entering at the signal bar's close is lookahead.
    const entry = candles[i + 1].o;
    const isBuy = signal.side === 'buy';

    // The pattern's levels are computed from its own geometry, not from the
    // entry price, so they can already be passed by the time we can trade.
    if (isBuy ? signal.stop >= entry || signal.target <= entry : signal.stop <= entry || signal.target >= entry) {
      continue;
    }

    const outcome = simulateExit(candles, i + 1, signal.side, entry, signal.stop, signal.target, maxBars);
    if (!outcome) continue;

    const gross = isBuy ? outcome.exit - entry : entry - outcome.exit;
    const risk = Math.abs(entry - signal.stop);
    const fees = (entry + outcome.exit) * feeRate;
    const net = gross - fees;

    trades.push({
      time: candles[i].t,
      pattern: signal.pattern,
      side: signal.side,
      entry,
      stop: signal.stop,
      target: signal.target,
      exit: outcome.exit,
      reason: outcome.reason,
      bars: outcome.bars,
      rMultiple: risk > 0 ? net / risk : 0,
      returnPct: (net / entry) * 100,
    });

    openUntil = i + 1 + outcome.bars;
  }

  return trades;
}

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

function summarise(trades) {
  if (trades.length === 0) return null;

  const wins = trades.filter((t) => t.rMultiple > 0);
  const losses = trades.filter((t) => t.rMultiple <= 0);
  const rs = trades.map((t) => t.rMultiple);
  const totalR = rs.reduce((a, b) => a + b, 0);

  const grossWin = wins.reduce((a, t) => a + t.rMultiple, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.rMultiple, 0));

  // Peak-to-trough of the cumulative R curve.
  let peak = 0, equity = 0, maxDrawdown = 0;
  for (const r of rs) {
    equity += r;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }

  let streak = 0, worstStreak = 0;
  for (const t of trades) {
    streak = t.rMultiple <= 0 ? streak + 1 : 0;
    worstStreak = Math.max(worstStreak, streak);
  }

  return {
    count: trades.length,
    winRate: (wins.length / trades.length) * 100,
    totalR,
    expectancyR: totalR / trades.length,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : Infinity,
    maxDrawdownR: maxDrawdown,
    worstLosingStreak: worstStreak,
    avgBars: trades.reduce((a, t) => a + t.bars, 0) / trades.length,
    byReason: trades.reduce((acc, t) => {
      const key = t.reason.split(' ')[0];
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
  };
}

function report(symbol, timeframe, candles, trades, summary) {
  const from = new Date(candles[0].t).toISOString().slice(0, 10);
  const to = new Date(candles[candles.length - 1].t).toISOString().slice(0, 10);

  console.log(`\n  ${symbol} ${timeframe} — ${candles.length} candles, ${from} to ${to}\n`);

  if (!summary) {
    console.log('  No trades. The rules never fired over this history.');
    console.log('  Either the filters are too strict, or this pattern set does not');
    console.log('  occur on this symbol and timeframe. Loosen one rule at a time.\n');
    return;
  }

  const pf = summary.profitFactor === Infinity ? 'inf' : summary.profitFactor.toFixed(2);
  console.log(`  trades            ${summary.count}`);
  console.log(`  win rate          ${summary.winRate.toFixed(1)}%`);
  console.log(`  total R           ${summary.totalR >= 0 ? '+' : ''}${summary.totalR.toFixed(2)}`);
  console.log(`  expectancy        ${summary.expectancyR >= 0 ? '+' : ''}${summary.expectancyR.toFixed(3)} R per trade`);
  console.log(`  profit factor     ${pf}`);
  console.log(`  max drawdown      ${summary.maxDrawdownR.toFixed(2)} R`);
  console.log(`  worst losing run  ${summary.worstLosingStreak} trades`);
  console.log(`  avg hold          ${summary.avgBars.toFixed(1)} bars`);
  console.log(`  exits             ${Object.entries(summary.byReason).map(([k, v]) => `${k}:${v}`).join('  ')}`);

  const byPattern = {};
  for (const t of trades) {
    const p = (byPattern[t.pattern] ||= { n: 0, r: 0 });
    p.n += 1;
    p.r += t.rMultiple;
  }
  console.log('\n  by pattern:');
  for (const [name, p] of Object.entries(byPattern).sort((a, b) => b[1].r - a[1].r)) {
    console.log(`    ${name.padEnd(28)} ${String(p.n).padStart(3)} trades   ${p.r >= 0 ? '+' : ''}${p.r.toFixed(2)} R`);
  }

  console.log('\n  last 5 trades:');
  for (const t of trades.slice(-5)) {
    console.log(
      `    ${new Date(t.time).toISOString().slice(0, 16)}  ${t.side.padEnd(4)} ` +
      `${t.pattern.slice(0, 22).padEnd(22)} ${t.reason.padEnd(20)} ` +
      `${t.rMultiple >= 0 ? '+' : ''}${t.rMultiple.toFixed(2)}R`
    );
  }

  console.log('\n  Assumptions — every one of these flatters the result if wrong:');
  console.log('    - entry at the next bar\'s open, no slippage beyond fees');
  console.log('    - when one bar spans both levels, the stop is assumed to fill first');
  console.log('    - stop and target always fill exactly at their price');
  console.log('    - no funding costs on perpetuals held across funding windows');
  console.log('    - one position at a time, no compounding');
  console.log('    - survivorship: this is one symbol over one period, not an edge\n');

  if (summary.count < 30) {
    console.log('  WARNING: fewer than 30 trades. This sample is too small to conclude');
    console.log('  anything. Widen the history or the symbol list before trusting it.\n');
  }
  if (summary.expectancyR <= 0) {
    console.log('  This rule set lost money over this period. Do not arm SCANNER_EXECUTE.\n');
  }
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

async function main() {
  const [symbolArg, timeframeArg, countArg] = process.argv.slice(2);
  const symbol = symbolArg || (process.env.SCANNER_SYMBOLS || 'BTC/USDT:USDT').split(',')[0].trim();
  const timeframe = timeframeArg || process.env.SCANNER_TIMEFRAME || '1h';
  const wanted = Number(countArg) || 3000;

  const rules = {
    requireConfirmed: process.env.SIGNAL_REQUIRE_CONFIRMED !== 'false',
    requireFirm: process.env.SIGNAL_REQUIRE_FIRM !== 'false',
    requireTrendAgreement: process.env.SIGNAL_REQUIRE_TREND !== 'false',
    minRR: process.env.SIGNAL_MIN_RR === undefined ? 1.5 : Number(process.env.SIGNAL_MIN_RR),
  };

  console.log('\nPatternDesk backtest — replays the live signal rules over history.');
  console.log(`  rules: confirmed=${rules.requireConfirmed} firm=${rules.requireFirm} ` +
    `trend=${rules.requireTrendAgreement} minRR=${rules.minRR}`);

  await loadDetectors(quiet);

  // Public market data only — no credentials, no account access.
  const exchange = new ccxt[(process.env.SCANNER_EXCHANGE || 'bybit').toLowerCase()]({
    enableRateLimit: true,
    options: { defaultType: 'swap' },
  });
  await exchange.loadMarkets();

  const candles = await fetchHistory(exchange, symbol, timeframe, wanted);
  if (candles.length < 200) {
    console.error(`\nOnly ${candles.length} candles available — not enough to test.\n`);
    process.exitCode = 1;
    return;
  }

  const trades = runBacktest(candles, rules, {
    window: Number(process.env.SCANNER_CANDLE_LIMIT) || 300,
    maxBars: Number(process.env.BACKTEST_MAX_BARS) || 100,
    feeRate: Number(process.env.BACKTEST_FEE_RATE) || 0.00055, // Bybit taker
  });

  report(symbol, timeframe, candles, trades, summarise(trades));

  if (typeof exchange.close === 'function') await exchange.close().catch(() => {});
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\n${err.stack || err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { runBacktest, simulateExit, summarise };

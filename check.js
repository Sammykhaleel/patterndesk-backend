'use strict';

/**
 * Read-only connectivity and sizing check. Places no orders, ever.
 *
 *   npm run check
 *   npm run check -- bybit BTC/USDT:USDT
 *
 * Verifies, in order: config validity, which endpoint is actually being hit,
 * credential authentication, market metadata, and the exact order size that a
 * real signal would produce against your live balance.
 */

const { computeOrderSize, readFreeBalance, resolvePrice, marginCurrency, notionalOf } = require('./trading');

const PASS = '  ok  ';
const FAIL = ' FAIL ';
const INFO = '      ';

function line(marker, text) {
  console.log(`${marker}${text}`);
}

async function attempt(label, fn) {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (err) {
    line(FAIL, `${label}: ${err.constructor.name} — ${err.message}`);
    return { ok: false, error: err };
  }
}

async function checkExchange(exchange, config, symbol) {
  const id = exchange.id;
  console.log(`\n── ${id} ───────────────────────────────────────────────`);

  // Which host are we actually talking to? This is the ground truth for
  // whether testnet is in effect, rather than trusting the flag.
  // ccxt stores URLs with a {hostname} placeholder; resolve it so this line
  // shows the host actually being contacted.
  const rawUrls = JSON.stringify(exchange.urls.api).replace(/\{hostname\}/g, exchange.hostname || '');
  const endpoint = rawUrls.match(/https?:\/\/[^"',}]+/)?.[0] ?? 'unknown';
  line(INFO, `endpoint       ${endpoint}`);
  const looksTestnet = /test|demo|sandbox/i.test(rawUrls);
  if (config.useTestnet && !looksTestnet) {
    line(FAIL, 'USE_TESTNET is true but the endpoint does not look like a testnet host.');
    return false;
  }
  line(PASS, `network is ${looksTestnet ? 'TESTNET' : 'LIVE'}`);

  const markets = await attempt('loadMarkets', () => exchange.loadMarkets());
  if (!markets.ok) return false;
  line(PASS, `markets loaded (${Object.keys(exchange.markets).length})`);

  let market;
  try {
    market = exchange.market(symbol);
  } catch {
    line(FAIL, `${symbol} is not listed on ${id}.`);
    const sample = Object.keys(exchange.markets).filter((s) => s.includes('BTC')).slice(0, 5);
    line(INFO, `similar symbols: ${sample.join(', ')}`);
    return false;
  }

  const currency = marginCurrency(market);
  line(PASS, `market ${market.symbol}`);
  line(INFO, `  type         ${market.inverse ? 'inverse' : 'linear'} ${market.type}`);
  line(INFO, `  settle       ${currency}`);
  line(INFO, `  contractSize ${market.contractSize ?? 1}`);
  line(INFO, `  min amount   ${market.limits?.amount?.min ?? 'n/a'}`);
  line(INFO, `  min cost     ${market.limits?.cost?.min ?? 'n/a'}`);

  // Authenticated call. This is where a bad key, a wrong permission, or an IP
  // allowlist mismatch will surface.
  const balance = await attempt('fetchBalance (checks credentials)', () => exchange.fetchBalance());
  if (!balance.ok) {
    line(INFO, 'Check: key/secret correct, trade permission enabled, server IP allowlisted,');
    line(INFO, 'and that testnet keys are used when USE_TESTNET=true.');
    return false;
  }
  const free = readFreeBalance(balance.value, currency);
  line(PASS, `authenticated — free ${currency}: ${free}`);
  if (free <= 0) {
    line(INFO, `No free ${currency}. Fund the account before a live test.`);
  }

  const ticker = await attempt('fetchTicker', () => exchange.fetchTicker(symbol));
  if (!ticker.ok) return false;
  const price = resolvePrice(ticker.value);
  line(PASS, `price ${price}`);

  if (exchange.has.fetchPositions) {
    const positions = await attempt('fetchPositions', () => exchange.fetchPositions([symbol]));
    if (!positions.ok) return false;
    const open = (positions.value || []).filter((p) => Math.abs(Number(p.contracts) || 0) > 0);
    line(PASS, open.length ? `open position: ${open[0].side} ${open[0].contracts}` : 'no open position');
  }

  let sizingOk = true;

  if (free > 0 && price) {
    const sized = computeOrderSize({ market, price, freeBalance: free, fraction: config.tradeFraction });
    const amount = Number(exchange.amountToPrecision(symbol, sized.rawAmount));
    const notional = notionalOf({ amount, price, market });
    console.log('');
    line(INFO, `A "buy" signal right now would send:`);
    line(INFO, `  amount       ${amount}`);
    line(INFO, `  notional     ${notional.toFixed(4)} ${market.quote}`);
    if (config.leverage) {
      // Notional is always quote-denominated; on an inverse market the margin
      // is posted in the base coin, so convert before labelling it.
      const marginInSettle = market.inverse
        ? notional / config.leverage / price
        : notional / config.leverage;
      line(INFO, `  margin used  ~${marginInSettle.toFixed(6)} ${currency} at ${config.leverage}x`);
    }
    if (config.stopLossPercent) {
      const stop = Number(exchange.priceToPrecision(symbol, price * (1 - config.stopLossPercent / 100)));
      line(INFO, `  stop         ${stop} (for a buy)`);
    }
    if (config.maxPositionNotional !== null && notional > config.maxPositionNotional) {
      line(FAIL, `  that exceeds MAX_POSITION_NOTIONAL_QUOTE (${config.maxPositionNotional}), so every`);
      line(INFO, `  signal would be refused. Lower TRADE_BALANCE_PERCENTAGE or raise the cap.`);
      sizingOk = false;
    }
    const minAmount = Number(market.limits?.amount?.min);
    if (Number.isFinite(minAmount) && amount < minAmount) {
      line(FAIL, `  that is below the market minimum (${minAmount}), so every signal would be`);
      line(INFO, `  refused. Raise TRADE_BALANCE_PERCENTAGE or fund the account.`);
      sizingOk = false;
    }
    const minCost = Number(market.limits?.cost?.min);
    if (Number.isFinite(minCost) && notional < minCost) {
      line(FAIL, `  that is below the minimum notional (${minCost}), so every signal would be refused.`);
      sizingOk = false;
    }
  }

  return sizingOk;
}

async function main() {
  const { loadConfig } = require('./config');
  const { initExchanges } = require('./exchanges');

  const [onlyExchange, symbolArg] = process.argv.slice(2);
  const symbol = symbolArg || 'BTC/USDT:USDT';

  const config = loadConfig();

  console.log('\nPatternDesk preflight — read-only, no orders will be placed.\n');
  console.log(`  USE_TESTNET    ${config.useTestnet}`);
  console.log(`  DRY_RUN        ${config.dryRun}`);
  console.log(`  size           ${config.tradePercentage}% of free margin`);
  console.log(`  leverage       ${config.leverage ?? 'not enforced'}`);
  console.log(`  position cap   ${config.maxPositionNotional ?? 'none'}`);
  console.log(`  stop loss      ${config.stopLossPercent ? `${config.stopLossPercent}%` : 'none'}`);

  let exchanges;
  try {
    exchanges = await initExchanges(config, { log() {}, warn: console.warn });
  } catch (err) {
    console.error(`\n${FAIL}startup: ${err.message}\n`);
    process.exit(1);
  }

  const targets = onlyExchange
    ? { [onlyExchange]: exchanges[onlyExchange] }
    : exchanges;

  if (onlyExchange && !exchanges[onlyExchange]) {
    console.error(`\n${FAIL}"${onlyExchange}" is not configured. Available: ${Object.keys(exchanges).join(', ')}\n`);
    process.exit(1);
  }

  let allOk = true;
  for (const exchange of Object.values(targets)) {
    const ok = await checkExchange(exchange, config, symbol);
    allOk = allOk && ok;
  }

  console.log('');
  if (allOk) {
    console.log('All checks passed. The server can authenticate, read prices and size orders.');
    console.log(config.dryRun
      ? 'DRY_RUN is on, so npm start will log plans without sending orders.'
      : 'DRY_RUN is OFF — the next signal will place a real order.');
  } else {
    console.log('One or more checks failed. Fix the above before starting the server.');
  }
  console.log('');
  process.exit(allOk ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\n${FAIL}${err.stack || err.message}\n`);
    process.exit(1);
  });
}

module.exports = { checkExchange };

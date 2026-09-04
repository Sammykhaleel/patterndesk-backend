'use strict';

const ccxt = require('ccxt');

/**
 * setSandboxMode() is a no-op on some ccxt exchanges (Weex, as of ccxt 4.5.x,
 * leaves urls.api untouched). Trusting it blindly means believing you are on
 * testnet while sending live orders. We snapshot the API URLs, apply sandbox
 * mode, and confirm something actually changed.
 */
function applySandboxMode(exchange) {
  const before = JSON.stringify(exchange.urls.api);
  try {
    exchange.setSandboxMode(true);
  } catch (err) {
    return { ok: false, reason: `setSandboxMode threw: ${err.message}` };
  }
  const after = JSON.stringify(exchange.urls.api);
  if (before === after) {
    return { ok: false, reason: 'setSandboxMode did not change the API endpoints (no testnet support in this ccxt version)' };
  }
  return { ok: true };
}

function buildExchange(id, credentials, { useTestnet, orderTimeoutMs, recvWindowMs }) {
  if (typeof ccxt[id] !== 'function') {
    throw new Error(`ccxt has no exchange named "${id}".`);
  }

  const exchange = new ccxt[id]({
    apiKey: credentials.apiKey,
    secret: credentials.secret,
    // Only some exchanges sign with a passphrase; passing undefined is a no-op.
    password: credentials.password || undefined,
    enableRateLimit: true,
    timeout: orderTimeoutMs,
    options: {
      defaultType: 'swap',
      // How far outside its own clock the exchange will accept a signed
      // timestamp. The 5000 ms default is tight for a drifting machine.
      recvWindow: recvWindowMs,
      // ccxt's nonce() returns milliseconds() - options.timeDifference, and
      // bybit's signer uses nonce(). Populating timeDifference via
      // loadTimeDifference() is what makes signed requests survive clock drift.
      timeDifference: 0,
      adjustForTimeDifference: true,
    },
  });

  if (useTestnet) {
    const result = applySandboxMode(exchange);
    if (!result.ok) {
      throw new Error(
        `USE_TESTNET is true but ${id} cannot be put into sandbox mode — ${result.reason}. ` +
        `Refusing to start rather than trade live funds under a testnet flag. ` +
        `Remove the ${id.toUpperCase()} credentials or set USE_TESTNET=false deliberately.`
      );
    }
  }

  return exchange;
}

/**
 * Measures this machine's clock offset against the exchange and stores it so
 * every signed request compensates. Positive means the local clock is ahead.
 */
async function syncClock(exchange, logger = console) {
  if (!exchange.has.fetchTime) return null;
  try {
    const offset = await exchange.loadTimeDifference();
    if (Math.abs(offset) > 3000) {
      logger.warn(
        `[warn] ${exchange.id}: this machine's clock is ${Math.abs(offset / 1000).toFixed(1)}s ` +
        `${offset > 0 ? 'ahead of' : 'behind'} the exchange. Compensating for now, but fix the ` +
        `system clock — on Windows: Settings > Time & language > Date & time > "Sync now".`
      );
    }
    return offset;
  } catch (err) {
    logger.warn(`[warn] ${exchange.id}: could not measure clock offset — ${err.message}`);
    return null;
  }
}

/** Re-measures periodically, since clocks drift between NTP syncs. */
function startClockSync(exchanges, intervalMs, logger = console) {
  if (!intervalMs) return null;
  const timer = setInterval(() => {
    for (const exchange of Object.values(exchanges)) {
      syncClock(exchange, logger).catch(() => {});
    }
  }, intervalMs);
  timer.unref(); // must not keep the process alive at shutdown
  return timer;
}

/**
 * Releases ccxt's keep-alive sockets. Calling process.exit() while these are
 * open triggers a libuv assertion on Windows
 * (`!(handle->flags & UV_HANDLE_CLOSING)`) that buries the real error.
 */
async function closeExchanges(exchanges) {
  await Promise.allSettled(
    Object.values(exchanges || {}).map((ex) =>
      typeof ex.close === 'function' ? ex.close() : Promise.resolve()
    )
  );
}

async function initExchanges(config, logger = console) {
  const exchanges = {};

  for (const [id, credentials] of Object.entries(config.credentials)) {
    if (!credentials.apiKey || !credentials.secret) continue;

    const exchange = buildExchange(id, credentials, {
      useTestnet: config.useTestnet,
      orderTimeoutMs: config.orderTimeoutMs,
      recvWindowMs: config.recvWindowMs,
    });

    // Order matters: measure the clock offset before any signed request, or
    // the first authenticated call is rejected on its timestamp.
    const offset = await syncClock(exchange, logger);

    // Load markets once at startup so the first signal is not slowed by it and
    // a bad credential/network setup fails now rather than mid-trade.
    await exchange.loadMarkets();
    exchanges[id] = exchange;
    logger.log(
      `[startup] ${id}: ${Object.keys(exchange.markets).length} markets loaded` +
      `${config.useTestnet ? ', testnet verified' : ''}` +
      `${offset === null ? '' : `, clock offset ${offset}ms`}`
    );
  }

  if (Object.keys(exchanges).length === 0) {
    throw new Error('No exchanges could be initialised.');
  }

  startClockSync(exchanges, config.timeSyncIntervalMs, logger);

  return exchanges;
}

/**
 * Leverage is account state held by the exchange, not something ccxt sends per
 * order. Left alone it is whatever was last clicked in the Bybit UI, which
 * makes the risk of a given order size unknowable.
 *
 * Returns { ok, applied, reason }. The caller decides whether to proceed —
 * silently trading at unknown leverage is the failure this prevents.
 */
async function applyLeverage(exchange, symbol, leverage, logger = console) {
  if (!leverage) return { ok: true, applied: null, reason: 'not configured' };
  if (!exchange.has.setLeverage) {
    return { ok: false, applied: null, reason: `${exchange.id} does not support setLeverage` };
  }

  try {
    await exchange.setLeverage(leverage, symbol);
    return { ok: true, applied: leverage, reason: 'set' };
  } catch (err) {
    const msg = String(err.message || '').toLowerCase();
    // Bybit errors rather than no-ops when the value already matches.
    if (msg.includes('not modified') || msg.includes('same') || msg.includes('no change') || msg.includes('110043')) {
      return { ok: true, applied: leverage, reason: 'already set' };
    }
    logger.warn(`[warn] could not set leverage ${leverage}x on ${exchange.id} ${symbol}: ${err.message}`);
    return { ok: false, applied: null, reason: err.message };
  }
}

/**
 * Cross margin shares the whole balance as collateral, so one bad position can
 * take the account with it. Isolated caps the loss at the margin posted for
 * that position. For an unattended bot, isolated is the safer default.
 */
async function applyMarginMode(exchange, symbol, marginMode, leverage, logger = console) {
  if (!marginMode || !exchange.has.setMarginMode) return { ok: true, reason: 'skipped' };
  try {
    await exchange.setMarginMode(marginMode, symbol, leverage ? { leverage } : {});
    return { ok: true, reason: 'set' };
  } catch (err) {
    const msg = String(err.message || '').toLowerCase();
    if (msg.includes('not modified') || msg.includes('same') || msg.includes('110026')) {
      return { ok: true, reason: 'already set' };
    }
    logger.warn(`[warn] could not set ${marginMode} margin on ${exchange.id} ${symbol}: ${err.message}`);
    return { ok: false, reason: err.message };
  }
}

module.exports = { initExchanges, buildExchange, applyLeverage, applyMarginMode, syncClock, closeExchanges };

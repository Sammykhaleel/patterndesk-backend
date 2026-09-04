'use strict';

const { loadConfig } = require('./config');
const { initExchanges, closeExchanges } = require('./exchanges');
const { createApp } = require('./app');
const { startScanner } = require('./scanner');

const config = loadConfig();

let exchanges = {};
let ready = false;
let scanner = null;

/**
 * Tears down cleanly, then exits. Calling process.exit() directly while ccxt's
 * keep-alive sockets are open aborts the process on Windows with
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`, which replaces the
 * real error message with a libuv crash dump.
 */
let exiting = false;
async function shutdown(code, reason) {
  if (exiting) return;
  exiting = true;
  ready = false;
  if (scanner) scanner.stop();
  if (reason) console.error(reason);

  // Last resort if a socket refuses to close.
  const bail = setTimeout(() => process.exit(code), 5000);
  bail.unref();

  try {
    await closeExchanges(exchanges);
  } catch {
    // nothing useful to do; we are already on the way out
  }
  process.exitCode = code;
  clearTimeout(bail);
}

// A trading process in an unknown state is worse than a dead one. Exit loudly
// and let systemd or pm2 restart it from a clean slate.
process.on('unhandledRejection', (reason) => {
  shutdown(1, `[fatal] unhandled rejection: ${reason instanceof Error ? reason.stack : reason}`);
});
process.on('uncaughtException', (err) => {
  shutdown(1, `[fatal] uncaught exception: ${err.stack || err.message}`);
});

const app = createApp({
  config,
  getExchanges: () => exchanges,
  isReady: () => ready,
});

function banner() {
  console.log('');
  console.log('  PatternDesk trading backend');
  console.log(`  listening      http://${config.bindHost}:${config.port}`);
  console.log(`  exchanges      ${Object.keys(exchanges).join(', ')}`);
  console.log(`  network        ${config.useTestnet ? 'TESTNET (verified)' : 'LIVE'}`);
  console.log(`  mode           ${config.dryRun ? 'DRY RUN — no orders will be sent' : 'ARMED — real orders will be sent'}`);
  console.log(`  size per trade ${config.tradePercentage}% of free margin balance`);
  console.log(`  leverage       ${config.leverage ? `${config.leverage}x (enforced)` : 'exchange default (NOT enforced)'}`);
  console.log(`  position cap   ${config.maxPositionNotional ?? 'none'}`);
  console.log(`  stop loss      ${config.stopLossPercent ? `${config.stopLossPercent}%` : 'none'}`);
  console.log(`  cors origins   ${config.allowedOrigins.join(', ') || 'none (server-to-server only)'}`);
  console.log(`  scanner        ${config.scanner.enabled
    ? `${config.scanner.symbols.join(', ')} @ ${config.scanner.timeframe}, ${config.scanner.execute ? 'EXECUTING' : 'log only'}`
    : 'off'}`);
  console.log('');
}

async function start() {
  console.log('[startup] initialising exchanges...');
  exchanges = await initExchanges(config);
  ready = true;

  const server = app.listen(config.port, config.bindHost, banner);

  // The scanner shares the app's dedupe cache so a manual POST and an
  // automatic signal on the same bar cannot both open a position.
  scanner = startScanner({ exchanges, config, dedupe: app.locals.dedupe, logger: console });
  app.locals.scanner = scanner; // surfaced on /health so you can see it is alive

  const onSignal = (signal) => {
    console.log(`[shutdown] ${signal} received, closing server...`);
    ready = false;
    server.close(() => shutdown(0));
    setTimeout(() => shutdown(0), 10_000).unref();
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));

  return server;
}

function explain(err) {
  const text = String(err && err.message);
  if (/10002|recv_window|server timestamp/i.test(text)) {
    return [
      '',
      'This is a clock problem, not a credentials problem. The exchange rejected the',
      'signed timestamp because this machine\'s clock is too far from theirs.',
      '  1. Windows: Settings > Time & language > Date & time > "Sync now".',
      '  2. If it still fails, raise RECV_WINDOW_MS in .env (try 20000).',
    ].join('\n');
  }
  if (/10003|10004|api_key|apikey|signature|invalid/i.test(text)) {
    return [
      '',
      'The exchange rejected the key or signature. Check that:',
      '  - the key and secret are copied whole, with no trailing spaces',
      '  - testnet keys are used when USE_TESTNET=true (separate registration)',
      '  - this machine\'s IP is on the key\'s allowlist',
    ].join('\n');
  }
  return '';
}

if (require.main === module) {
  start().catch((err) => {
    shutdown(1, `[fatal] startup failed: ${err.message}${explain(err)}\n`);
  });
}

module.exports = { app, start, config };

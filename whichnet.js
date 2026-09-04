'use strict';

/**
 * Answers one question: which Bybit environment does this key belong to?
 *
 *   node whichnet.js
 *
 * Tries the same credentials against mainnet and testnet with a single
 * read-only balance call each, and reports which one accepts them. Places no
 * orders and moves no funds.
 */

const path = require('path');
const ccxt = require('ccxt');

require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const KEY = process.env.BYBIT_API_KEY;
const SECRET = process.env.BYBIT_API_SECRET;

function build(testnet) {
  const ex = new ccxt.bybit({
    apiKey: KEY,
    secret: SECRET,
    enableRateLimit: true,
    timeout: 15_000,
    options: {
      defaultType: 'swap',
      recvWindow: Number(process.env.RECV_WINDOW_MS) || 10_000,
      timeDifference: 0,
      adjustForTimeDifference: true,
    },
  });
  if (testnet) ex.setSandboxMode(true);
  return ex;
}

function interpret(err) {
  const text = String(err && err.message);
  if (/10003/.test(text)) return 'key not recognised here';
  if (/10004/.test(text)) return 'signature invalid — secret does not match the key';
  if (/10002/.test(text)) return 'clock skew (retry after a time sync)';
  if (/10005|permission/i.test(text)) return 'key recognised, but lacks permission for this call';
  if (/unmatched ?ip|ip.*not.*allow|10010/i.test(text)) return 'key recognised, but this IP is not on its allowlist';
  if (/expired/i.test(text)) return 'key recognised, but expired';
  return text.slice(0, 110);
}

async function probe(label, testnet) {
  const ex = build(testnet);
  try {
    await ex.loadTimeDifference();
  } catch {
    // non-fatal; the balance call below is what matters
  }
  try {
    const balance = await ex.fetchBalance();
    const currencies = Object.keys(balance.total || {}).filter((c) => Number(balance.total[c]) > 0);
    console.log(`  ${label.padEnd(9)} ACCEPTED  ${currencies.length ? `funded: ${currencies.join(', ')}` : 'no balance'}`);
    return true;
  } catch (err) {
    console.log(`  ${label.padEnd(9)} rejected  (${interpret(err)})`);
    return false;
  } finally {
    if (typeof ex.close === 'function') await ex.close().catch(() => {});
  }
}

async function main() {
  if (!KEY || !SECRET) {
    console.error('\nBYBIT_API_KEY / BYBIT_API_SECRET are not set in .env\n');
    process.exitCode = 1;
    return;
  }

  console.log('\nTesting your Bybit key against both environments (read-only)...\n');
  const mainnet = await probe('mainnet', false);
  const testnet = await probe('testnet', true);

  console.log('');
  if (mainnet && !testnet) {
    console.log('This is a MAINNET key. Your .env has USE_TESTNET=true, so the server signs');
    console.log('against the testnet endpoint and the key is rejected.');
    console.log('');
    console.log('  To test safely: register at testnet.bybit.com, create a key there,');
    console.log('  and put it in .env. Keep USE_TESTNET=true.');
    console.log('');
    console.log('  To go live now: set USE_TESTNET=false. Keep DRY_RUN=true first,');
    console.log('  and remove the WEEX_ keys (ccxt has no working Weex sandbox).');
  } else if (testnet && !mainnet) {
    console.log('This is a TESTNET key. Keep USE_TESTNET=true and it should start.');
  } else if (mainnet && testnet) {
    console.log('Accepted by both, which is unusual. Either endpoint will work.');
  } else {
    console.log('Rejected by both. The key is wrong, revoked, expired, or IP-restricted.');
    console.log('Check the Bybit dashboard: keys expire after 90 days unless bound to an IP,');
    console.log('and a key copied with a missing character fails exactly like this.');
  }
  console.log('');
}

main().catch((err) => {
  console.error(`\n${err.stack || err.message}\n`);
  process.exitCode = 1;
});

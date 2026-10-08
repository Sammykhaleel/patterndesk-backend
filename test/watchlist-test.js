'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWatchlist, resolveBases, normaliseBase } = require('../watchlist');
const { createApp } = require('../app');
const { createTuningMonitor } = require('../tuning');

const quiet = { log() {}, warn() {}, error() {} };

test('coin names, however written', () => {
  assert.equal(normaliseBase('sui'), 'SUI');
  assert.equal(normaliseBase('SUI-USD'), 'SUI');
  assert.equal(normaliseBase('SOLUSDT'), 'SOL');
  assert.equal(normaliseBase('../x'), null);
  assert.equal(normaliseBase(''), null);
});

test('each coin stored as the perpetual the exchange lists; PEPE as 1000PEPE; the rest said', () => {
  const listed = new Set(['SOL/USDT:USDT', '1000PEPE/USDT:USDT']);
  const out = resolveBases(['SOL', 'pepe', 'FAKE', 'SOL-USD'], (asks) => Object.fromEntries(asks.map((a) => [a, listed.has(a)])));
  assert.deepEqual(out, { symbols: ['SOL/USDT:USDT', '1000PEPE/USDT:USDT'], unlisted: ['FAKE'] });
});

test('kept across a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-'));
  createWatchlist({ stateDir: dir, logger: quiet }).set({ symbols: ['SOL/USDT:USDT'], unlisted: ['FAKE'] });
  assert.deepEqual(createWatchlist({ stateDir: dir, logger: quiet }).get(), ['SOL/USDT:USDT']);
});

test('/api/watchlist: saved as listed perpetuals, behind the token', async (t) => {
  const AUTH = 'a'.repeat(64);
  const listed = new Set(['SOL/USDT:USDT', '1000PEPE/USDT:USDT']);
  const bybit = { id: 'bybit', market: (s) => { if (!listed.has(s)) throw new Error('no market'); return { symbol: s }; } };
  const app = createApp({
    config: { authToken: AUTH, allowedOrigins: [], rateLimitPerMinute: 100, useTestnet: true, dryRun: true,
      tradePercentage: 5, leverage: 3, maxPositionNotional: 1000, stopLossPercent: 2, dedupeTtlMs: 60_000 },
    scannerSettings: { exchange: 'bybit', symbols: [] },
    getExchanges: () => ({ bybit }), isReady: () => true, logger: quiet,
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, auth = AUTH) => fetch(`${base}/api/watchlist`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Auth-Token': auth }, body: JSON.stringify(body) });

  assert.equal((await post({ bases: ['SOL'] }, 'wrong'.repeat(13))).status, 401);
  assert.equal((await post({ bases: 'SOL' })).status, 400, 'not a list: refused');
  const out = await (await post({ bases: ['SOL', 'PEPE', 'FAKE'] })).json();
  assert.deepEqual(out.symbols, ['SOL/USDT:USDT', '1000PEPE/USDT:USDT']);
  assert.deepEqual(out.unlisted, ['FAKE']);
  const got = await (await fetch(`${base}/api/watchlist`, { headers: { 'X-Auth-Token': AUTH } })).json();
  assert.deepEqual(got.symbols, ['SOL/USDT:USDT', '1000PEPE/USDT:USDT'], 'and read back');
  assert.deepEqual(app.locals.watchlist.get(), ['SOL/USDT:USDT', '1000PEPE/USDT:USDT'], 'what the tuning check reads');
});

test('the tuning check measures the watchlist after the scanned symbols, and drops what left it', async () => {
  const H = 3600000, NOW = Date.UTC(2026, 9, 2, 12);
  const series = (n, step) => Array.from({ length: n }, (_, i) => {
    const px = 100 + 10 * Math.sin(i / 9) + i * 0.05;
    return [NOW - (n - i) * step, px, px * 1.01, px * 0.99, px, 1];
  });
  const asked = [];
  const ex = { parseTimeframe: () => 3600, async fetchOHLCV(symbol, tf) { asked.push(symbol); return series(400, H); } };
  let watch = ['SOL/USDT:USDT', 'ZEC/USDT:USDT'];
  const m = createTuningMonitor({
    getExchange: () => ex,
    getSettings: () => ({ symbols: ['ZEC/USDT:USDT'], timeframes: ['1h'], supertrend: { period: 10, multiplier: 3 }, overrides: {} }),
    getWatchlist: () => watch, timeframes: ['1h'], now: () => NOW, sleep: async () => {}, pauseMs: 0, logger: quiet,
  });
  await m.runOnce();
  const snap = m.snapshot();
  assert.ok(snap.symbols['ZEC/USDT:USDT'], 'the scanned symbol, as before');
  assert.ok(snap.watch['SOL/USDT:USDT'] && snap.watch['SOL/USDT:USDT'].rows.length, 'the watchlist coin measured');
  assert.equal(snap.watch['ZEC/USDT:USDT'], undefined, 'a scanned coin is not measured twice');
  assert.equal(asked.filter((s) => s === 'ZEC/USDT:USDT').length, 1);
  watch = [];
  await m.runOnce();
  assert.deepEqual(m.snapshot().watch, {}, 'off the watchlist: dropped');
});

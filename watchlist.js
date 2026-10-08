'use strict';

/**
 * The app's watchlist, as the server measures it.
 *
 * The Lineup's watchlist view used to be swept by the open page, one symbol
 * after another, so it only moved while the phone was awake on it. The app
 * now sends its watchlist here and the tuning check measures those coins in
 * its own two-hourly run (tuning.js), so the results are waiting whenever
 * the Lineup is opened.
 *
 * Stored as the exchange's perpetuals, resolved once when saved: "PEPE" is
 * listed on Bybit as 1000PEPE, so each coin is tried both ways and kept under
 * whichever the exchange lists. Coins it lists under neither are returned as
 * `unlisted` and not kept — they cannot be traded there, so there is nothing
 * to measure.
 */

const fs = require('fs');
const path = require('path');

const FILE = 'watchlist.json';
const MAX_WATCH = 60;
const BASE = /^[A-Z0-9]{1,20}$/;

/** "sui", "SUI-USD", "SUIUSDT" -> "SUI"; null for anything that is not a coin name. */
function normaliseBase(raw) {
  const b = String(raw || '').trim().toUpperCase().replace(/-?(USDT|USDC|USD)$/, '');
  return BASE.test(b) ? b : null;
}

/**
 * Each coin's perpetual on `exchange`, with `listed(symbols) -> {symbol: bool}`
 * (marketdata.listedSymbols) deciding which spelling exists.
 */
function resolveBases(bases, listed) {
  const uniq = [...new Set(bases.map(normaliseBase).filter(Boolean))];
  const asks = uniq.flatMap((b) => [`${b}/USDT:USDT`, `1000${b}/USDT:USDT`]);
  const known = asks.length ? listed(asks) : {};
  const symbols = [], unlisted = [];
  for (const b of uniq) {
    const plain = `${b}/USDT:USDT`, k = `1000${b}/USDT:USDT`;
    if (known[plain]) symbols.push(plain);
    else if (known[k]) symbols.push(k);
    else unlisted.push(b);
  }
  return { symbols, unlisted };
}

function createWatchlist({ stateDir = null, logger = console } = {}) {
  const file = stateDir ? path.join(stateDir, FILE) : null;
  let saved = { symbols: [], unlisted: [], at: null };
  if (file) {
    try {
      const got = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(got.symbols)) saved = { ...saved, ...got };
    } catch { /* none saved yet */ }
  }

  function set({ symbols, unlisted }, at = Date.now()) {
    saved = { symbols: symbols.slice(0, MAX_WATCH), unlisted, at };
    if (!file) return saved;
    try {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(saved));
      fs.renameSync(tmp, file);
    } catch (err) {
      logger.warn(`[watchlist] could not save (${err.message}); kept in memory`);
    }
    return saved;
  }

  return {
    get: () => saved.symbols.slice(),
    snapshot: () => ({ ...saved, symbols: saved.symbols.slice(), unlisted: (saved.unlisted || []).slice() }),
    set,
  };
}

module.exports = { createWatchlist, resolveBases, normaliseBase, MAX_WATCH };

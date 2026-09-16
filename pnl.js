'use strict';

/**
 * Realised profit and loss, per symbol, from the exchange's own ledger.
 *
 * The scanner already reads this to feed the circuit breaker, but it keeps
 * only the timestamp and the amount — enough to count a losing streak, and
 * nothing that answers "which of these symbols is actually making money".
 * That question was only answerable by opinion, and the backtest scores that
 * looked like an answer are measurements of the past, not of this account.
 *
 * Realised only. An open position's unrealised move belongs to a different
 * question and mixing the two produces a figure that is neither: a good week
 * of closed trades can sit alongside a book that is deeply underwater, and
 * averaging them hides both.
 */

const { RequestError } = require('./trading');

/** Ledger rows that represent a closed trade's P&L, not a fee or funding. */
function isRealisedPnl(entry) {
  const type = String(entry?.type || entry?.info?.type || '').toLowerCase();
  if (!type) return false;
  return /realis|realiz|pnl|settle|close/.test(type) && !/funding|fee|commission/.test(type);
}

/**
 * The signed value of a ledger entry.
 *
 * Shared shape with the breaker's copy in scanner.js deliberately — both are
 * reading the same rows, and two readings of "was this a loss" that disagree
 * would be worse than either.
 */
function signedLedgerAmount(entry) {
  const amount = Number(entry.amount);
  if (entry.direction === 'out') return -Math.abs(amount || 0);
  if (entry.direction === 'in') return Math.abs(amount || 0);
  if (Number.isFinite(amount) && amount < 0) return amount;
  const before = Number(entry.before);
  const after = Number(entry.after);
  if (Number.isFinite(before) && Number.isFinite(after)) return after - before;
  return null;
}

/**
 * The market a ledger row belongs to, in the form the rest of the app uses.
 *
 * ccxt does not always set `symbol` on a ledger entry; the venue's own id
 * ("MNTUSDT") is usually in `info`. Translated through the loaded market list
 * when possible so a row can be matched against a scanner symbol, and
 * returned as-is when not — an untranslated id is still a grouping, whereas
 * dropping the row loses the money it represents.
 */
function ledgerSymbol(entry, exchange) {
  const direct = entry && entry.symbol;
  if (direct) return direct;

  const raw = entry && entry.info && (entry.info.symbol || entry.info.instrument || entry.info.instId);
  if (!raw) return null;

  const byId = exchange && exchange.markets_by_id;
  if (byId && byId[raw]) {
    const m = Array.isArray(byId[raw]) ? byId[raw][0] : byId[raw];
    if (m && m.symbol) return m.symbol;
  }
  return String(raw);
}

/** A stable key for de-duplicating rows seen twice across pages. */
function entryKey(entry, symbol, amount) {
  if (entry && entry.id) return `id:${entry.id}`;
  return `${entry && entry.timestamp}|${symbol}|${amount}`;
}

/**
 * Every realised P&L row since `since`, paging until the venue runs out.
 *
 * One page is not enough for a month: exchanges return the most recent fifty
 * or so, and a caller that took the first page would report a month of
 * trading from its last few days — quietly, and most wrongly for the symbols
 * that trade most.
 *
 * Bounded by `maxPages` so a venue that ignores `since` cannot spin forever.
 * When the bound is hit the caller is told, because a partial answer
 * presented as a complete one is the failure this is guarding against.
 */
async function readRealisedPnl({ exchange, since, code = 'USDT', pageSize = 200, maxPages = 25, logger = console }) {
  if (!exchange || !exchange.has || !exchange.has.fetchLedger) {
    throw new RequestError('This venue cannot report a ledger.', 501);
  }

  const seen = new Set();
  const rows = [];
  let cursor = since;
  let truncated = false;

  for (let page = 0; page < maxPages; page += 1) {
    let batch;
    try {
      batch = await exchange.fetchLedger(code, cursor, pageSize);
    } catch (err) {
      // A first page that fails is a real failure; a later one means we have
      // some of the answer, and saying how much beats saying nothing.
      if (page === 0) throw new RequestError(`Could not read the ledger: ${err.message}`, 502);
      logger.warn(`[pnl] ledger page ${page} failed (${err.message}) — reporting what was read`);
      truncated = true;
      break;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;

    let added = 0;
    let newest = cursor;
    for (const entry of batch) {
      const t = Number(entry && entry.timestamp);
      if (Number.isFinite(t) && (!newest || t > newest)) newest = t;
      if (!isRealisedPnl(entry)) continue;
      if (since && Number.isFinite(t) && t < since) continue;

      const amount = signedLedgerAmount(entry);
      if (!Number.isFinite(amount) || amount === 0) continue;
      const symbol = ledgerSymbol(entry, exchange);
      const key = entryKey(entry, symbol, amount);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ timestamp: t, symbol, amount });
      added += 1;
    }

    if (batch.length < pageSize) break;          // the venue had no more
    // A full page and no forward progress means `since` is being ignored:
    // another request returns the same rows for ever, and whatever lies
    // before them is unreachable. Called truncated even though we might have
    // everything — a full page that repeats is indistinguishable from a full
    // page that is the tip of more, and of the two mistakes, claiming a
    // complete report is the one that misleads.
    if (!Number.isFinite(newest) || newest === cursor) { truncated = true; break; }
    cursor = newest + 1;
    if (page === maxPages - 1) truncated = true;
  }

  rows.sort((a, b) => a.timestamp - b.timestamp);
  return { rows, truncated };
}

/**
 * Totals per symbol, plus the combined figure.
 *
 * Wins and losses are kept apart as well as netted: a symbol at +0.02 made of
 * a +4 and a -3.98 is a different animal from one that drifted there, and the
 * net alone cannot tell them apart.
 */
function summarise(rows) {
  const bySymbol = new Map();
  let total = 0;
  let wins = 0;
  let losses = 0;

  for (const r of rows || []) {
    const key = r.symbol || 'unknown';
    const cur = bySymbol.get(key) || { symbol: key, net: 0, wins: 0, losses: 0, trades: 0, won: 0, lost: 0 };
    cur.net += r.amount;
    cur.trades += 1;
    if (r.amount > 0) { cur.wins += r.amount; cur.won += 1; wins += r.amount; }
    else { cur.losses += r.amount; cur.lost += 1; losses += r.amount; }
    bySymbol.set(key, cur);
    total += r.amount;
  }

  return {
    total,
    wins,
    losses,
    trades: (rows || []).length,
    symbols: [...bySymbol.values()].sort((a, b) => b.net - a.net),
  };
}

module.exports = { readRealisedPnl, summarise, isRealisedPnl, signedLedgerAmount, ledgerSymbol };

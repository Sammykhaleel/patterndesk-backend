'use strict';

/**
 * What the account actually made, per symbol, from the exchange's own ledger.
 *
 * The scanner already reads these rows to feed the circuit breaker, but it
 * keeps only the timestamp and the amount — enough to count a losing streak,
 * and nothing that answers "which of these symbols is actually making money".
 * That question was only answerable by opinion, and the backtest scores that
 * looked like an answer are measurements of the past, not of this account.
 *
 * ---------------------------------------------------------------------------
 * Why this file classifies rows itself instead of matching on the type name
 * ---------------------------------------------------------------------------
 *
 * The first version of this asked whether a row's type looked like realised
 * P&L: /realis|realiz|pnl|settle|close/. On Bybit that matches nothing. ccxt
 * normalises every v5 trading row — TRADE, SETTLEMENT, DELIVERY, LIQUIDATION —
 * to the single type `trade`, so every closed trade was silently discarded and
 * the panel reported a confident, honest-looking zero.
 *
 * The same guess is why the consecutive-loss breaker had counted no closed
 * trades at all: it was reading `readClosedTradeOutcomes`, which used that
 * regex, while the daily-loss baseline used a type SET that happened to
 * include `trade` and so worked. Two readings of the same rows that disagreed,
 * which is precisely what this file's earlier comments said must not happen.
 *
 * So there is now one classifier, here, and the breaker uses it too.
 *
 * ---------------------------------------------------------------------------
 * What a row is decomposed into
 * ---------------------------------------------------------------------------
 *
 * Bybit's transaction log gives the pieces directly, and they reconcile:
 *
 *     change = cashFlow - fee + funding
 *
 * `change` is the balance delta and the one figure that is beyond argument, so
 * it is taken as `net`. `gross` and `fee` are read off the row, and `funding`
 * is whatever is left over — derived rather than read, so the decomposition
 * always sums to the money that actually moved, whatever a venue calls things.
 *
 * Fees matter here out of proportion to their size. On a $10 order — the
 * exchange minimum, which is most of this account's orders — a round trip of
 * taker fees is a meaningful share of the move being traded for, so a figure
 * quoted before fees would be flattering in exactly the range this account
 * operates in.
 */

const { RequestError } = require('./trading');

/** Ledger rows that move money without a trade being involved. */
const NON_TRADING_TYPES = new Set(['transaction', 'transfer', 'prize', 'referral']);

/** Ledger rows that are a cost or a rebate rather than a trade result. */
const FEE_TYPES = new Set(['fee', 'commission']);
const REBATE_TYPES = new Set(['rebate', 'cashback', 'refund']);
const FUNDING_TYPES = new Set(['funding', 'interest']);

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function typeOf(entry) {
  return String(entry?.type || entry?.info?.type || '').toLowerCase();
}

/**
 * Whether a row's TYPE says it is a trade result, ignoring how much moved.
 *
 * `trade` is in the list because that is what ccxt calls every Bybit v5
 * trading row — TRADE, SETTLEMENT, DELIVERY and LIQUIDATION all arrive under
 * that one name. Leaving it out is what made this whole area wrong.
 *
 * The funding/fee guard stays ahead of the pattern match: a venue that calls
 * its funding charge "funding_pnl" must not be read as a losing trade, or
 * every eight-hourly charge would count toward a losing streak on a quiet day.
 */
function isTradeResultType(type) {
  if (!type) return false;
  if (NON_TRADING_TYPES.has(type) || /^transfer_(in|out)$/.test(type) || type === 'bonus') return false;
  if (/funding|fee|commission|rebate|cashback|refund|interest/.test(type)) return false;
  return type === 'trade' || /realis|realiz|pnl|settle|close|deliver|liquidat/.test(type);
}

/**
 * The signed value of a ledger entry, or null when it cannot be determined.
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

/**
 * Split one ledger row into trade result, fee, funding and net.
 *
 * Returns null for a row that is not trading activity at all — a deposit, a
 * withdrawal, a transfer between accounts. Those move the balance without the
 * account having done anything, and counting them as profit would turn adding
 * funds into a winning day.
 *
 * `closed` marks a row that finished a trade. An opening order produces a row
 * too, with no trade result and a fee that is nonetheless real money; it is
 * counted as a cost but not as a trade, because "12 trades" ought to mean
 * twelve results and not six results and their six openings.
 */
function classifyLedgerRow(entry, exchange) {
  if (!entry) return null;

  const type = typeOf(entry);
  if (NON_TRADING_TYPES.has(type)) return null;
  // Bybit's own v5 names, in case a venue passes them through untranslated.
  if (/^transfer_(in|out)$/.test(type) || type === 'bonus') return null;

  const net = signedLedgerAmount(entry);
  if (net === null) return null;

  const info = entry.info || {};
  const timestamp = Number(entry.timestamp);
  const symbol = ledgerSymbol(entry, exchange);
  const base = { timestamp, symbol, id: entry.id || null };

  // --- the venue tells us the pieces (Bybit v5 transaction log) ---
  if (info.cashFlow !== undefined && info.cashFlow !== null && info.cashFlow !== '') {
    const gross = num(info.cashFlow);
    const fee = num(info.fee);
    // Derived, not read: this way gross - fee + funding === net by
    // construction, whatever sign convention the venue uses for funding.
    const funding = net - gross + fee;
    return { ...base, gross, fee, funding, net, closed: gross !== 0 };
  }

  // --- otherwise, infer from the normalised type ---
  if (FEE_TYPES.has(type)) return { ...base, gross: 0, fee: -net, funding: 0, net, closed: false };
  if (REBATE_TYPES.has(type)) return { ...base, gross: 0, fee: -net, funding: 0, net, closed: false };
  if (FUNDING_TYPES.has(type)) return { ...base, gross: 0, fee: 0, funding: net, net, closed: false };

  // Everything left is a trade result: ccxt's `trade`, and the various
  // spellings of realised P&L that other venues use.
  if (isTradeResultType(type)) {
    return { ...base, gross: net, fee: 0, funding: 0, net, closed: net !== 0 };
  }

  // An unrecognised type that moved money. Counted toward the net, because the
  // money moved whatever it is called, but not claimed as a trade result.
  return { ...base, gross: 0, fee: 0, funding: 0, net, closed: false };
}

/**
 * Whether a row represents a closed trade.
 *
 * A row that carries a decomposition is judged on it — a Bybit opening order
 * is type `trade` with no trade result and a real fee, and calling that a
 * closed trade would double the trade count. A bare row with no amount to read
 * is judged on its type alone, which is all the caller gave.
 */
function isRealisedPnl(entry, exchange) {
  const row = classifyLedgerRow(entry, exchange);
  if (row) return row.closed;
  return isTradeResultType(typeOf(entry));
}

/** A stable key for de-duplicating rows seen twice across pages. */
function entryKey(entry, symbol, amount) {
  if (entry && entry.id) return `id:${entry.id}`;
  return `${entry && entry.timestamp}|${symbol}|${amount}`;
}

/**
 * Bybit's transaction log answers a WINDOW, not "everything since".
 *
 * ccxt sends `since` as `startTime` and never sends `endTime`, and Bybit's
 * documented rule for that case is to return startTime → startTime + 7 days.
 * So asking for thirty days of history returns the week that ended twenty-three
 * days ago: empty for an account that traded this week, with no error and
 * nothing to suggest the question was not the one that got answered.
 *
 * That is exactly how this shipped. The panel read a month, got an empty first
 * page, stopped — `batch.length === 0` meant "the venue has no more" — and
 * reported zero closed trades on an account that had closed several that day.
 *
 * So the period is walked in windows the venue will actually answer, and an
 * empty window ends that window only, never the walk.
 */
const LEDGER_WINDOW_MS = 7 * 86400000;

/**
 * Every trading ledger row since `since`.
 *
 * One page is not enough for a month either: exchanges return fifty at a time,
 * and a caller that took the first page would report a month of trading from
 * part of it — quietly, and most wrongly for the symbols that trade most. So
 * each window is paged through as well, by advancing the cursor past the
 * newest row seen.
 *
 * Bounded by `maxRequests` so a venue that ignores the time filter cannot spin
 * for ever. When the bound is hit, or a window cannot be read, the caller is
 * told: a partial answer presented as a complete one is the failure this whole
 * file is guarding against.
 *
 * `pageSize` defaults to 50 because that is Bybit's documented maximum. The
 * 200 it used to ask for was over the limit.
 */
async function readRealisedPnl({
  exchange, since, code = 'USDT', pageSize = 50,
  maxRequests = 40, windowMs = LEDGER_WINDOW_MS, now = Date.now(), logger = console,
}) {
  if (!exchange || !exchange.has || !exchange.has.fetchLedger) {
    throw new RequestError('This venue cannot report a ledger.', 501);
  }

  const seen = new Set();
  const rows = [];
  let truncated = false;
  let requests = 0;
  let done = false;
  // One cursor for the whole walk, never moving backwards. A venue that does
  // honour "everything since" runs ahead of the window it was asked for, and
  // restarting each window at its own beginning would re-read what it already
  // returned — and, worse, make a full page of duplicates look like a venue
  // going in circles.
  let cursor = since;

  for (let windowStart = since; windowStart < now && !done; windowStart += windowMs) {
    const windowEnd = Math.min(windowStart + windowMs, now);
    if (cursor < windowStart) cursor = windowStart;

    for (;;) {
      if (requests >= maxRequests) { truncated = true; done = true; break; }

      let batch;
      try {
        batch = await exchange.fetchLedger(code, cursor, pageSize);
        requests += 1;
      } catch (err) {
        // Nothing read yet is a real failure; a later window failing means we
        // have some of the answer, and saying how much beats saying nothing.
        if (requests === 0) throw new RequestError(`Could not read the ledger: ${err.message}`, 502);
        logger.warn(`[pnl] ledger request ${requests} failed (${err.message}) — reporting what was read`);
        truncated = true;
        done = true;
        break;
      }

      // An empty page means this WINDOW is exhausted. It does not mean the
      // account stopped trading — the next window may be full.
      if (!Array.isArray(batch) || batch.length === 0) break;

      let newest = cursor;
      for (const entry of batch) {
        const t = Number(entry && entry.timestamp);
        if (Number.isFinite(t) && t > newest) newest = t;

        const row = classifyLedgerRow(entry, exchange);
        if (!row) continue;
        if (since && Number.isFinite(t) && t < since) continue;
        if (row.net === 0 && row.fee === 0 && row.gross === 0) continue;

        const key = entryKey(entry, row.symbol, row.net);
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          timestamp: t, symbol: row.symbol, gross: row.gross,
          fee: row.fee, funding: row.funding, net: row.net, closed: row.closed,
        });
      }

      if (batch.length < pageSize) break;        // the window had no more
      // A full page and no forward progress means the time filter is being
      // ignored: another request returns the same rows for ever, and whatever
      // lies before them is unreachable. Abandoning the whole walk rather than
      // repeating it once per window, and calling the answer partial — a full
      // page that repeats is indistinguishable from a full page that is the
      // tip of more, and of the two mistakes, claiming a complete report is
      // the one that misleads.
      if (!Number.isFinite(newest) || newest <= cursor) { truncated = true; done = true; break; }

      // No "have we left this window" check here: the cursor is monotonic, so
      // whether the next page is fetched by this loop or by the next window's
      // turn, it is the same request against the same cursor. A check was
      // written here at first and mutation testing found it inert — nothing
      // could be made to fail by deleting it.
      cursor = newest + 1;
    }
  }

  rows.sort((a, b) => a.timestamp - b.timestamp);
  return { rows, truncated };
}

/**
 * Totals per symbol, plus the combined figure.
 *
 * `net` is the headline: what the balance actually did, fees and funding
 * included. `gross` is the trade result before costs, and the two are reported
 * side by side rather than one standing in for the other — on orders at the
 * exchange minimum the gap between them is most of the story.
 *
 * Wins and losses count the trade result, not the net, so the hit rate answers
 * "was the setting right" while the money answers "did it pay". A symbol at
 * +0.02 gross made of a +4 and a -3.98 is a different animal from one that
 * drifted there, and the net alone cannot tell them apart.
 */
function summarise(rows) {
  const bySymbol = new Map();
  const out = { total: 0, gross: 0, fees: 0, funding: 0, wins: 0, losses: 0, trades: 0, symbols: [] };

  for (const r of rows || []) {
    const key = r.symbol || 'unknown';
    const cur = bySymbol.get(key) || {
      symbol: key, net: 0, gross: 0, fees: 0, funding: 0,
      wins: 0, losses: 0, trades: 0, won: 0, lost: 0,
    };

    cur.net += r.net;
    cur.gross += r.gross;
    cur.fees += r.fee;
    cur.funding += r.funding;
    out.total += r.net;
    out.gross += r.gross;
    out.fees += r.fee;
    out.funding += r.funding;

    if (r.closed) {
      cur.trades += 1;
      out.trades += 1;
      if (r.gross > 0) { cur.wins += r.gross; cur.won += 1; out.wins += r.gross; }
      else { cur.losses += r.gross; cur.lost += 1; out.losses += r.gross; }
    }

    bySymbol.set(key, cur);
  }

  out.symbols = [...bySymbol.values()].sort((a, b) => b.net - a.net);
  return out;
}

module.exports = {
  readRealisedPnl, summarise, isRealisedPnl, signedLedgerAmount, ledgerSymbol, classifyLedgerRow,
};

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

/**
 * Money moved in or out of the account, rather than earned or lost in it.
 *
 * The mirror of `classifyLedgerRow`, which drops these rows so a deposit
 * cannot read as profit. The daily loss limit needs the opposite view: it
 * measures equity against the balance at the start of the day, so a deposit
 * raises equity with nothing earned and would quietly enlarge the day's
 * allowance — fund $50 into a $4 account and the limit has to watch the whole
 * $50 disappear before it fires. A withdrawal has the mirror problem: it reads
 * as a loss and could halt trading on a transfer.
 *
 * Positive is money in. Returns null for anything that is a trade result, a
 * fee or funding, so the two views can never both claim the same row.
 */
function cashFlowAmount(entry) {
  const type = typeOf(entry);
  if (!type) return null;
  const moved = NON_TRADING_TYPES.has(type) || /^transfer_(in|out)$/.test(type) || type === 'bonus';
  if (!moved) return null;
  const net = signedLedgerAmount(entry);
  return Number.isFinite(net) ? net : null;
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
 * Every ledger row since `since`, raw and de-duplicated.
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
/**
 * Bybit's transaction log, read by page cursor.
 *
 * No walk by timestamp can read this venue. Bybit answers with the NEWEST
 * rows of the range asked for, 50 at most, and ccxt then re-sorts each page
 * oldest-first before handing it back — so a page looks oldest-first while
 * holding only the newest rows, and the rows older than it are unreachable by
 * time. Two versions of a timestamp walk shipped on that assumption: one read
 * about 50 rows a day (a request with only startTime covers 24 hours), the
 * next about 50 a week. Both reported themselves complete.
 *
 * Bybit's own answer is nextPageCursor, and ccxt follows it when asked with
 * `paginate`. Each request is bounded to a window of under seven days, the
 * most one request may span, and each window is followed to its last page.
 */
const BYBIT_CALLS_PER_WINDOW = 40;          // 2,000 rows a week before it says "partial"

async function walkBybitLedger({ exchange, since, code, pageSize, maxRequests, windowMs, now, logger }) {
  const seen = new Set();
  const entries = [];
  let truncated = false;
  let requests = 0;
  for (let windowStart = since; windowStart < now; windowStart += windowMs) {
    if (requests >= maxRequests) { truncated = true; break; }
    const windowEnd = Math.min(windowStart + windowMs - 1, now);
    let rows;
    try {
      // No limit here. With `paginate`, ccxt asks Bybit for full pages on its
      // own and follows the cursor — then cuts what it gathered to `limit`
      // before returning it. Passing 50 returned the first 50 of however
      // many it had just read.
      rows = await exchange.fetchLedger(code, windowStart, undefined, {
        endTime: windowEnd, paginate: true, paginationCalls: BYBIT_CALLS_PER_WINDOW,
      });
      if (!Array.isArray(rows)) throw new Error('the ledger answered with something that is not a list');
    } catch (err) {
      if (requests === 0) throw new RequestError(`Could not read the ledger: ${err.message}`, 502);
      logger.warn(`[pnl] ledger window from ${new Date(windowStart).toISOString()} failed (${err.message}) — reporting what was read`);
      truncated = true;
      break;
    }
    requests += Math.max(1, Math.ceil(rows.length / pageSize));
    // ccxt stops following the cursor at its call limit without saying so;
    // a window that filled every call may have had more.
    if (rows.length >= BYBIT_CALLS_PER_WINDOW * pageSize) truncated = true;
    for (const entry of rows) {
      if (!entry) continue;
      const t = Number(entry.timestamp);
      if (since && Number.isFinite(t) && t < since) continue;
      const key = entryKey(entry, entry.symbol || '', entry.amount);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }
  }
  return { entries, truncated };
}

async function walkLedger({
  exchange, since, code = 'USDT', pageSize = 50,
  maxRequests = 150, windowMs = LEDGER_WINDOW_MS, now = Date.now(), logger = console,
}) {
  if (!exchange || !exchange.has || !exchange.has.fetchLedger) {
    throw new RequestError('This venue cannot report a ledger.', 501);
  }

  if (exchange.id === 'bybit') {
    return walkBybitLedger({ exchange, since, code, pageSize, maxRequests, windowMs, now, logger });
  }

  const seen = new Set();
  const entries = [];
  // Which way the venue sorts: oldest first until a page shows otherwise.
  // (ccxt re-sorts every ledger page oldest-first, so for ccxt venues this
  // stays as it starts; the newest-first path is for a venue that does not.)
  let order = 'oldest-first';
  let truncated = false;
  let requests = 0;
  let done = false;

  // Reads one page, and reports which of its rows were new. Every path that
  // continues the walk has to have learnt something, or it would spin.
  async function page(start, end) {
    if (requests >= maxRequests) { truncated = true; done = true; return null; }
    let batch;
    try {
      // endTime bounds each request to its window. Bybit answers a request
      // with only startTime as startTime..+7 days anyway; saying so outright
      // is what makes paging BACKWARDS inside a window possible.
      batch = await exchange.fetchLedger(code, start, pageSize, { endTime: end });
      // An error body where a list belongs is a failed read, not an empty
      // page. Read as empty, the first one ended the day as "nothing
      // happened", and a caller that sums what it got would report zero.
      if (!Array.isArray(batch)) throw new Error('the ledger answered with something that is not a list');
      requests += 1;
    } catch (err) {
      // Nothing read yet is a real failure; a later request failing means we
      // have some of the answer, and saying how much beats saying nothing.
      if (requests === 0) throw new RequestError(`Could not read the ledger: ${err.message}`, 502);
      logger.warn(`[pnl] ledger request ${requests} failed (${err.message}) — reporting what was read`);
      truncated = true;
      done = true;
      return null;
    }
    let fresh = 0;
    let newest = -Infinity;
    let oldest = Infinity;
    for (const entry of batch) {
      if (!entry) continue;
      const t = Number(entry.timestamp);
      if (Number.isFinite(t)) { if (t > newest) newest = t; if (t < oldest) oldest = t; }
      if (since && Number.isFinite(t) && t < since) continue;
      const key = entryKey(entry, entry.symbol || '', entry.amount);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
      fresh += 1;
    }
    const first = Number(batch[0] && batch[0].timestamp);
    const last = Number(batch[batch.length - 1] && batch[batch.length - 1].timestamp);
    // Learnt from any page whose rows differ in time, and remembered: a page
    // whose rows all share one millisecond cannot say which way it runs.
    if (first > last) order = 'newest-first';
    else if (first < last) order = 'oldest-first';
    return { size: batch.length, fresh, newest, oldest, newestFirst: order === 'newest-first' };
  }

  // How far forward an oldest-first venue has already been read. Kept across
  // windows: a venue that honours "everything since" runs ahead of the window
  // it was asked for, and restarting each window at its own beginning would
  // re-read those rows — and take a full page of them for a venue going in
  // circles.
  let cursor = since;

  for (let windowStart = since; windowStart < now && !done; windowStart += windowMs) {
    // Inclusive at both ends and never longer than the venue allows: Bybit
    // refuses a range over seven days, so the end stops one ms short.
    const windowEnd = Math.min(windowStart + windowMs - 1, now);
    let start = Math.max(windowStart, cursor);
    let end = windowEnd;
    if (start > end) continue;                     // already read past this window

    for (;;) {
      const got = await page(start, end);
      if (!got || got.size === 0) break;           // this window is exhausted
      if (got.size < pageSize) break;              // a short page is the last one

      // A full page means there is more in this window. Which way it lies
      // depends on the order the venue sends rows in, and Bybit sends them
      // NEWEST FIRST. The walk used to assume the opposite: it jumped its
      // cursor past the newest row seen, which skipped every older row in
      // the window — each read kept about one page a week and reported the
      // result as complete. A 7-day P&L covered four days; the daily stop's
      // deposit check saw only the newest 50 rows of the day.
      // The next request starts (or ends) AT the last timestamp seen, not one
      // past it, so rows sharing that millisecond are not skipped — the
      // overlap is de-duplicated. When a full page brought nothing new, a
      // whole page shares that millisecond: step one past it. When even that
      // brings nothing, the venue is ignoring the filter and would return the
      // same rows for ever — the answer is partial, and says so.
      if (got.newestFirst) {
        // Newest first: the rest of the window is OLDER.
        if (!Number.isFinite(got.oldest)) { truncated = true; done = true; break; }
        if (got.oldest <= start && got.fresh > 0) break;   // reached the start: window read
        if (got.fresh === 0) {
          // A full page of rows already seen: at least a page of them share
          // one millisecond, and any beyond the first page cannot be reached
          // by time. Say so, and step past it to what is older.
          truncated = true;
          if (got.oldest - 1 >= end) { done = true; break; }
        }
        const next = got.fresh > 0 ? got.oldest : got.oldest - 1;
        if (next < start) break;
        end = next;
      } else {
        // Oldest first: the rest is NEWER.
        if (!Number.isFinite(got.newest)) { truncated = true; done = true; break; }
        if (got.fresh === 0) {
          truncated = true;                        // as above, in the other direction
          if (got.newest + 1 <= start) { done = true; break; }
        }
        const next = got.fresh > 0 ? got.newest : got.newest + 1;
        start = next;
        cursor = Math.max(cursor, start);
      }
    }
  }

  return { entries, truncated };
}

/**
 * The trading rows of the ledger since `since`: every row walkLedger found,
 * classified. Deposits and transfers are dropped by the classifier, so they
 * can never read as a trade result.
 */
async function readRealisedPnl(opts) {
  const { exchange } = opts;
  const { entries, truncated } = await walkLedger(opts);
  const rows = [];
  for (const entry of entries) {
    const row = classifyLedgerRow(entry, exchange);
    if (!row) continue;
    if (row.net === 0 && row.fee === 0 && row.gross === 0) continue;
    rows.push({
      timestamp: Number(entry.timestamp), symbol: row.symbol, gross: row.gross,
      fee: row.fee, funding: row.funding, net: row.net, closed: row.closed,
    });
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
  readRealisedPnl, walkLedger, summarise, isRealisedPnl, signedLedgerAmount, ledgerSymbol, classifyLedgerRow, cashFlowAmount,
};

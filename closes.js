'use strict';

/**
 * Why each position closed: the flip, a stop, a take-profit, a liquidation,
 * the app's Close button, or by hand on the exchange.
 *
 * Read from Bybit's order history, not guessed from the ledger. The ledger
 * says a trade closed and what it made; only the order says what closed it.
 * Guessing from timing ("22:44 is not a bar close, so a stop") was right about
 * KAT and could not have told a stop from a hand close or a liquidation —
 * three different problems with three different fixes.
 *
 * The order is identified by what placed it:
 *   - Bybit's own triggers carry createType / stopOrderType: a stop-loss,
 *     trailing stop, take-profit, or the liquidation engine.
 *   - The scanner names its closes `<symbol>-<tf>-<bar>x` (signalId in
 *     scanner.js), and a limit close at a flip appends `-m1`. A partial close
 *     at a profit target ends in `p` (partial.js).
 *   - Everything this server sends without a name gets `pd<hex>`
 *     (buildClientOrderId in trading.js): the Positions panel's Close.
 *   - Anything else was placed on the exchange itself.
 */

const DAY = 86_400_000;
const WINDOW = 7 * DAY;          // Bybit: startTime..endTime at most 7 days
const PAGE = 50;                 // Bybit's maximum page
const MAX_PAGES_PER_WINDOW = 40;

const REASONS = ['flip', 'partial', 'stop', 'target', 'liquidation', 'app', 'hand'];

/** The reason an order closed a position, from Bybit's own fields. */
function closeReason(order) {
  if (!order) return null;
  const create = String(order.createType || '');
  const stop = String(order.stopOrderType || '');
  const link = String(order.orderLinkId || '');
  // The liquidation engine and auto-deleveraging come first: they can carry
  // other fields that look ordinary.
  if (/Liq|Adl|TakeOver/i.test(create)) return 'liquidation';
  if (/StopLoss|TrailingStop/i.test(stop) || /StopLoss|TrailingStop/i.test(create)) return 'stop';
  if (/TakeProfit/i.test(stop) || /TakeProfit/i.test(create)) return 'target';
  if (/^[A-Za-z0-9]+-\w+-\d+x(-m\d+)?$/.test(link)) return 'flip';
  // The optional partial close at a profit target (partial.js).
  if (/^[A-Za-z0-9]+-\w+-\d+p$/.test(link)) return 'partial';
  if (/^pd[0-9a-f]+$/.test(link)) return 'app';
  return 'hand';
}

/**
 * orderId -> reason for every order in [since, now], walking 7-day windows
 * and following Bybit's cursor within each.
 *
 * `truncated` says when a window had more pages than were read; the orders
 * not reached simply have no reason, and the panel shows them as unknown
 * rather than guessing.
 */
async function readCloseReasons({ exchange, since, now = Date.now(), logger = console }) {
  if (!exchange || exchange.id !== 'bybit' || typeof exchange.privateGetV5OrderHistory !== 'function') {
    return { supported: false, reasons: {}, truncated: false };
  }
  const reasons = {};
  let truncated = false;
  for (let start = since; start < now; start += WINDOW) {
    const end = Math.min(start + WINDOW, now);
    let cursor;
    let pages = 0;
    do {
      const res = await exchange.privateGetV5OrderHistory({
        category: 'linear', startTime: start, endTime: end, limit: PAGE,
        ...(cursor ? { cursor } : {}),
      });
      const result = (res && res.result) || {};
      for (const o of result.list || []) {
        if (o && o.orderId) reasons[o.orderId] = closeReason(o);
      }
      cursor = result.nextPageCursor || '';
      pages += 1;
    } while (cursor && pages < MAX_PAGES_PER_WINDOW);
    if (cursor) {
      truncated = true;
      logger.warn(`[closes] ${new Date(start).toISOString()} window has more than ${pages * PAGE} orders; stopped there`);
    }
  }
  return { supported: true, reasons, truncated };
}

module.exports = { readCloseReasons, closeReason, REASONS };

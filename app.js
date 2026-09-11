'use strict';

const crypto = require('crypto');
const fsx = require('fs');
const express = require('express');
const cors = require('cors');

const {
  RequestError,
  DedupeCache,
  validateTradeRequest,
  executeTrade,
} = require('./trading');
const { searchAcrossExchanges, fetchCandles, resolveExchange, listedSymbols } = require('./marketdata');
const { usableStopPercent } = require('./trading');
const { readRisk, applyRisk, saveRisk, riskConfig } = require('./risk');
const { readSettings, applySettings, saveSettings } = require('./scannerapi');
const { stateIsDurable } = require('./statedir');
const { readPositions, readAccounts, findPosition, closingSideFor, clearProtection, cancelOrders } = require('./positions');

/** Constant-time comparison so the token can't be guessed byte by byte. */
function tokenMatches(provided, expected) {
  if (typeof provided !== 'string' || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * @param {object} options
 * @param {object} options.config      validated config object
 * @param {object} options.getExchanges  () => ({ [id]: ccxtExchange })
 * @param {() => boolean} options.isReady
 */
function createApp({ config, getExchanges, isReady, breakers = null, scannerSettings = null, riskSettings = null, logger = console }) {
  // Every order path reads this rather than the frozen boot config, so a size
  // or leverage change takes effect on the next signal instead of the next
  // redeploy. Everything else still comes from config.
  const live = () => riskConfig(config, riskSettings);
  const app = express();
  const dedupe = new DedupeCache(config.dedupeTtlMs);
  app.locals.dedupe = dedupe; // shared with the scanner so both paths dedupe together

  app.disable('x-powered-by');
  // How many proxies to believe in X-Forwarded-For. 0 means req.ip is the
  // socket's own address, which is the only safe reading when this port can
  // be reached without passing through a proxy. See config.js.
  app.set('trust proxy', config.trustProxy ?? 1);

  app.use(
    cors({
      origin(origin, callback) {
        // No Origin header means a server-to-server caller (curl, your scanner),
        // which is authenticated by token rather than by browser origin.
        if (!origin) return callback(null, true);
        return callback(null, config.allowedOrigins.includes(origin));
      },
      methods: ['GET', 'POST'],
      allowedHeaders: ['Content-Type', 'X-Auth-Token', 'Authorization'],
      maxAge: 600,
    })
  );

  app.use(express.json({ limit: '16kb' }));

  app.use((req, res, next) => {
    req.id = crypto.randomBytes(6).toString('hex');
    res.setHeader('X-Request-Id', req.id);
    next();
  });

  function requireAuth(req, res, next) {
    const header = req.get('X-Auth-Token');
    const bearer = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (tokenMatches(header, config.authToken) || tokenMatches(bearer, config.authToken)) {
      return next();
    }
    logger.warn(`[${req.id}] rejected unauthenticated ${req.method} ${req.path} from ${req.ip}`);
    return res.status(401).json({ success: false, error: 'Unauthorized.' });
  }

  /** Fixed-window limiter. No extra dependency; sufficient for a single bot. */
  const buckets = new Map();
  function rateLimit(req, res, next) {
    const now = Date.now();
    const windowStart = now - 60_000;
    const key = req.ip || 'unknown';
    const hits = (buckets.get(key) || []).filter((t) => t > windowStart);
    hits.push(now);
    buckets.set(key, hits);

    if (buckets.size > 1000) {
      for (const [k, v] of buckets) {
        if (v.every((t) => t <= windowStart)) buckets.delete(k);
      }
    }
    if (hits.length > config.rateLimitPerMinute) {
      return res.status(429).json({ success: false, error: 'Too many requests.' });
    }
    return next();
  }

  app.get('/health', (req, res) => {
    res.json({
      ok: isReady(),
      exchanges: Object.keys(getExchanges()),
      testnet: config.useTestnet,
      dryRun: config.dryRun,
      tradePercentage: config.tradePercentage,
      // The settings that decide what an order actually looks like. These are
      // set in a dashboard, away from the code, and a value that silently fell
      // back to its default is indistinguishable from one deliberately chosen
      // — until a trade is refused for a reason that makes no sense. Reporting
      // them costs nothing and makes "is the deployed config what I think it
      // is" answerable without reading a log.
      marginMode: config.marginMode ?? null,
      // The LIVE values, which a runtime change moves away from the boot
      // config. Reporting what booted would make this readout disagree with
      // the orders being sent, which is the one thing it exists to prevent.
      leverage: live().leverage ?? null,
      tradePercentageLive: live().tradePercentage,
      maxPositionNotional: live().maxPositionNotional ?? null,
      maxPositionPercent: live().maxPositionPercent ?? null,
      minNotionalBump: config.minNotionalBump === true,
      // Decides what a reversal signal does: in one-way mode an opposite
      // entry is refused while a position is open, in hedge mode it opens
      // alongside it. Same signal, opposite outcomes, and nothing else
      // reports which one is in force.
      hedgeMode: config.hedgeMode === true,
      // A signal with no target of its own still gets one from
      // TAKE_PROFIT_PERCENT if that is set, so turning the target off in the
      // strategy is not enough on its own to run stop-only. Same for the stop.
      stopLossPercent: config.stopLossPercent ?? null,
      takeProfitPercent: config.takeProfitPercent ?? null,
      // Whether state actually survives a restart. Attaching a Render disk and
      // forgetting STATE_DIR leaves it mounted and unused, and the only
      // symptom is the breaker silently rebuilding its baseline every boot —
      // which is invisible until the day it cannot.
      state: (() => {
        const dir = config.stateDir || null;
        let writable = false;
        try { fsx.accessSync(dir, fsx.constants.W_OK); writable = true; } catch { writable = false; }
        return {
          dir,
          writable,
          // A path inside the app directory is ephemeral on Render however
          // writable it is, so say so rather than implying durability. Shared
          // with the settings readouts, which have to agree with this.
          persistent: stateIsDurable(config),
        };
      })(),
      uptimeSeconds: Math.round(process.uptime()),
      // Top level, not nested under scanner: the breaker halts hand-sent
      // orders too, so a trip has to be visible when the scanner is off.
      // Keyed by exchange: each venue is a separate account with its own
      // daily baseline, so one shared figure would be comparing balances that
      // have nothing to do with each other.
      breakers: breakers
        ? Object.fromEntries(breakers.entries().map(([id, b]) => [id, {
          tripped: b.blocked, reason: b.reason, day: b.day,
          baseline: b.baseline, consecutiveLosses: b.consecutiveLosses,
          // The counts mean nothing without the limits they are approaching.
          // consecutiveLosses counts equity OBSERVATIONS that came in lower
          // than the last, once per scan — not closed trades — so it climbs
          // on an open position drifting for a few minutes, and "3 of 4" is
          // the difference between noise and a day's trading about to halt.
          maxConsecutiveLosses: b.maxConsecutiveLosses ?? null,
          maxDailyLossPercent: b.maxDailyLossPercent ?? null,
        }]))
        : {},
      scanner: (() => {
        // Config decides this, not the presence of the handle. startScanner
        // returns a no-op { stop() {} } when disabled, which is truthy — so
        // testing the handle reported every server as running a scanner, with
        // lastScanAt stuck at null forever. That is precisely backwards for
        // the one field a monitor watches to tell a live bot from a dead one.
        // The LIVE settings, not the frozen boot config: a runtime change
        // that /health could not see would make the readout disagree with the
        // loop it is meant to describe.
        const live = scannerSettings || config.scanner;
        if (!live || !live.enabled) return { enabled: false };
        const s = app.locals.scanner;
        const last = s ? s.lastTickAt : null;
        return {
          enabled: true,
          executing: live.execute,
          reversing: live.reverse === true,
          strategy: live.strategy ?? null,
          // Defensive spread: /health is what you reach for when something is
          // already wrong, so it must not be the thing that throws.
          symbols: Array.isArray(live.symbols) ? [...live.symbols] : [],
          // The ARRAY, which is what the sweep iterates. Reporting the legacy
          // singular showed the value the process booted with while the loop
          // scanned something else entirely — the readout contradicting the
          // thing it exists to describe.
          timeframes: Array.isArray(live.timeframes) && live.timeframes.length
            ? [...live.timeframes]
            : [live.timeframe].filter(Boolean),
          exchange: live.exchange ?? null,
          lastScanAt: last ? new Date(last).toISOString() : null,
          secondsSinceScan: last ? Math.round((Date.now() - last) / 1000) : null,
          breakerTripped: breakers ? breakers.for(live.exchange).blocked : false,
          breakerReason: breakers ? breakers.for(live.exchange).reason : null,
        };
      })(),
    });
  });

  // Read-only market data. Authenticated like everything else — not because
  // candles are secret, but because each call spends this server's rate limit
  // with the exchange, and an open proxy would be someone else's free feed.
  app.get('/api/markets', requireAuth, rateLimit, async (req, res, next) => {
    try {
      // Omitting `exchange` searches every configured venue at once: the same
      // ticker can list on both with very different minimums, and seeing them
      // side by side is the point.
      const all = getExchanges();
      let scope = all;
      if (req.query.exchange) {
        const one = resolveExchange(all, req.query.exchange);
        scope = { [one.id]: one };
      }
      const markets = await searchAcrossExchanges(scope, req.query.q, {
        limit: Number(req.query.limit) || 40,
        logger,
      });
      return res.json({ success: true, count: markets.length, markets });
    } catch (err) {
      return next(err);
    }
  });

  // Which of the given symbols a venue lists. Cheap on purpose: it reads the
  // market map already in memory and makes no exchange call, so the panel can
  // re-check the whole watchlist every time the exchange is switched.
  app.get('/api/markets/listed', requireAuth, rateLimit, (req, res, next) => {
    try {
      const exchange = resolveExchange(getExchanges(), req.query.exchange);
      const symbols = String(req.query.symbols || '')
        .split(',').map((s) => s.trim()).filter(Boolean);
      if (symbols.length === 0) {
        throw new RequestError('"symbols" must name at least one market.');
      }
      // The same ceiling the scanner enforces, so this cannot be used to walk
      // the whole market list one query at a time.
      if (symbols.length > 50) {
        throw new RequestError('"symbols" is limited to 50 per check.');
      }
      return res.json({
        success: true,
        exchange: exchange.id,
        listed: listedSymbols(exchange, symbols),
      });
    } catch (err) {
      return next(err);
    }
  });

  app.get('/api/candles', requireAuth, rateLimit, async (req, res, next) => {
    if (!isReady()) {
      return res.status(503).json({ success: false, error: 'Server is still starting up.' });
    }
    try {
      const exchange = resolveExchange(getExchanges(), req.query.exchange);
      const data = await fetchCandles(exchange, {
        symbol: req.query.symbol,
        timeframe: req.query.timeframe,
        limit: req.query.limit,
      });
      return res.json({ success: true, ...data });
    } catch (err) {
      return next(err);
    }
  });

  app.get('/api/risk', requireAuth, rateLimit, (req, res, next) => {
    try {
      if (!riskSettings) throw new RequestError('Risk settings are not available on this server.', 501);
      return res.json({ success: true, risk: readRisk(riskSettings, config, { persists: stateIsDurable(config) }) });
    } catch (err) {
      return next(err);
    }
  });

  /**
   * Changes what every future order looks like.
   *
   * Logged at warn level like the scanner's switch: this is the other endpoint
   * that can change how much of the account a single signal commits, and the
   * log is where that decision is recorded.
   */
  app.post('/api/risk', requireAuth, rateLimit, (req, res, next) => {
    try {
      if (!riskSettings) throw new RequestError('Risk settings are not available on this server.', 501);
      const before = { ...riskSettings };
      applyRisk(riskSettings, req.body);
      const saved = saveRisk(riskSettings, config, logger);
      // A write that succeeded into the app directory is still lost at the
      // next deploy, so a successful save is necessary but not sufficient.
      const now = readRisk(riskSettings, config, { persists: saved && stateIsDurable(config) });
      logger.warn(
        `[${req.id}] risk settings changed -> ${before.tradePercentage}% at ${before.leverage ?? 'default'}x `
        + `becomes ${now.tradePercentage}% at ${now.leverage ?? 'default'}x, `
        + `caps ${now.maxPositionNotional ?? 'none'} / ${now.maxPositionPercent ?? 'none'}%`
      );
      return res.json({ success: true, risk: now });
    } catch (err) {
      return next(err);
    }
  });

  app.get('/api/scanner', requireAuth, rateLimit, (req, res, next) => {
    try {
      if (!scannerSettings) throw new RequestError('Scanner settings are not available on this server.', 501);
      return res.json({ success: true, scanner: readSettings(scannerSettings, config, { persists: stateIsDurable(config) }) });
    } catch (err) {
      return next(err);
    }
  });

  app.post('/api/scanner', requireAuth, rateLimit, (req, res, next) => {
    try {
      if (!scannerSettings) throw new RequestError('Scanner settings are not available on this server.', 501);
      applySettings(scannerSettings, req.body, { exchanges: getExchanges() });
      // Written before responding, so a success means the change is durable —
      // not durable-looking until the next restart quietly reverts it.
      const saved = saveSettings(scannerSettings, config, logger);
      const now = readSettings(scannerSettings, config, { persists: saved && stateIsDurable(config) });
      // Loud on purpose: this is the one endpoint that can start an
      // autonomous trader, and the log is where that decision is recorded.
      logger.warn(
        `[${req.id}] scanner settings changed -> enabled=${now.enabled} execute=${now.execute} `
        + `strategy=${now.strategy} ${now.exchange} ${now.symbols.join(',')} `
        + `@ ${(now.timeframes || [now.timeframe]).join(',')}`
      );
      return res.json({ success: true, scanner: now });
    } catch (err) {
      return next(err);
    }
  });

  // What is actually open. Until this existed, the only way to answer "what
  // did the bot just do" was to open the exchange's own app.
  app.get('/api/positions', requireAuth, rateLimit, async (req, res, next) => {
    if (!isReady()) {
      return res.status(503).json({ success: false, error: 'Server is still starting up.' });
    }
    try {
      const all = getExchanges();
      const scope = req.query.exchange
        ? { [resolveExchange(all, req.query.exchange).id]: resolveExchange(all, req.query.exchange) }
        : all;
      const { positions, problems } = await readPositions(scope, { logger });
      // Margin alongside the positions: an entry needs free margin and a
      // reduceOnly close does not, so "closes work, opens do not" is answered
      // by this number and by almost nothing else.
      const accounts = await readAccounts(scope, { logger });

      // The widest stop a NEW entry could carry right now, per venue. The
      // Best TF sweep ranks settings on how they backtested and knows nothing
      // about this, so a high-scoring daily timeframe can be one the server
      // refuses on every signal. Reporting the limit lets the panel say which
      // rows are actually placeable instead of leaving that to be discovered
      // one refused trade at a time.
      //
      // A snapshot, not a promise: it widens as positions close and tightens
      // as they open, and the guard at order time remains the authority.
      for (const [id, acct] of Object.entries(accounts)) {
        const exposure = positions
          .filter((p) => p.exchange === id)
          .reduce((sum, p) => sum + Math.abs(p.notional || 0), 0);
        acct.exposure = exposure;
        acct.maxStopPercent = config.marginMode === 'cross'
          ? usableStopPercent({
            equity: acct.free,
            // A representative new order, since the limit depends on its size.
            notionalQuote: config.minOrderNotional || 10,   // a representative order
            existingNotional: exposure,
            maintenanceMarginRate: config.maintenanceMarginRate,
            safetyFactor: config.liquidationSafetyFactor,
          })
          : null;
      }
      // problems is always present, even when empty: a caller that has to
      // check whether the field exists will eventually forget to.
      return res.json({ success: true, count: positions.length, positions, accounts, problems });
    } catch (err) {
      return next(err);
    }
  });

  /**
   * Closes a position at market with reduceOnly.
   *
   * The closing side is derived here from the position the exchange reports,
   * not taken from the caller. A stale panel that still thinks a position is
   * long would otherwise send a sell that opens a short instead of closing
   * anything — the one mistake this endpoint exists to make impossible.
   */
  app.post('/api/positions/close', requireAuth, rateLimit, async (req, res, next) => {
    if (!isReady()) {
      return res.status(503).json({ success: false, error: 'Server is still starting up.' });
    }
    try {
      const exchange = resolveExchange(getExchanges(), req.body && req.body.exchange);
      const symbol = String((req.body && req.body.symbol) || '').trim();
      if (!symbol) throw new RequestError('"symbol" is required.');

      const open = await findPosition(exchange, symbol);
      const wanted = String((req.body && req.body.side) || '').toLowerCase();
      let position;
      if (open.length === 1) {
        position = open[0];
      } else {
        // A hedge account holds both directions on one symbol; closing "the"
        // position would be a coin flip.
        if (!wanted) {
          throw new RequestError(
            `${symbol} has both a long and a short open. Say which with "side": "long" or "short".`,
            409
          );
        }
        position = open.find((p) => String(p.side).toLowerCase() === wanted);
        if (!position) throw new RequestError(`No open ${wanted} position on ${symbol}.`, 404);
      }

      const request = validateTradeRequest(
        {
          exchange: exchange.id,
          symbol,
          side: closingSideFor(position),
          reduceOnly: true,
        },
        { [exchange.id]: exchange }
      );
      const result = await executeTrade(request, {
        config: live(),
        dedupe,
        // Deliberately no breaker: executeTrade exempts reduceOnly anyway, and
        // a tripped breaker must never be the reason someone cannot get flat.
        logger,
        requestId: req.id,
      });
      return res.json(result);
    } catch (err) {
      return next(err);
    }
  });

  // Takes the stop and target OFF a position without closing it. These are
  // sent with the entry as position attributes rather than resting orders, so
  // they cannot be cancelled from an order list.
  app.post('/api/positions/protection', requireAuth, rateLimit, async (req, res, next) => {
    if (!isReady()) {
      return res.status(503).json({ success: false, error: 'Server is still starting up.' });
    }
    try {
      const exchange = resolveExchange(getExchanges(), req.body && req.body.exchange);
      const symbol = String((req.body && req.body.symbol) || '').trim();
      if (!symbol) throw new RequestError('"symbol" is required.');
      await findPosition(exchange, symbol);   // 404 rather than a silent no-op
      const out = await clearProtection(exchange, symbol);
      logger.warn(`[${req.id}] cleared stop and target on ${symbol} (${exchange.id})`);
      return res.json({ success: true, ...out });
    } catch (err) {
      return next(err);
    }
  });

  // Cancels resting orders on ONE symbol. A blanket cancel is not offered:
  // it is one tap from removing protection on positions nobody was thinking
  // about at the time.
  app.post('/api/orders/cancel', requireAuth, rateLimit, async (req, res, next) => {
    if (!isReady()) {
      return res.status(503).json({ success: false, error: 'Server is still starting up.' });
    }
    try {
      const exchange = resolveExchange(getExchanges(), req.body && req.body.exchange);
      const symbol = String((req.body && req.body.symbol) || '').trim();
      if (!symbol) throw new RequestError('"symbol" is required.');
      const out = await cancelOrders(exchange, symbol);
      logger.warn(`[${req.id}] cancelled resting orders on ${symbol} (${exchange.id})`);
      return res.json({ success: true, ...out });
    } catch (err) {
      return next(err);
    }
  });

  app.post('/api/trade', requireAuth, rateLimit, async (req, res, next) => {
    if (!isReady()) {
      return res.status(503).json({ success: false, error: 'Server is still starting up.' });
    }
    try {
      const request = validateTradeRequest(req.body, getExchanges());
      const result = await executeTrade(request, {
        config: live(),
        dedupe,
        breaker: breakers ? breakers.for(request.exchangeId) : null,
        logger,
        requestId: req.id,
      });
      return res.json(result);
    } catch (err) {
      return next(err);
    }
  });

  app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Not found.' });
  });

  // Static hosting is intentionally absent. `express.static('../')` served the
  // backend's own source over HTTP and resolved against the working directory
  // rather than the file. Netlify serves the frontend.

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const status = err instanceof RequestError ? err.status : 500;
    const requestId = req.id || 'unknown';

    if (status >= 500) {
      logger.error(`[${requestId}] ${err.stack || err.message}`);
    } else {
      logger.warn(`[${requestId}] ${status}: ${err.message}`);
    }

    // Only caller-facing messages are echoed; exchange internals stay in the log.
    const message = err.expose ? err.message : 'Trade execution failed. See server logs.';
    res.status(status).json({ success: false, error: message, requestId });
  });

  return app;
}

module.exports = { createApp };

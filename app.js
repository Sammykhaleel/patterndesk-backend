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
const { readSettings, applySettings, saveSettings, settingsPath } = require('./scannerapi');

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
function createApp({ config, getExchanges, isReady, breakers = null, scannerSettings = null, logger = console }) {
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
      leverage: config.leverage ?? null,
      maxPositionNotional: config.maxPositionNotional ?? null,
      maxPositionPercent: config.maxPositionPercent ?? null,
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
          // writable it is, so say so rather than implying durability.
          persistent: writable && !!dir && !dir.startsWith(__dirname),
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
          timeframe: live.timeframe ?? null,
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

  app.get('/api/scanner', requireAuth, rateLimit, (req, res, next) => {
    try {
      if (!scannerSettings) throw new RequestError('Scanner settings are not available on this server.', 501);
      return res.json({ success: true, scanner: readSettings(scannerSettings, config, { persists: !!settingsPath(config) }) });
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
      const now = readSettings(scannerSettings, config, { persists: saved });
      // Loud on purpose: this is the one endpoint that can start an
      // autonomous trader, and the log is where that decision is recorded.
      logger.warn(
        `[${req.id}] scanner settings changed -> enabled=${now.enabled} execute=${now.execute} `
        + `strategy=${now.strategy} ${now.exchange} ${now.symbols.join(',')} @ ${now.timeframe}`
      );
      return res.json({ success: true, scanner: now });
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
        config,
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

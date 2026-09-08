'use strict';

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');

const {
  RequestError,
  DedupeCache,
  validateTradeRequest,
  executeTrade,
} = require('./trading');
const { searchAcrossExchanges, fetchCandles, resolveExchange } = require('./marketdata');

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
function createApp({ config, getExchanges, isReady, breakers = null, logger = console }) {
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
        }]))
        : {},
      scanner: (() => {
        // Config decides this, not the presence of the handle. startScanner
        // returns a no-op { stop() {} } when disabled, which is truthy — so
        // testing the handle reported every server as running a scanner, with
        // lastScanAt stuck at null forever. That is precisely backwards for
        // the one field a monitor watches to tell a live bot from a dead one.
        if (!config.scanner || !config.scanner.enabled) return { enabled: false };
        const s = app.locals.scanner;
        const last = s ? s.lastTickAt : null;
        return {
          enabled: true,
          executing: config.scanner.execute,
          lastScanAt: last ? new Date(last).toISOString() : null,
          secondsSinceScan: last ? Math.round((Date.now() - last) / 1000) : null,
          breakerTripped: breakers ? breakers.for(config.scanner.exchange).blocked : false,
          breakerReason: breakers ? breakers.for(config.scanner.exchange).reason : null,
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

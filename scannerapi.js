'use strict';

/**
 * Runtime scanner settings.
 *
 * Changing a strategy or a timeframe by editing a dashboard variable costs a
 * redeploy and a minute of downtime, which is enough friction that it does not
 * get done. These endpoints change the running loop in place.
 *
 * Two things follow from that, and both are deliberate:
 *
 *   - Every field is validated here, not trusted. This is the one API that can
 *     arm an autonomous trader, so an unknown key is rejected rather than
 *     ignored, and each value is bounded exactly as config.js bounds it.
 *   - Changes are IN MEMORY. A restart returns to whatever the environment
 *     says, and the response says so rather than letting someone believe a
 *     setting is permanent when a redeploy will silently undo it.
 */

const { RequestError } = require('./trading');

const STRATEGIES = new Set(['pattern', 'supertrend']);
const TIMEFRAMES = new Set([
  '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '1w', '1M',
]);

function asBool(name, value) {
  if (value === true || value === false) return value;
  throw new RequestError(`"${name}" must be true or false.`);
}

function asNumber(name, value, { min, max, integer = false }) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new RequestError(`"${name}" must be a number.`);
  if (integer && !Number.isInteger(n)) throw new RequestError(`"${name}" must be a whole number.`);
  if (min !== undefined && n < min) throw new RequestError(`"${name}" must be >= ${min}.`);
  if (max !== undefined && n > max) throw new RequestError(`"${name}" must be <= ${max}.`);
  return n;
}

/**
 * Each writable field and how to read it. An explicit table rather than a
 * merge: anything not named here cannot be set, so a typo is an error instead
 * of a silently ignored key that leaves someone believing they changed
 * something.
 */
const FIELDS = {
  enabled: (v) => asBool('enabled', v),
  execute: (v) => asBool('execute', v),
  strategy: (v) => {
    const s = String(v || '').toLowerCase();
    if (!STRATEGIES.has(s)) {
      throw new RequestError(`"strategy" must be one of: ${[...STRATEGIES].join(', ')}.`);
    }
    return s;
  },
  // Every symbol is scanned against every timeframe, so this multiplies the
  // work: 20 symbols x 9 timeframes is 180 candle requests per sweep. Capped
  // so a single call cannot set up a sweep that outlasts its own interval.
  timeframes: (v) => {
    const list = Array.isArray(v) ? v : String(v || '').split(',');
    const tfs = list.map((t) => String(t).trim()).filter(Boolean);
    if (tfs.length === 0) throw new RequestError('"timeframes" must name at least one.');
    if (tfs.length > 9) throw new RequestError('"timeframes" is limited to 9 per scan.');
    for (const t of tfs) {
      if (!TIMEFRAMES.has(t)) throw new RequestError(`"${t}" is not a timeframe this scanner can request.`);
    }
    return tfs;
  },
  timeframe: (v) => {
    const t = String(v || '');
    if (!TIMEFRAMES.has(t)) {
      throw new RequestError(`"timeframe" must be one of: ${[...TIMEFRAMES].join(', ')}.`);
    }
    return t;
  },
  exchange: (v, { exchanges }) => {
    const id = String(v || '').toLowerCase();
    if (!exchanges[id]) {
      throw new RequestError(
        `"exchange" must be one this server has credentials for: ${Object.keys(exchanges).join(', ') || 'none'}.`
      );
    }
    return id;
  },
  symbols: (v, { exchanges, next }) => {
    const list = Array.isArray(v) ? v : String(v || '').split(',');
    const symbols = list.map((s) => String(s).trim()).filter(Boolean);
    if (symbols.length === 0) throw new RequestError('"symbols" must name at least one market.');
    if (symbols.length > 20) throw new RequestError('"symbols" is limited to 20 markets per scan.');

    // Checked against the venue the scanner will actually poll, so a symbol
    // that only exists on the other exchange is refused now rather than
    // failing once an hour in the log.
    const exchange = exchanges[next.exchange];
    if (exchange) {
      for (const symbol of symbols) {
        try {
          exchange.market(symbol);
        } catch {
          throw new RequestError(`"${symbol}" is not listed on ${next.exchange}.`);
        }
      }
    }
    return symbols;
  },
};

const SUPERTREND_FIELDS = {
  period: (v) => asNumber('supertrend.period', v, { min: 2, max: 200, integer: true }),
  multiplier: (v) => asNumber('supertrend.multiplier', v, { min: 0.1, max: 20 }),
  rewardRisk: (v) => asNumber('supertrend.rewardRisk', v, { min: 0.1, max: 20 }),
  minRR: (v) => asNumber('supertrend.minRR', v, { min: 0, max: 20 }),
};

/** What the UI renders. Mirrors the shape the POST accepts. */
function readSettings(settings, config) {
  return {
    enabled: settings.enabled === true,
    execute: settings.execute === true,
    strategy: settings.strategy,
    exchange: settings.exchange,
    symbols: [...settings.symbols],
    timeframe: settings.timeframe,
    timeframes: [...(settings.timeframes || [settings.timeframe])],
    supertrend: { ...settings.supertrend },
    // Runtime changes live in memory only. Saying so beside the values is the
    // difference between "I changed this" and "I changed this until the next
    // deploy, restart, or Render moving the instance".
    persistsAcrossRestart: false,
    bootedWith: {
      enabled: config.scanner.enabled,
      execute: config.scanner.execute,
      strategy: config.scanner.strategy,
      exchange: config.scanner.exchange,
      symbols: [...config.scanner.symbols],
      timeframe: config.scanner.timeframe,
      timeframes: [...(config.scanner.timeframes || [config.scanner.timeframe])],
    },
    intervalMs: settings.intervalMs,
  };
}

/**
 * Applies a patch, or throws without changing anything.
 *
 * Validated into a copy first and only committed once every field passes, so a
 * request that is half-valid does not leave the scanner half-configured —
 * running the new strategy against the old symbol, say.
 */
function applySettings(settings, patch, { exchanges }) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new RequestError('Request body must be a JSON object.');
  }

  const unknown = Object.keys(patch).filter((k) => !(k in FIELDS) && k !== 'supertrend');
  if (unknown.length > 0) {
    throw new RequestError(
      `Unknown setting${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. `
      + `Writable: ${[...Object.keys(FIELDS), 'supertrend'].join(', ')}.`
    );
  }

  const next = { ...settings, supertrend: { ...settings.supertrend } };

  // exchange before symbols: the symbol check needs to know which venue it is
  // validating against, and a patch may change both at once.
  if ('exchange' in patch) next.exchange = FIELDS.exchange(patch.exchange, { exchanges, next });
  for (const [key, read] of Object.entries(FIELDS)) {
    if (key === 'exchange' || !(key in patch)) continue;
    next[key] = read(patch[key], { exchanges, next });
  }

  if ('supertrend' in patch) {
    const st = patch.supertrend;
    if (!st || typeof st !== 'object' || Array.isArray(st)) {
      throw new RequestError('"supertrend" must be an object.');
    }
    const badKeys = Object.keys(st).filter((k) => !(k in SUPERTREND_FIELDS));
    if (badKeys.length > 0) {
      throw new RequestError(
        `Unknown supertrend setting${badKeys.length > 1 ? 's' : ''}: ${badKeys.join(', ')}.`
      );
    }
    for (const [key, read] of Object.entries(SUPERTREND_FIELDS)) {
      if (key in st) next.supertrend[key] = read(st[key]);
    }
  }

  // A reward multiple under the floor rejects every signal the strategy
  // produces, which reads as the strategy being broken rather than misconfigured.
  if (next.strategy === 'supertrend' && next.supertrend.rewardRisk < next.supertrend.minRR) {
    throw new RequestError(
      `supertrend.rewardRisk (${next.supertrend.rewardRisk}) is below supertrend.minRR `
      + `(${next.supertrend.minRR}), so every signal would be rejected as under-RR.`
    );
  }

  Object.assign(settings, next);
  return settings;
}

module.exports = { readSettings, applySettings, STRATEGIES, TIMEFRAMES };

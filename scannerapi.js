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

const fs = require('fs');
const path = require('path');
const { RequestError } = require('./trading');

const SETTINGS_FILE = 'scanner-settings.json';

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
  reverse: (v) => asBool('reverse', v),
  overrides: (v, ctx) => readOverrides(v, ctx),
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

/**
 * Per-symbol tuning, from the chart's "Best TF" sweep.
 *
 * A symbol named here is scanned on ITS OWN timeframe and parameters instead
 * of the global ones. Everything else — strategy, exchange, execute, reverse —
 * still comes from the one place, because those are decisions about the
 * account rather than about a market.
 *
 * Overrides for symbols not currently selected are kept rather than pruned:
 * removing a symbol for a day should not throw away the work of tuning it.
 */
function readOverrides(v, { exchanges, next }) {
  if (v === null) return {};              // explicit "clear them all"
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new RequestError('"overrides" must be an object keyed by symbol.');
  }
  const entries = Object.entries(v);
  if (entries.length > 40) {
    throw new RequestError('"overrides" is limited to 40 symbols.');
  }

  const exchange = exchanges[next.exchange];
  const out = {};
  for (const [symbol, raw] of entries) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new RequestError(`"overrides.${symbol}" must be an object.`);
    }
    // Checked against the venue that will actually poll it, exactly as the
    // symbol list is, so a tuning for a market this exchange does not list is
    // refused now rather than failing once a minute in the log.
    if (exchange) {
      try {
        exchange.market(symbol);
      } catch {
        throw new RequestError(`"${symbol}" is not listed on ${next.exchange}.`);
      }
    }

    const bad = Object.keys(raw).filter((k) => k !== 'timeframe' && k !== 'supertrend');
    if (bad.length > 0) {
      throw new RequestError(`Unknown key in "overrides.${symbol}": ${bad.join(', ')}. Writable: timeframe, supertrend.`);
    }

    const entry = {};
    if ('timeframe' in raw) {
      const t = String(raw.timeframe || '');
      if (!TIMEFRAMES.has(t)) {
        throw new RequestError(`"overrides.${symbol}.timeframe" is not a timeframe this scanner can request.`);
      }
      entry.timeframe = t;
    }
    if ('supertrend' in raw) {
      const st = raw.supertrend;
      if (!st || typeof st !== 'object' || Array.isArray(st)) {
        throw new RequestError(`"overrides.${symbol}.supertrend" must be an object.`);
      }
      const badSt = Object.keys(st).filter((k) => k !== 'period' && k !== 'multiplier');
      if (badSt.length > 0) {
        throw new RequestError(`Unknown key in "overrides.${symbol}.supertrend": ${badSt.join(', ')}.`);
      }
      entry.supertrend = {};
      if ('period' in st) entry.supertrend.period = SUPERTREND_FIELDS.period(st.period);
      if ('multiplier' in st) entry.supertrend.multiplier = SUPERTREND_FIELDS.multiplier(st.multiplier);
    }

    // An entry that overrides nothing is a no-op that would sit in the saved
    // file looking meaningful. Refused so "clear this symbol" is expressed by
    // removing the key, and only that.
    if (Object.keys(entry).length === 0) {
      throw new RequestError(`"overrides.${symbol}" sets nothing. Remove the key to clear it.`);
    }
    out[symbol] = entry;
  }
  return out;
}

const SUPERTREND_FIELDS = {
  period: (v) => asNumber('supertrend.period', v, { min: 2, max: 200, integer: true }),
  multiplier: (v) => asNumber('supertrend.multiplier', v, { min: 0.1, max: 20 }),
  // 0 is not a degenerate multiple, it is the off switch: no take-profit,
  // the Supertrend line is the only exit.
  rewardRisk: (v) => asNumber('supertrend.rewardRisk', v, { min: 0, max: 20 }),
  minRR: (v) => asNumber('supertrend.minRR', v, { min: 0, max: 20 }),
};

/** What the UI renders. Mirrors the shape the POST accepts. */
function readSettings(settings, config, { persists = false } = {}) {
  return {
    enabled: settings.enabled === true,
    execute: settings.execute === true,
    reverse: settings.reverse === true,
    strategy: settings.strategy,
    exchange: settings.exchange,
    symbols: [...settings.symbols],
    timeframe: settings.timeframe,
    timeframes: [...(settings.timeframes || [settings.timeframe])],
    supertrend: { ...settings.supertrend },
    overrides: JSON.parse(JSON.stringify(settings.overrides || {})),
    // Whether a change here actually survives. Without a mounted STATE_DIR
    // this is false, and saying so is the difference between "I changed this"
    // and "I changed this until Render next moves the instance" — which for
    // a DISABLE is the dangerous direction, since the environment variable
    // would turn the scanner back on unattended.
    persistsAcrossRestart: persists === true,
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
  // Skipped when the target is off: with no reward there is no ratio to
  // compare, so refusing the save would make "no target" unreachable
  // unless minRR were zeroed first.
  if (next.strategy === 'supertrend' && next.supertrend.rewardRisk > 0
      && next.supertrend.rewardRisk < next.supertrend.minRR) {
    throw new RequestError(
      `supertrend.rewardRisk (${next.supertrend.rewardRisk}) is below supertrend.minRR `
      + `(${next.supertrend.minRR}), so every signal would be rejected as under-RR.`
    );
  }

  Object.assign(settings, next);
  return settings;
}

module.exports = { readSettings, applySettings, STRATEGIES, TIMEFRAMES };

/* ------------------------------------------------------------------ *
 * Persistence
 *
 * Runtime changes that vanish on restart are the wrong failure mode for a
 * panel that can arm a trader. The dangerous direction is not losing an
 * enable — it is losing a DISABLE: turn the scanner off here, Render moves
 * the instance, and the environment variable turns it back on with whatever
 * strategy it names, unattended.
 * ------------------------------------------------------------------ */

/** The one file, or null when there is nowhere durable to put it. */
function settingsPath(config) {
  if (!config.stateDir) return null;
  return path.join(config.stateDir, SETTINGS_FILE);
}

/**
 * Writes the current settings. Temp file then rename, so a crash mid-write
 * cannot leave a half-parsed file that fails to load on the next boot.
 */
function saveSettings(settings, config, logger = console) {
  const file = settingsPath(config);
  if (!file) return false;
  const payload = JSON.stringify({
    enabled: settings.enabled,
    execute: settings.execute,
    reverse: settings.reverse,
    strategy: settings.strategy,
    exchange: settings.exchange,
    symbols: settings.symbols,
    timeframe: settings.timeframe,
    timeframes: settings.timeframes,
    supertrend: settings.supertrend,
    overrides: settings.overrides || {},
    savedAt: new Date().toISOString(),
  }, null, 2);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, payload);
    fs.renameSync(`${file}.tmp`, file);
    return true;
  } catch (err) {
    logger.error(`[scanner] could not save settings to ${file} (${err.message}) — this change will not survive a restart.`);
    return false;
  }
}

/**
 * Applies a saved file over the boot settings, if one exists.
 *
 * Each field is put through the same validator the API uses, so a file that
 * was hand-edited, half-written, or written by an older version cannot set
 * something the API would refuse. A bad file is ignored with a warning rather
 * than taking the process down — the environment is still a valid config.
 */
function loadSettings(settings, config, { exchanges = {}, logger = console } = {}) {
  const file = settingsPath(config);
  if (!file) return false;

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn(`[scanner] could not read ${file}: ${err.message}`);
    return false;
  }

  let saved;
  try {
    saved = JSON.parse(raw);
  } catch {
    logger.warn(`[scanner] ${file} is not valid JSON — starting from the environment instead.`);
    return false;
  }
  if (!saved || typeof saved !== 'object') return false;

  const { savedAt, ...patch } = saved;
  try {
    applySettings(settings, patch, { exchanges });
    logger.log(
      `[scanner] restored saved settings from ${savedAt || 'an earlier run'}: `
      + `enabled=${settings.enabled} execute=${settings.execute} strategy=${settings.strategy} `
      + `${settings.exchange} ${settings.symbols.join(',')} @ ${(settings.timeframes || []).join(',')}`
    );
    return true;
  } catch (err) {
    logger.warn(`[scanner] saved settings rejected (${err.message}) — starting from the environment instead.`);
    return false;
  }
}

module.exports.saveSettings = saveSettings;
module.exports.loadSettings = loadSettings;
module.exports.settingsPath = settingsPath;

'use strict';

/**
 * Runtime risk settings.
 *
 * The four values that decide what an order actually looks like: leverage, the
 * slice of balance a position takes, and the two ceilings that can refuse it.
 * They lived only in the environment, so changing one meant editing a
 * dashboard field and waiting for a restart — enough friction that the wrong
 * value tends to stay.
 *
 * They are grouped rather than offered singly because they interact, and
 * changing one alone is how the confusing refusals happen: raising the trade
 * percentage without raising MAX_POSITION_PERCENT produces an order the
 * server computes and then declines, with the reason buried in a log.
 *
 * Bounds here are the same ones config.js applies at boot. A second, looser
 * copy would let the panel set values the next restart would reject.
 */

const fs = require('fs');
const path = require('path');
const { RequestError } = require('./trading');

const SETTINGS_FILE = 'risk-settings.json';

function asNumber(name, value, { min, max, integer = false }) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new RequestError(`"${name}" must be a number.`);
  if (integer && !Number.isInteger(n)) throw new RequestError(`"${name}" must be a whole number.`);
  if (min !== undefined && n < min) throw new RequestError(`"${name}" must be >= ${min}.`);
  if (max !== undefined && n > max) throw new RequestError(`"${name}" must be <= ${max}.`);
  return n;
}

/**
 * Each writable field. An explicit table, so an unknown key is an error rather
 * than a silently ignored typo that leaves someone believing they changed the
 * size of every future order.
 */
const FIELDS = {
  // null means "leave it to the exchange's own setting", which is what a
  // missing LEVERAGE means at boot.
  leverage: (v) => (v === null ? null : asNumber('leverage', v, { min: 1, max: 125 })),
  tradePercentage: (v) => asNumber('tradePercentage', v, { min: 0.01, max: 1000 }),
  maxPositionNotional: (v) => (v === null ? null : asNumber('maxPositionNotional', v, { min: 0 })),
  maxPositionPercent: (v) => (v === null ? null : asNumber('maxPositionPercent', v, { min: 0.01, max: 10000 })),
};

/** The mutable copy the running server reads. config stays the boot record. */
function createRiskSettings(config) {
  return {
    leverage: config.leverage ?? null,
    tradePercentage: config.tradePercentage,
    maxPositionNotional: config.maxPositionNotional ?? null,
    maxPositionPercent: config.maxPositionPercent ?? null,
  };
}

/**
 * What executeTrade should see.
 *
 * An overlay rather than a rewrite of config: everything else — margin mode,
 * stop percent, the breaker's limits — still comes from the frozen boot
 * record, and only these four are live.
 */
function riskConfig(config, settings) {
  if (!settings) return config;
  return {
    ...config,
    leverage: settings.leverage,
    tradePercentage: settings.tradePercentage,
    tradeFraction: settings.tradePercentage / 100,
    maxPositionNotional: settings.maxPositionNotional,
    maxPositionPercent: settings.maxPositionPercent,
  };
}

/** What the panel renders. Mirrors the shape the POST accepts. */
function readRisk(settings, config, { persists = false } = {}) {
  return {
    leverage: settings.leverage,
    tradePercentage: settings.tradePercentage,
    maxPositionNotional: settings.maxPositionNotional,
    maxPositionPercent: settings.maxPositionPercent,
    persistsAcrossRestart: persists === true,
    bootedWith: {
      leverage: config.leverage ?? null,
      tradePercentage: config.tradePercentage,
      maxPositionNotional: config.maxPositionNotional ?? null,
      maxPositionPercent: config.maxPositionPercent ?? null,
    },
    // Context the panel needs to show what a setting will actually produce,
    // rather than making someone hold the arithmetic in their head.
    marginMode: config.marginMode ?? null,
    minOrderNotional: config.minOrderNotional ?? null,
  };
}

/**
 * Applies a patch, or throws without changing anything.
 *
 * Validated into a copy and committed only once every field passes, including
 * the cross-check between size and leverage — a half-applied patch could leave
 * a percentage the leverage cannot fund, which the exchange refuses at order
 * time rather than here.
 */
function applyRisk(settings, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new RequestError('Request body must be a JSON object.');
  }

  const unknown = Object.keys(patch).filter((k) => !(k in FIELDS));
  if (unknown.length > 0) {
    throw new RequestError(
      `Unknown setting${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. `
      + `Writable: ${Object.keys(FIELDS).join(', ')}.`
    );
  }

  const next = { ...settings };
  for (const [key, read] of Object.entries(FIELDS)) {
    if (key in patch) next[key] = read(patch[key]);
  }

  // The same rule config.js enforces at boot. A percentage above 100 means
  // borrowing, which needs leverage to cover it; without this the exchange
  // rejects the order for insufficient margin and the reason is opaque.
  if (next.tradePercentage > 100) {
    if (!next.leverage) {
      throw new RequestError(
        `A trade size of ${next.tradePercentage}% of balance needs leverage above 1x, but leverage is not set.`
      );
    }
    if (next.tradePercentage / 100 > next.leverage) {
      throw new RequestError(
        `A trade size of ${next.tradePercentage}% needs at least ${Math.ceil(next.tradePercentage / 100)}x `
        + `leverage, but leverage is ${next.leverage}x. The exchange would reject the order.`
      );
    }
  }

  // A ceiling below the size it caps is not a limit, it is a guarantee that
  // every order is refused. Worth saying now rather than once an hour in a log.
  if (next.maxPositionPercent !== null && next.maxPositionPercent < next.tradePercentage) {
    throw new RequestError(
      `maxPositionPercent (${next.maxPositionPercent}%) is below tradePercentage `
      + `(${next.tradePercentage}%), so every order would be refused by its own ceiling. `
      + 'Raise the cap, or lower the trade size.'
    );
  }

  Object.assign(settings, next);
  return settings;
}

/* ------------------------------------------------------------------ *
 * Persistence — same shape as the scanner's, and for the same reason:
 * a size change that quietly reverts on the next restart is worse than
 * one that was never made.
 * ------------------------------------------------------------------ */

function riskPath(config) {
  if (!config.stateDir) return null;
  return path.join(config.stateDir, SETTINGS_FILE);
}

function saveRisk(settings, config, logger = console) {
  const file = riskPath(config);
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...settings, savedAt: new Date().toISOString() }, null, 2));
    fs.renameSync(`${file}.tmp`, file);
    return true;
  } catch (err) {
    logger.error(`[risk] could not save to ${file} (${err.message}) — this change will not survive a restart.`);
    return false;
  }
}

function loadRisk(settings, config, { logger = console } = {}) {
  const file = riskPath(config);
  if (!file) return false;

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn(`[risk] could not read ${file}: ${err.message}`);
    return false;
  }

  let saved;
  try {
    saved = JSON.parse(raw);
  } catch {
    logger.warn(`[risk] ${file} is not valid JSON — starting from the environment instead.`);
    return false;
  }
  if (!saved || typeof saved !== 'object') return false;

  const { savedAt, ...patch } = saved;
  try {
    applyRisk(settings, patch);
    logger.log(
      `[risk] restored saved settings from ${savedAt || 'an earlier run'}: `
      + `${settings.tradePercentage}% of balance at ${settings.leverage ?? 'exchange default'}x, `
      + `caps ${settings.maxPositionNotional ?? 'none'} / ${settings.maxPositionPercent ?? 'none'}%`
    );
    return true;
  } catch (err) {
    logger.warn(`[risk] saved settings rejected (${err.message}) — starting from the environment instead.`);
    return false;
  }
}

module.exports = {
  createRiskSettings,
  riskConfig,
  readRisk,
  applyRisk,
  saveRisk,
  loadRisk,
  riskPath,
};

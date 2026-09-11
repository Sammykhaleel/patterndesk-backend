'use strict';

/**
 * The browser origins allowed to call this server.
 *
 * ALLOWED_ORIGINS is set in a dashboard, and moving the frontend to a new
 * Netlify address meant editing it there and waiting for a restart. Worse,
 * the symptom of forgetting is not an error message but an app that loads and
 * then fails every request, because a browser refuses the preflight before
 * the server sees the token.
 *
 * Deliberately NOT reachable from a disallowed origin. A new site cannot add
 * itself — that would make the allowlist decorative. It is changed from the
 * setup page this server hosts, which is same-origin and so needs no CORS
 * permission of its own.
 */

const fs = require('fs');
const path = require('path');
const { RequestError } = require('./trading');
const { stateIsDurable } = require('./statedir');

const SETTINGS_FILE = 'allowed-origins.json';

/** Enough for a production site, a preview deploy or two, and localhost. */
const MAX_ORIGINS = 20;

/**
 * A browser's Origin header is scheme://host[:port] — no path, no trailing
 * slash. Pasting the address bar's contents gives you a URL instead, so the
 * common input is normalised rather than rejected: comparing a pasted
 * "https://site.app/" against an Origin of "https://site.app" would fail with
 * the two looking identical in a log.
 */
function normaliseOrigin(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RequestError('An origin is required, like https://your-site.netlify.app');
  }
  const raw = value.trim();
  if (raw === '*') {
    throw new RequestError('"*" would allow every site on the internet to call this server. List each origin instead.');
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new RequestError(`"${raw}" is not a URL. Include the scheme, like https://your-site.netlify.app`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new RequestError(`"${raw}" must be an http or https address.`);
  }
  // http is how localhost is served during development, and refusing it would
  // make the local case impossible. Anywhere else it is a mistake worth
  // naming: the token would cross the network in clear text.
  if (url.protocol === 'http:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new RequestError(
      `"${raw}" is plain http, which would send your auth token unencrypted. Use https (http is allowed for localhost only).`
    );
  }
  return url.origin;
}

/** The mutable copy the CORS check reads. config stays the boot record. */
function createOrigins(config) {
  return [...(config.allowedOrigins || [])];
}

/** What the setup page renders. */
function readOrigins(origins, config, { persists = false } = {}) {
  return {
    origins: [...origins],
    bootedWith: [...(config.allowedOrigins || [])],
    persistsAcrossRestart: persists === true,
    max: MAX_ORIGINS,
  };
}

function addOrigin(origins, value) {
  const origin = normaliseOrigin(value);
  if (origins.includes(origin)) return origins; // idempotent: adding twice is not an error
  if (origins.length >= MAX_ORIGINS) {
    throw new RequestError(`Already at the limit of ${MAX_ORIGINS} origins. Remove one first.`);
  }
  origins.push(origin);
  return origins;
}

/**
 * Removing the last origin is allowed.
 *
 * It locks every browser out, but the setup page is served by this server and
 * is same-origin, so it still opens and can put one back. Refusing would be
 * protecting against a state that is not actually a dead end.
 */
function removeOrigin(origins, value) {
  const origin = normaliseOrigin(value);
  const at = origins.indexOf(origin);
  if (at === -1) {
    throw new RequestError(`${origin} is not on the list.`);
  }
  origins.splice(at, 1);
  return origins;
}

/* ------------------------------------------------------------------ *
 * Persistence — same shape as the risk and scanner settings.
 * ------------------------------------------------------------------ */

function originsPath(config) {
  if (!config.stateDir) return null;
  return path.join(config.stateDir, SETTINGS_FILE);
}

function saveOrigins(origins, config, logger = console) {
  const file = originsPath(config);
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ origins, savedAt: new Date().toISOString() }, null, 2));
    fs.renameSync(`${file}.tmp`, file);
    return stateIsDurable(config);
  } catch (err) {
    logger.error(`[origins] could not save to ${file} (${err.message}) — this change will not survive a restart.`);
    return false;
  }
}

/**
 * Restores the saved list, replacing the environment's.
 *
 * Replacing rather than merging: a removal has to survive a restart too, and
 * merging would quietly resurrect an origin that was deliberately taken off.
 * The environment is the seed for a server that has never been configured.
 */
function loadOrigins(origins, config, { logger = console } = {}) {
  const file = originsPath(config);
  if (!file) return false;

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn(`[origins] could not read ${file}: ${err.message}`);
    return false;
  }

  let saved;
  try {
    saved = JSON.parse(raw);
  } catch {
    logger.warn(`[origins] ${file} is not valid JSON — using ALLOWED_ORIGINS instead.`);
    return false;
  }
  if (!saved || !Array.isArray(saved.origins)) return false;

  // Validated into a copy: one bad entry must not leave the list half
  // replaced, which would be neither what was saved nor what was configured.
  const next = [];
  for (const entry of saved.origins) {
    try {
      const origin = normaliseOrigin(entry);
      if (!next.includes(origin)) next.push(origin);
    } catch (err) {
      logger.warn(`[origins] dropping saved entry ${JSON.stringify(entry)}: ${err.message}`);
    }
  }

  origins.length = 0;
  origins.push(...next.slice(0, MAX_ORIGINS));
  logger.log(
    `[origins] restored ${origins.length} allowed origin${origins.length === 1 ? '' : 's'} `
    + `from ${saved.savedAt || 'an earlier run'}: ${origins.join(', ') || 'none'}`
  );
  return true;
}

module.exports = {
  createOrigins,
  readOrigins,
  addOrigin,
  removeOrigin,
  normaliseOrigin,
  saveOrigins,
  loadOrigins,
  originsPath,
  MAX_ORIGINS,
};

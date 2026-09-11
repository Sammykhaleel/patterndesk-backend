'use strict';

/**
 * Whether STATE_DIR actually outlives the process.
 *
 * Three things claim to know this — /health, the risk readout and the scanner
 * readout — and they disagreed: the readouts asked only whether a directory
 * was configured, which is true of the default, and the default is the app
 * directory. On Render that is wiped by every deploy. So a panel could report
 * "saved settings survive a restart" while each deploy quietly reverted them
 * to the environment, which is the precise failure the readout exists to warn
 * about.
 *
 * One definition, because two tests for the same property is how they drift.
 */

const fs = require('fs');
const path = require('path');

/** The deployed code. config.js defaults stateDir here when STATE_DIR is unset. */
const APP_DIR = __dirname;

/**
 * Whether `dir` lies outside `appDir` — the half of the question that is pure
 * path arithmetic, separated so it can be checked against paths that do not
 * exist on this machine.
 *
 * path.relative rather than a prefix comparison, which would read a sibling
 * named like the app directory — /app-data next to /app — as being inside it
 * and call a real mount ephemeral.
 */
function isOutside(appDir, dir) {
  const rel = path.relative(appDir, dir);
  return rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel));
}

/**
 * True only for a writable directory outside the deployed code.
 *
 * Both halves matter and for different reasons: an unwritable mount loses
 * writes now and says so in a log, while a writable app directory loses them
 * at the next deploy and says nothing at all.
 *
 * @param {{stateDir?: string|null}} config
 */
function stateIsDurable(config) {
  const dir = (config && config.stateDir) || null;
  if (!dir) return false;

  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    return false;
  }

  return isOutside(APP_DIR, dir);
}

module.exports = { stateIsDurable, isOutside, APP_DIR };

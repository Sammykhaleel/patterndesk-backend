'use strict';

/**
 * Whether saved state survives a deploy.
 *
 * The answer is reported in three places and was computed differently in each.
 * What is asserted here is the property that made that dangerous: the app
 * directory is writable, so "can I write there" is not the same question as
 * "will it still be there tomorrow", and only the first was being asked.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { stateIsDurable, isOutside, APP_DIR } = require('../statedir');

function tempDir(prefix = 'pd-statedir-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

test('a mounted disk outside the app directory is durable', () => {
  assert.equal(stateIsDurable({ stateDir: tempDir() }), true);
});

test('the app directory is not durable however writable it is', () => {
  // The default when STATE_DIR is unset, and the case the whole check exists
  // for: on Render every deploy replaces it, so a settings file written there
  // is gone without anything having failed.
  assert.equal(fs.existsSync(APP_DIR), true, 'the app directory exists');
  assert.doesNotThrow(() => fs.accessSync(APP_DIR, fs.constants.W_OK), 'and is writable here');
  assert.equal(stateIsDurable({ stateDir: APP_DIR }), false);
});

test('a subdirectory of the app directory is not durable either', () => {
  // STATE_DIR=./data is the obvious thing to try, and it is wiped with the
  // rest of the deploy.
  assert.equal(stateIsDurable({ stateDir: path.join(APP_DIR, 'data') }), false);
});

test('a sibling whose name starts with the app directory is outside it', () => {
  // /app-data next to /app, the shape Render's own docs use. A prefix
  // comparison reads this as being inside the app directory and calls a real
  // mount ephemeral — reporting the alarming answer for a setup that is
  // actually fine, and sending someone looking for a disk they already have.
  const app = path.join(path.sep, 'app');
  assert.equal(path.join(path.sep, 'app-data').startsWith(app), true,
    'the name really is a prefix of the other');
  assert.equal(isOutside(app, path.join(path.sep, 'app-data')), true, 'but it is a separate directory');

  assert.equal(isOutside(app, path.join(app, 'data')), false, 'while a real subdirectory is inside');
  assert.equal(isOutside(app, app), false, 'and the directory itself is not outside itself');
  assert.equal(isOutside(app, path.join(path.sep, 'var', 'data')), true, 'an unrelated mount is outside');
});

test('an unwritable or missing directory is not durable', () => {
  assert.equal(stateIsDurable({ stateDir: path.join(os.tmpdir(), 'pd-no-such-dir-ever') }), false,
    'a mount path that was never created loses writes now, not at the next deploy');
});

test('no directory at all is not durable', () => {
  assert.equal(stateIsDurable({ stateDir: null }), false);
  assert.equal(stateIsDurable({ stateDir: '' }), false, 'an empty STATE_DIR is not a directory');
  assert.equal(stateIsDurable({}), false);
  assert.equal(stateIsDurable(null), false, 'and it does not throw on no config');
});

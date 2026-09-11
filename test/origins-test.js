'use strict';

/**
 * The allowlist that decides which frontends may drive this account.
 *
 * The failure this guards against is subtle: a browser refuses a disallowed
 * origin before the server sees the token, so the symptom of a wrong list is
 * an app that loads and then fails silently. What is asserted is mostly what
 * the list refuses to become — open to everything, half-edited, or quietly
 * reverted on restart.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createOrigins, readOrigins, addOrigin, removeOrigin, normaliseOrigin,
  saveOrigins, loadOrigins, originsPath, MAX_ORIGINS,
} = require('../origins');
const { RequestError } = require('../trading');

const SITE = 'https://heartfelt-sundae-eca675.netlify.app';
const NEW_SITE = 'https://patterndesk-new.netlify.app';
const CONFIG = { allowedOrigins: [SITE], stateDir: null };

const quiet = { log() {}, warn() {}, error() {} };
function noisy(warnings = [], errors = []) {
  return { log() {}, warn(m) { warnings.push(m); }, error(m) { errors.push(m); } };
}
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-origins-'));
  test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

test('the live list starts as a copy of the environment, not a reference', () => {
  const live = createOrigins(CONFIG);
  assert.deepEqual(live, [SITE]);
  addOrigin(live, NEW_SITE);
  assert.deepEqual(CONFIG.allowedOrigins, [SITE],
    'the boot record must stay as the record of what was configured');
});

test('a pasted address bar URL is reduced to an origin', () => {
  // What people actually have in the clipboard. Comparing "https://site/" to
  // an Origin header of "https://site" would fail with the two looking
  // identical in a log.
  assert.equal(normaliseOrigin('https://site.netlify.app/'), 'https://site.netlify.app');
  assert.equal(normaliseOrigin('https://site.netlify.app/charts?tf=15m#x'), 'https://site.netlify.app');
  assert.equal(normaliseOrigin('  https://site.netlify.app  '), 'https://site.netlify.app');
  assert.equal(normaliseOrigin('https://site.netlify.app:8443/x'), 'https://site.netlify.app:8443',
    'a non-default port is part of the origin and must survive');
});

test('a wildcard is refused', () => {
  // The one entry that makes the list decorative.
  assert.throws(() => normaliseOrigin('*'), (e) => e instanceof RequestError && /every site on the internet/.test(e.message));
});

test('plain http is refused except on localhost', () => {
  // The token travels in a header on every request; over http it is readable
  // by anything on the path.
  assert.throws(() => normaliseOrigin('http://my-site.app'), (e) => /unencrypted/.test(e.message));
  assert.equal(normaliseOrigin('http://localhost:5173'), 'http://localhost:5173');
  assert.equal(normaliseOrigin('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
});

test('non-URLs and other schemes are refused', () => {
  for (const bad of ['', '   ', 'my-site.app', 'ftp://site.app', 'javascript:alert(1)', null, 42, {}]) {
    assert.throws(() => normaliseOrigin(bad), RequestError, `${JSON.stringify(bad)} should be refused`);
  }
});

test('adding the same origin twice is not an error', () => {
  // The setup page is the sort of thing someone taps twice on a phone.
  const live = createOrigins(CONFIG);
  addOrigin(live, SITE);
  addOrigin(live, `${SITE}/`);
  assert.deepEqual(live, [SITE], 'and does not duplicate it');
});

test('the list is capped', () => {
  const live = [];
  for (let i = 0; i < MAX_ORIGINS; i++) addOrigin(live, `https://site-${i}.netlify.app`);
  assert.throws(() => addOrigin(live, 'https://one-too-many.netlify.app'),
    (e) => new RegExp(`limit of ${MAX_ORIGINS}`).test(e.message));
  assert.equal(live.length, MAX_ORIGINS, 'and the refused one did not sneak in');
});

test('removing an origin that is not listed says so', () => {
  const live = createOrigins(CONFIG);
  assert.throws(() => removeOrigin(live, NEW_SITE), (e) => /is not on the list/.test(e.message));
  assert.deepEqual(live, [SITE], 'and changes nothing');
});

test('removing the last origin is allowed', () => {
  // It locks every browser out, but the setup page is served by this server
  // and is same-origin, so it still opens and can put one back. Refusing
  // would be guarding a state that is not a dead end.
  const live = createOrigins(CONFIG);
  removeOrigin(live, SITE);
  assert.deepEqual(live, []);
});

test('the readout shows the live list beside what booted', () => {
  const live = createOrigins(CONFIG);
  addOrigin(live, NEW_SITE);
  const out = readOrigins(live, CONFIG, { persists: true });
  assert.deepEqual(out.origins, [SITE, NEW_SITE]);
  assert.deepEqual(out.bootedWith, [SITE], 'so the difference from ALLOWED_ORIGINS is visible');
  assert.equal(out.persistsAcrossRestart, true);
  assert.equal(out.max, MAX_ORIGINS);
  out.origins.push('https://not-really.app');
  assert.equal(live.length, 2, 'and the readout is a copy, not the live list');
});

test('a change survives a restart', () => {
  const stateDir = tempDir();
  const cfg = { ...CONFIG, stateDir };
  const live = createOrigins(cfg);
  addOrigin(live, NEW_SITE);
  assert.equal(saveOrigins(live, cfg, quiet), true);

  const rebooted = createOrigins(cfg);
  assert.equal(loadOrigins(rebooted, cfg, { logger: quiet }), true);
  assert.deepEqual(rebooted, [SITE, NEW_SITE]);
});

test('a removal survives a restart too', () => {
  // The saved list REPLACES the environment rather than merging with it.
  // Merging would resurrect an origin that was deliberately taken off, which
  // is the failure that actually matters here.
  const stateDir = tempDir();
  const cfg = { ...CONFIG, stateDir };
  const live = createOrigins(cfg);
  removeOrigin(live, SITE);
  addOrigin(live, NEW_SITE);
  saveOrigins(live, cfg, quiet);

  const rebooted = createOrigins(cfg);
  loadOrigins(rebooted, cfg, { logger: quiet });
  assert.deepEqual(rebooted, [NEW_SITE], 'the removed origin did not come back');
});

test('a saved file with one bad entry keeps the good ones', () => {
  const stateDir = tempDir();
  const cfg = { ...CONFIG, stateDir };
  fs.writeFileSync(originsPath(cfg), JSON.stringify({ origins: [NEW_SITE, '*', 'not-a-url', `${SITE}/`] }));

  const warnings = [];
  const live = createOrigins(cfg);
  assert.equal(loadOrigins(live, cfg, { logger: noisy(warnings) }), true);
  assert.deepEqual(live, [NEW_SITE, SITE], 'the valid entries survive, normalised');
  assert.equal(warnings.filter((w) => /dropping saved entry/.test(w)).length, 2,
    'and each dropped entry is named rather than vanishing');
});

test('a corrupt file falls back to the environment', () => {
  const stateDir = tempDir();
  const cfg = { ...CONFIG, stateDir };
  fs.writeFileSync(originsPath(cfg), '{"origins": [');
  const live = createOrigins(cfg);
  assert.equal(loadOrigins(live, cfg, { logger: quiet }), false);
  assert.deepEqual(live, [SITE], 'which is better than starting with nothing allowed');
});

test('with no state directory nothing is written and the API says so', () => {
  const cfg = { ...CONFIG, stateDir: null };
  assert.equal(originsPath(cfg), null);
  assert.equal(saveOrigins(createOrigins(cfg), cfg, quiet), false);
  assert.equal(loadOrigins(createOrigins(cfg), cfg, { logger: quiet }), false);
});

test('a write into an ephemeral directory is not reported as permanent', () => {
  // The app directory is writable, so the save genuinely succeeds — and is
  // genuinely lost at the next deploy. Same rule as the risk settings.
  const cfg = { ...CONFIG, stateDir: path.join(__dirname, 'tmp-origins-ephemeral') };
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  test.after(() => { try { fs.rmSync(cfg.stateDir, { recursive: true, force: true }); } catch { /* best effort */ } });

  assert.equal(saveOrigins(createOrigins(cfg), cfg, quiet), false, 'not durable');
  assert.equal(fs.existsSync(originsPath(cfg)), true, 'even though the file is really there');
});

test('a failed write is reported rather than returning success', () => {
  const dir = tempDir();
  const cfg = { ...CONFIG, stateDir: path.join(dir, 'a-file', 'nested') };
  fs.writeFileSync(path.join(dir, 'a-file'), 'not a directory');
  const errors = [];
  assert.equal(saveOrigins(createOrigins(cfg), cfg, noisy([], errors)), false);
  assert.match(errors.join(' '), /will not survive a restart/);
});

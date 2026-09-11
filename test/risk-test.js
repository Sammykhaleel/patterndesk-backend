'use strict';

/**
 * Runtime risk settings.
 *
 * These four decide how much of the account a single signal commits, so what
 * is asserted here is mostly about refusing combinations that would look
 * applied and then fail at order time — a size the leverage cannot fund, or a
 * ceiling below the size it caps.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createRiskSettings, riskConfig, readRisk, applyRisk, saveRisk, loadRisk, riskPath,
} = require('../risk');
const { RequestError } = require('../trading');

const quiet = { log() {}, warn() {}, error() {} };
const noisy = (warnings = [], errors = []) => ({
  log() {}, warn(m) { warnings.push(m); }, error(m) { errors.push(m); },
});

const CONFIG = {
  leverage: 25,
  tradePercentage: 5,
  tradeFraction: 0.05,
  maxPositionNotional: 50,
  maxPositionPercent: 10,
  marginMode: 'cross',
  minOrderNotional: 1,
  stopLossPercent: 2,
};

const live = () => createRiskSettings(CONFIG);

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-risk-'));
  test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

/* ---------------- the mutable copy ---------------- */

test('the running copy starts from the environment', () => {
  const s = live();
  assert.equal(s.leverage, 25);
  assert.equal(s.tradePercentage, 5);
  assert.equal(s.maxPositionNotional, 50);
  assert.equal(s.maxPositionPercent, 10);
});

test('editing it does not rewrite the boot config', () => {
  // config is the record of what the environment said. A runtime change that
  // edited it would erase the ability to say "this is not what you deployed".
  const s = live();
  applyRisk(s, { tradePercentage: 50, maxPositionPercent: 60 });
  assert.equal(CONFIG.tradePercentage, 5);
  assert.equal(CONFIG.maxPositionPercent, 10);
});

/* ---------------- what an order sees ---------------- */

test('the overlay replaces only the four, and derives tradeFraction', () => {
  // executeTrade reads tradeFraction, not tradePercentage. Updating one and
  // not the other would change the displayed size while orders kept their old
  // one — the worst possible split.
  const s = live();
  applyRisk(s, { tradePercentage: 50, leverage: 10, maxPositionPercent: 60 });
  const cfg = riskConfig(CONFIG, s);
  assert.equal(cfg.tradePercentage, 50);
  assert.equal(cfg.tradeFraction, 0.5);
  assert.equal(cfg.leverage, 10);
  assert.equal(cfg.marginMode, 'cross', 'everything else still comes from config');
  assert.equal(cfg.stopLossPercent, 2);
});

test('with no settings the config is returned untouched', () => {
  assert.equal(riskConfig(CONFIG, null), CONFIG);
});

/* ---------------- bounds ---------------- */

test('leverage is bounded exactly as the environment bounds it', () => {
  const s = live();
  assert.throws(() => applyRisk(s, { leverage: 0.5 }), (e) => e instanceof RequestError);
  assert.throws(() => applyRisk(s, { leverage: 126 }), (e) => e instanceof RequestError);
  applyRisk(s, { leverage: 125 });
  assert.equal(s.leverage, 125);
});

test('leverage can be cleared back to the exchange default', () => {
  const s = live();
  applyRisk(s, { leverage: null });
  assert.equal(s.leverage, null);
});

test('an unknown setting is refused, not ignored', () => {
  const s = live();
  assert.throws(
    () => applyRisk(s, { levrage: 10 }),
    (e) => e instanceof RequestError && /Unknown setting: levrage/.test(e.message)
  );
  assert.equal(s.leverage, 25, 'and nothing changed');
});

/* ---------------- the combinations that matter ---------------- */

test('a size above 100% needs leverage to fund it', () => {
  // Above 100% of balance is borrowing. Without leverage the exchange rejects
  // the order for insufficient margin, and the reason arrives far from here.
  const s = live();
  applyRisk(s, { leverage: null });
  assert.throws(
    () => applyRisk(s, { tradePercentage: 250 }),
    (e) => e instanceof RequestError && /needs leverage above 1x/.test(e.message)
  );
});

test('a size above what the leverage covers is refused', () => {
  const s = live();
  // Inside the 1000 bound, so this reaches the leverage check rather than
  // being stopped by the range one first.
  assert.throws(
    () => applyRisk(s, { tradePercentage: 900, leverage: 5, maxPositionPercent: 1000 }),
    (e) => e instanceof RequestError && /needs at least 9x/.test(e.message)
  );
});

test('250% at 25x is fine — that is the point of leverage', () => {
  const s = live();
  applyRisk(s, { tradePercentage: 250, maxPositionPercent: 300 });
  assert.equal(s.tradePercentage, 250);
  assert.equal(riskConfig(CONFIG, s).tradeFraction, 2.5);
});

test('a ceiling below the size it caps is refused', () => {
  // This is the trap that produced "the order was computed and then declined":
  // raising the trade percentage without raising MAX_POSITION_PERCENT means
  // every order is refused by its own cap, once an hour, in a log.
  const s = live();
  assert.throws(
    () => applyRisk(s, { tradePercentage: 50 }),
    (e) => e instanceof RequestError && /below tradePercentage/.test(e.message)
  );
});

test('raising both together is accepted', () => {
  const s = live();
  applyRisk(s, { tradePercentage: 50, maxPositionPercent: 60 });
  assert.equal(s.tradePercentage, 50);
  assert.equal(s.maxPositionPercent, 60);
});

test('a half-valid patch changes nothing', () => {
  // Validated into a copy and committed only once every field passes, so a
  // rejected combination cannot leave the size raised and the cap not.
  const s = live();
  assert.throws(() => applyRisk(s, { tradePercentage: 50, maxPositionPercent: 60, leverage: 999 }));
  assert.equal(s.tradePercentage, 5, 'the size was not applied');
  assert.equal(s.leverage, 25, 'nor the leverage');
});

test('clearing the percent cap removes that check rather than failing it', () => {
  const s = live();
  applyRisk(s, { maxPositionPercent: null, tradePercentage: 80 });
  assert.equal(s.maxPositionPercent, null);
  assert.equal(s.tradePercentage, 80);
});

/* ---------------- what the panel is told ---------------- */

test('the readout reports live values and what booted', () => {
  const s = live();
  applyRisk(s, { leverage: 10 });
  const view = readRisk(s, CONFIG);
  assert.equal(view.leverage, 10);
  assert.equal(view.bootedWith.leverage, 25, 'so a runtime change is visible as a change');
});

test('persistence is reported honestly', () => {
  assert.equal(readRisk(live(), CONFIG, { persists: false }).persistsAcrossRestart, false);
  assert.equal(readRisk(live(), CONFIG, { persists: true }).persistsAcrossRestart, true);
});

/* ---------------- persistence ---------------- */

test('a change survives a restart', () => {
  const stateDir = tempDir();
  const cfg = { ...CONFIG, stateDir };
  const s = live();
  applyRisk(s, { tradePercentage: 50, maxPositionPercent: 60, leverage: 10 });
  assert.equal(saveRisk(s, cfg, quiet), true);

  const rebooted = live();
  assert.equal(loadRisk(rebooted, cfg, { logger: quiet }), true);
  assert.equal(rebooted.tradePercentage, 50);
  assert.equal(rebooted.maxPositionPercent, 60);
  assert.equal(rebooted.leverage, 10);
});

test('a saved file the API would refuse is ignored, not applied', () => {
  // Hand-edited, or written by a build with looser bounds. Trusting it would
  // let a file set a size the endpoint rejects.
  const stateDir = tempDir();
  const cfg = { ...CONFIG, stateDir };
  fs.writeFileSync(path.join(stateDir, 'risk-settings.json'),
    JSON.stringify({ tradePercentage: 900, leverage: 2 }));
  const s = live();
  const warnings = [];
  assert.equal(loadRisk(s, cfg, { logger: noisy(warnings) }), false);
  assert.equal(s.tradePercentage, 5, 'the environment still applies');
  assert.match(warnings.join(' '), /rejected/);
});

test('a truncated file does not stop the server booting', () => {
  const stateDir = tempDir();
  const cfg = { ...CONFIG, stateDir };
  fs.writeFileSync(path.join(stateDir, 'risk-settings.json'), '{"leverage": 1');
  const s = live();
  assert.equal(loadRisk(s, cfg, { logger: quiet }), false);
  assert.equal(s.leverage, 25);
});

test('with no disk nothing is written and the API says so', () => {
  const cfg = { ...CONFIG, stateDir: null };
  assert.equal(riskPath(cfg), null);
  assert.equal(saveRisk(live(), cfg, quiet), false);
  assert.equal(loadRisk(live(), cfg, { logger: quiet }), false);
});

test('a failed write is reported rather than returning success', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a-file'), 'not a directory');
  const cfg = { ...CONFIG, stateDir: path.join(dir, 'a-file', 'nested') };
  const errors = [];
  assert.equal(saveRisk(live(), cfg, noisy([], errors)), false);
  assert.match(errors.join(' '), /will not survive a restart/);
});

test('the write is atomic, leaving no partial file', () => {
  const stateDir = tempDir();
  saveRisk(live(), { ...CONFIG, stateDir }, quiet);
  assert.deepEqual(fs.readdirSync(stateDir), ['risk-settings.json']);
});

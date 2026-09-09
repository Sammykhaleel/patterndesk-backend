'use strict';

const path = require('path');
const fs = require('fs');

// Resolve .env against this file, not process.cwd(). Otherwise `node
// server/server.js` from the project root, or a systemd unit with a different
// WorkingDirectory, silently loads nothing.
const ENV_PATH = path.resolve(__dirname, '.env');
const ENV_EXISTS = fs.existsSync(ENV_PATH);

require('dotenv').config({ path: ENV_PATH });

const errors = [];
const warnings = [];

function required(name) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    errors.push(`${name} is required but not set.`);
    return null;
  }
  return raw.trim();
}

function optional(name, fallback = null) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim();
}

// Strict boolean parsing. A typo must be a startup failure, never a silent
// fallback to the dangerous value (this is what made USE_TESTNET unreliable).
function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    if (fallback === undefined) errors.push(`${name} is required but not set.`);
    return fallback;
  }
  const v = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  errors.push(`${name} must be true or false, got "${raw}".`);
  return fallback;
}

function number(name, { fallback, min, max, integer = false } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    if (fallback === undefined) errors.push(`${name} is required but not set.`);
    return fallback;
  }
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) {
    errors.push(`${name} must be a finite number, got "${raw}".`);
    return fallback;
  }
  if (integer && !Number.isInteger(n)) {
    errors.push(`${name} must be a whole number, got "${raw}".`);
    return fallback;
  }
  if (min !== undefined && n < min) {
    errors.push(`${name} must be >= ${min}, got ${n}.`);
    return fallback;
  }
  if (max !== undefined && n > max) {
    errors.push(`${name} must be <= ${max}, got ${n}.`);
    return fallback;
  }
  return n;
}

function list(name, fallback = []) {
  const raw = optional(name);
  if (!raw) return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

// Above 100 means notional exceeds the balance, which only works with
// leverage. The consistency check against LEVERAGE happens below.
const tradePercentage = number('TRADE_BALANCE_PERCENTAGE', {
  fallback: 1,
  min: 0.01,
  max: 1000,
});

const authToken = required('AUTH_TOKEN');
if (authToken && authToken.length < 32) {
  errors.push('AUTH_TOKEN must be at least 32 characters. Generate one with: openssl rand -hex 32');
}

const allowedOrigins = list('ALLOWED_ORIGINS');
if (allowedOrigins.includes('*')) {
  errors.push('ALLOWED_ORIGINS must not contain "*". List your frontend origins explicitly.');
}

// Render (and most PaaS hosts) route traffic to the container, so a service
// bound to loopback is unreachable and fails health checks. Detect the
// platform and default accordingly. An explicit BIND_HOST always wins.
//
// On a plain VM (Oracle Cloud, a VPS) neither is true: loopback is correct,
// and a reverse proxy in front of it is something you opt into.
const ON_RENDER = Boolean(process.env.RENDER || process.env.RENDER_SERVICE_ID);
const DEFAULT_BIND_HOST = ON_RENDER ? '0.0.0.0' : '127.0.0.1';

const config = {
  port: number('PORT', { fallback: 3000, min: 1, max: 65535, integer: true }),
  // Loopback everywhere else: exposing a money-moving service on every
  // interface must be a deliberate act, not the out-of-the-box behaviour.
  bindHost: optional('BIND_HOST', DEFAULT_BIND_HOST),
  onRender: ON_RENDER,

  // Number of reverse proxies in front of this process. Express uses it to
  // decide how far to trust X-Forwarded-For when reporting req.ip, which is
  // what the rate limiter buckets by.
  //
  // That header is written by the caller. Trusting it when nothing is in
  // front means anyone can send a fresh X-Forwarded-For per request and get
  // an unlimited number of attempts at the auth token. So: 0 unless a proxy
  // is actually there. Render always has one; Caddy on a VM is one.
  trustProxy: number('TRUST_PROXY', {
    fallback: ON_RENDER ? 1 : 0,
    min: 0,
    max: 10,
    integer: true,
  }),

  authToken,
  allowedOrigins,
  rateLimitPerMinute: number('RATE_LIMIT_PER_MINUTE', { fallback: 30, min: 1, integer: true }),

  useTestnet: bool('USE_TESTNET', undefined),
  // Safe by default: the server refuses to send real orders until explicitly armed.
  dryRun: bool('DRY_RUN', true),

  tradeFraction: tradePercentage / 100,
  tradePercentage,

  leverage: number('LEVERAGE', { fallback: null, min: 1, max: 125 }),
  // isolated caps a bad position's loss at the margin posted for it. cross
  // puts the whole balance behind every position. For an unattended bot,
  // isolated is the safer default.
  marginMode: (() => {
    const v = optional('MARGIN_MODE', 'isolated');
    if (v === null) return null;
    const m = v.toLowerCase();
    if (['isolated', 'cross'].includes(m)) return m;
    errors.push(`MARGIN_MODE must be "isolated" or "cross", got "${v}".`);
    return null;
  })(),
  // Refuse to trade if leverage could not be set. Sizing and the liquidation
  // check both assume the configured value.
  requireLeverageApplied: bool('REQUIRE_LEVERAGE_APPLIED', true),
  // Fraction of the theoretical liquidation distance a stop may sit within.
  // 0.7 means the stop must be closer than 70% of the way to liquidation.
  liquidationSafetyFactor: number('LIQUIDATION_SAFETY_FACTOR', { fallback: 0.7, min: 0.1, max: 0.95 }),
  // Floor for the maintenance margin the exchange holds back, as a fraction.
  // Only used under cross margin, where the distance to liquidation is set by
  // equity against exposure rather than by leverage. Bybit charges about 0.5%
  // on BTC at the lowest tier and considerably more on small alts, so 1% is a
  // deliberately cautious default; ccxt's per-market figure wins when higher.
  maintenanceMarginRate: number('MAINTENANCE_MARGIN_RATE', { fallback: 0.01, min: 0.001, max: 0.5 }),
  maxPositionNotional: number('MAX_POSITION_NOTIONAL_QUOTE', { fallback: null, min: 0 }),
  // The same ceiling as a percentage of account value, so it scales with the
  // balance instead of silently refusing every trade once you outgrow a fixed
  // figure. Both may be set; the tighter one applies.
  maxPositionPercent: number('MAX_POSITION_PERCENT', { fallback: null, min: 0.01, max: 10000 }),
  // Every market sets its own floor — a lot step and a minimum order value —
  // and on a small balance those land at wildly different percentages per
  // symbol. With this on, an order below the floor is raised to it instead of
  // refused, so one TRADE_BALANCE_PERCENTAGE works across a whole watchlist.
  // It only ever increases size, and MAX_POSITION_NOTIONAL_QUOTE plus the
  // liquidation check still bound the result. Off by default: silently
  // trading larger than asked should be a deliberate choice.
  // Which exchanges may fall back to CURRENT equity when the day's baseline
  // cannot be rebuilt from their ledger after a cold start.
  //
  // A list of exchange ids, not a switch, because the answer differs per
  // venue: ccxt reads Bybit's ledger cleanly, while Weex reports every entry
  // as an inflow and cannot be totalled at all. A global flag would relax
  // Bybit for failures it has never had, purely to unblock Weex.
  //
  // Empty (default) — refuse to open positions until a baseline exists. A
  //   daily loss limit that silently restarts is not a limit.
  // e.g. weex — that venue baselines from current equity instead, loudly.
  //   The limit then measures from process start rather than UTC midnight, so
  //   a restart part-way through a losing day forgives what came before.
  // all — every exchange. Rarely what you want.
  breakerFallbackExchanges: list('BREAKER_FALLBACK_TO_EQUITY'),
  // Hold a long AND a short on the same symbol at once.
  //
  // Requires the exchange account to be in hedge (two-way) position mode
  // already — this does not switch it for you, because doing that silently
  // would change how every existing position is margined.
  //
  // Be clear about what it buys: a matched long and short is net flat, so
  // price movement cancels and you pay two spreads, two sets of fees and
  // funding on both legs. Useful for holding a hedge while a longer position
  // matures; not a way to act on two indicators that disagree.
  hedgeMode: bool('HEDGE_MODE', false),
  minNotionalBump: bool('MIN_NOTIONAL_BUMP', false),
  // Smallest order value, in quote currency, worth placing at all.
  //
  // This is an ECONOMIC floor, not a validity one. Bybit accepted a $0.2529
  // order on RAVE — it returned an order id — so the exchange itself has no
  // objection. But ccxt reports no limits.cost.min for that market, so nothing
  // stopped a percentage of a small balance rounding down to loose change and
  // opening a position too small to be worth the position.
  //
  // The exchange's own declared minimum always wins when it is higher; this
  // only fills the gap where ccxt reports none. Set 0 to defer entirely to
  // whatever the exchange will accept.
  minOrderNotional: number('MIN_ORDER_NOTIONAL_QUOTE', { fallback: 1, min: 0 }),
  stopLossPercent: number('STOP_LOSS_PERCENT', { fallback: null, min: 0.05, max: 90 }),
  // Fallback only. The scanner supplies the pattern's measured-move target,
  // which takes precedence over this.
  takeProfitPercent: number('TAKE_PROFIT_PERCENT', { fallback: null, min: 0.05, max: 500 }),
  // When true, an entry with no resolvable stop is refused outright.
  requireProtectiveStop: bool('REQUIRE_PROTECTIVE_STOP', true),

  // Where the circuit breaker keeps its daily baseline. This directory must
  // survive a restart or the daily loss limit resets along with the process.
  // A plain VM can use the app directory; Render's filesystem is ephemeral,
  // so point this at a mounted persistent disk (e.g. /var/data).
  stateDir: optional('STATE_DIR', __dirname),

  dedupeTtlMs: number('DEDUPE_TTL_MS', { fallback: 60_000, min: 0, integer: true }),
  orderTimeoutMs: number('ORDER_TIMEOUT_MS', { fallback: 20_000, min: 1000, integer: true }),

  // Bybit rejects a signed request whose timestamp is outside this window.
  // The default of 5000 ms is tight for a machine whose clock drifts.
  recvWindowMs: number('RECV_WINDOW_MS', { fallback: 10_000, min: 1000, max: 60_000, integer: true }),
  // How often to re-measure the offset between this machine's clock and the
  // exchange's. Windows clocks drift noticeably between NTP syncs.
  timeSyncIntervalMs: number('TIME_SYNC_INTERVAL_MS', { fallback: 900_000, min: 0, integer: true }),

  scanner: {
    // Off by default. Turning this on is what makes the system autonomous.
    enabled: bool('SCANNER_ENABLED', false),
    // Separate switch: scan and log signals without sending them, even when
    // DRY_RUN is off. Lets you watch what it would have traded for a while.
    execute: bool('SCANNER_EXECUTE', false),
    exchange: (optional('SCANNER_EXCHANGE', 'bybit') || 'bybit').toLowerCase(),
    // Which engine produces signals. 'pattern' looks for a formation and
    // waits for it to break; 'supertrend' fires the bar the trend line flips.
    strategy: (() => {
      const v = (optional('SCANNER_STRATEGY', 'pattern') || 'pattern').toLowerCase();
      if (['pattern', 'supertrend'].includes(v)) return v;
      errors.push(`SCANNER_STRATEGY must be "pattern" or "supertrend", got "${v}".`);
      return 'pattern';
    })(),
    supertrend: {
      period: number('SUPERTREND_PERIOD', { fallback: 10, min: 2, max: 200, integer: true }),
      multiplier: number('SUPERTREND_MULTIPLIER', { fallback: 3, min: 0.1, max: 20 }),
      // Target as a multiple of the risk. The stop comes from the indicator
      // and moves with volatility, so a fixed percentage would be a different
      // R:R on every bar.
      // 0 disables the take-profit entirely: the Supertrend line becomes the
      // only exit. Matches what the settings panel accepts, so the two cannot
      // disagree about whether a target is switched off.
      rewardRisk: number('SUPERTREND_REWARD_RISK', { fallback: 2, min: 0, max: 20 }),
      minRR: number('SIGNAL_MIN_RR', { fallback: 1.5, min: 0 }),
    },
    symbols: list('SCANNER_SYMBOLS', ['BTC/USDT:USDT']),
    timeframe: optional('SCANNER_TIMEFRAME', '1h'),
    // Every symbol is scanned against every timeframe here. The per-bar
    // dedupe keys on symbol AND timeframe, so the same market on 15m and 1h
    // produces two independent signals rather than one hiding the other.
    // Defaults to the single SCANNER_TIMEFRAME so existing setups are
    // unchanged.
    timeframes: list('SCANNER_TIMEFRAMES', [optional('SCANNER_TIMEFRAME', '1h')]),
    intervalMs: number('SCANNER_INTERVAL_MS', { fallback: 60_000, min: 10_000, integer: true }),
    candleLimit: number('SCANNER_CANDLE_LIMIT', { fallback: 300, min: 50, max: 1000, integer: true }),
    minCandles: number('SCANNER_MIN_CANDLES', { fallback: 120, min: 30, integer: true }),
    // Account-level circuit breaker. Individual trade guards cannot stop a
    // slow bleed across many losing trades; this can.
    maxDailyLossPercent: number('MAX_DAILY_LOSS_PERCENT', { fallback: 5, min: 0.1, max: 100 }),
    maxConsecutiveLosses: number('MAX_CONSECUTIVE_LOSSES', { fallback: 4, min: 1, integer: true }),
    rules: {
      requireConfirmed: bool('SIGNAL_REQUIRE_CONFIRMED', true),
      requireFirm: bool('SIGNAL_REQUIRE_FIRM', true),
      requireTrendAgreement: bool('SIGNAL_REQUIRE_TREND', true),
      minRR: number('SIGNAL_MIN_RR', { fallback: 1.5, min: 0 }),
    },
  },

  credentials: {
    bybit: {
      apiKey: optional('BYBIT_API_KEY'),
      secret: optional('BYBIT_API_SECRET'),
      password: optional('BYBIT_API_PASSWORD'),
    },
    weex: {
      apiKey: optional('WEEX_API_KEY'),
      secret: optional('WEEX_API_SECRET'),
      // Weex signs with a third credential (the passphrase set when the key
      // was created). ccxt calls it `password`.
      password: optional('WEEX_API_PASSWORD'),
    },
  },
};

const configured = Object.entries(config.credentials).filter(
  ([, c]) => c.apiKey && c.secret
);
if (configured.length === 0) {
  errors.push('No exchange credentials configured. Set at least one API key/secret pair.');
}

for (const [id, c] of Object.entries(config.credentials)) {
  if ((c.apiKey && !c.secret) || (!c.apiKey && c.secret)) {
    errors.push(`${id.toUpperCase()} has only one of API_KEY/API_SECRET set. Set both or neither.`);
  }
  if (!c.apiKey || !c.secret) continue;

  // Ask ccxt what this exchange actually needs, rather than assuming every
  // exchange signs with just a key and secret. Weex also needs a passphrase.
  let required = [];
  try {
    // eslint-disable-next-line global-require
    const ccxt = require('ccxt');
    if (typeof ccxt[id] === 'function') {
      const probe = new ccxt[id]({});
      required = Object.entries(probe.requiredCredentials)
        .filter(([, needed]) => needed)
        .map(([name]) => name);
    }
  } catch {
    // ccxt unavailable at config time; startup will surface it instead
  }

  for (const name of required) {
    if (c[name]) continue;
    const envName = `${id.toUpperCase()}_API_${name === 'apiKey' ? 'KEY' : name.toUpperCase()}`;
    errors.push(
      `${id.toUpperCase()} requires a "${name}" credential but ${envName} is not set. ` +
      `For ${id}, this is the passphrase you chose when creating the API key.`
    );
  }
}

if (config.tradePercentage > 100) {
  if (!config.leverage) {
    errors.push(
      `TRADE_BALANCE_PERCENTAGE is ${config.tradePercentage}%, which needs leverage above 1x, but LEVERAGE is not set.`
    );
  } else if (config.tradePercentage / 100 > config.leverage) {
    errors.push(
      `TRADE_BALANCE_PERCENTAGE of ${config.tradePercentage}% needs at least ` +
      `${Math.ceil(config.tradePercentage / 100)}x leverage, but LEVERAGE is ${config.leverage}x. ` +
      `The exchange would reject the order for insufficient margin.`
    );
  }
}
if (config.leverage && config.stopLossPercent !== null) {
  const liquidationPct = 100 / config.leverage;
  const usable = liquidationPct * config.liquidationSafetyFactor;
  if (config.stopLossPercent >= usable) {
    warnings.push(
      `STOP_LOSS_PERCENT (${config.stopLossPercent}%) is beyond the usable distance at ` +
      `${config.leverage}x leverage (~${usable.toFixed(2)}%). Percentage-stop trades will be refused.`
    );
  }
}
if (config.tradePercentage > 25) {
  warnings.push(`TRADE_BALANCE_PERCENTAGE is ${config.tradePercentage}% — that is a very large slice of the account per signal.`);
}
if (config.maxPositionNotional === null && config.maxPositionPercent === null) {
  warnings.push('Neither MAX_POSITION_NOTIONAL_QUOTE nor MAX_POSITION_PERCENT is set — position size is uncapped. Set at least one; the percentage scales with the account.');
}
if (config.stopLossPercent === null && !config.requireProtectiveStop) {
  warnings.push('STOP_LOSS_PERCENT is not set and REQUIRE_PROTECTIVE_STOP is false — entries may be placed with no stop.');
}
if (config.takeProfitPercent === null) {
  warnings.push('TAKE_PROFIT_PERCENT is not set — positions without a pattern target will run until stopped out.');
}
if (config.allowedOrigins.length === 0) {
  warnings.push('ALLOWED_ORIGINS is empty — browser requests will be rejected. Only server-to-server callers will work.');
}
if (config.scanner.enabled && config.scanner.execute && !config.dryRun) {
  warnings.push('SCANNER is armed and DRY_RUN is off — this server will open positions on its own, with no human in the loop.');
  warnings.push(`Circuit breaker: halts for the day at ${config.scanner.maxDailyLossPercent}% equity loss or ${config.scanner.maxConsecutiveLosses} consecutive losing observations.`);
}
if (config.scanner.enabled && !config.credentials[config.scanner.exchange]?.apiKey) {
  errors.push(`SCANNER_EXCHANGE is "${config.scanner.exchange}" but no credentials are set for it.`);
}
if (config.scanner.enabled) {
  // Checked at startup rather than at the first loss, when it is too late to
  // be useful. An unwritable STATE_DIR silently turns the daily loss limit
  // into a per-restart limit.
  try {
    fs.accessSync(config.stateDir, fs.constants.W_OK);
  } catch {
    warnings.push(
      `STATE_DIR (${config.stateDir}) is not writable — the circuit breaker cannot persist its daily ` +
      'baseline, so a restart clears the daily loss limit. On Render, attach a persistent disk and set ' +
      'STATE_DIR to its mount path.'
    );
  }
  if (config.onRender && config.stateDir === __dirname) {
    warnings.push(
      'Running on Render with STATE_DIR left at the app directory, which is ephemeral: every deploy and ' +
      'instance move wipes the circuit breaker. Mount a persistent disk and point STATE_DIR at it.'
    );
  }
}
if (config.bindHost === '0.0.0.0' && !config.onRender) {
  warnings.push('BIND_HOST is 0.0.0.0 — the trade endpoint is reachable from any network interface. Ensure your firewall restricts it.');
}
if (config.trustProxy > 0 && config.bindHost !== '127.0.0.1' && !config.onRender) {
  warnings.push(
    `TRUST_PROXY is ${config.trustProxy} while BIND_HOST is ${config.bindHost}. If this port is reachable ` +
    'without going through the proxy, a caller can forge X-Forwarded-For and get unlimited attempts at the ' +
    'auth token. Bind to 127.0.0.1 so the proxy is the only way in.'
  );
}
if (config.trustProxy === 0 && config.bindHost === '127.0.0.1' && config.allowedOrigins.length > 0) {
  warnings.push(
    'Bound to loopback with browser origins allowed, but TRUST_PROXY is 0. If a reverse proxy is forwarding ' +
    'those browsers, every request looks like it came from 127.0.0.1 and they all share one rate-limit bucket. ' +
    'Set TRUST_PROXY=1.'
  );
}
if (config.onRender) {
  warnings.push('Running on Render: the trade endpoint is on a public URL, so AUTH_TOKEN is the only thing protecting it. Keep it long and never commit it.');
  if (config.scanner.enabled) {
    warnings.push('Render Free web services sleep after 15 minutes without inbound traffic, which stops the scanner. Use a paid instance for 24/7 scanning.');
  }
}

function loadConfig() {
  if (errors.length > 0) {
    console.error('\nConfiguration is invalid. Fix the following in your .env file:\n');
    for (const e of errors) console.error(`  - ${e}`);

    // Say exactly which file was read and what it defined. A missing variable
    // is usually a missing file or an empty value, not a typo'd name.
    console.error(`\n  .env path:  ${ENV_PATH}`);
    if (!ENV_EXISTS) {
      console.error('  .env found: NO — no file at that path.');
      console.error('              cp .env.example .env');
    } else {
      let names = [];
      let blanks = [];
      try {
        for (const raw of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
          const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
          if (!m) continue;
          names.push(m[1]);
          if (m[2].trim() === '') blanks.push(m[1]);
        }
      } catch (err) {
        console.error(`  .env found: yes, but could not be read — ${err.message}`);
      }
      console.error(`  .env found: yes (${names.length} variables)`);
      if (names.length) console.error(`  defines:    ${names.join(', ')}`);
      if (blanks.length) console.error(`  empty:      ${blanks.join(', ')} — set or remove these`);
    }
    console.error(`\n  working dir: ${process.cwd()}`);
    console.error('');
    process.exit(1);
  }
  for (const w of warnings) console.warn(`[warn] ${w}`);
  return Object.freeze(config);
}

module.exports = { loadConfig, ENV_PATH };

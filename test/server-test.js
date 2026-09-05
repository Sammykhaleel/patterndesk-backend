'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RequestError,
  DedupeCache,
  validateTradeRequest,
  executeTrade,
  computeOrderSize,
  readFreeBalance,
  resolvePrice,
  marginCurrency,
  notionalOf,
  minimumTradeableAmount,
} = require('../trading');
const { createApp } = require('../app');

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const AUTH_TOKEN = 'a'.repeat(64);

const baseConfig = {
  authToken: AUTH_TOKEN,
  allowedOrigins: ['https://patterndesk.netlify.app'],
  rateLimitPerMinute: 100,
  useTestnet: true,
  dryRun: true,
  tradeFraction: 0.05,
  tradePercentage: 5,
  leverage: 3,
  maxPositionNotional: 1000,
  stopLossPercent: 2,
  dedupeTtlMs: 60_000,
};

const linearMarket = {
  symbol: 'BTC/USDT:USDT',
  base: 'BTC',
  quote: 'USDT',
  settle: 'USDT',
  linear: true,
  inverse: false,
  contractSize: 1,
  active: true,
  limits: { amount: { min: 0.001 }, cost: { min: 5 } },
};

const inverseMarket = {
  symbol: 'BTC/USD:BTC',
  base: 'BTC',
  quote: 'USD',
  settle: 'BTC',
  linear: false,
  inverse: true,
  contractSize: 1,
  active: true,
  limits: { amount: { min: 1 }, cost: { min: 1 } },
};

function fakeExchange({
  market = linearMarket,
  balance = { USDT: { free: 10_000 } },
  price = 50_000,
  positions = [],
  onCreateOrder,
} = {}) {
  return {
    id: 'fake',
    has: { fetchPositions: true, setLeverage: true },
    markets: { [market.symbol]: market },
    market(symbol) {
      if (symbol !== market.symbol) throw new Error('no market');
      return market;
    },
    async fetchBalance() {
      return balance;
    },
    async fetchTicker() {
      return { last: price };
    },
    async fetchPositions() {
      return positions;
    },
    async setLeverage() {},
    amountToPrecision(_symbol, amount) {
      return Number(amount).toFixed(3);
    },
    priceToPrecision(_symbol, p) {
      return Number(p).toFixed(2);
    },
    async createOrder(...args) {
      if (onCreateOrder) return onCreateOrder(...args);
      return { id: 'order-1', status: 'closed', filled: args[3], average: price };
    },
  };
}

function run(request, { config = baseConfig, exchanges } = {}) {
  const validated = validateTradeRequest(request, exchanges);
  return executeTrade(validated, {
    config,
    dedupe: new DedupeCache(config.dedupeTtlMs),
    logger: { log() {}, warn() {}, error() {} },
    requestId: 'test',
  });
}

/* ------------------------------------------------------------------ *
 * Sizing
 * ------------------------------------------------------------------ */

test('linear sizing: 5% of a 10k USDT balance at 50k = 0.01 BTC', () => {
  const { rawAmount, notionalQuote } = computeOrderSize({
    market: linearMarket,
    price: 50_000,
    freeBalance: 10_000,
    fraction: 0.05,
  });
  assert.equal(notionalQuote, 500);
  assert.equal(rawAmount, 0.01);
});

test('linear sizing honours contractSize', () => {
  const market = { ...linearMarket, contractSize: 10 };
  const { rawAmount } = computeOrderSize({
    market,
    price: 50_000,
    freeBalance: 10_000,
    fraction: 0.05,
  });
  assert.equal(rawAmount, 0.001, 'a 10-unit contract needs a tenth of the contracts');
});

test('inverse sizing uses the coin-margined balance, not the quote currency', () => {
  // 1 BTC of margin at 50k, 5% = 2500 USD notional = 2500 contracts of $1.
  const { rawAmount, notionalQuote } = computeOrderSize({
    market: inverseMarket,
    price: 50_000,
    freeBalance: 1,
    fraction: 0.05,
  });
  assert.equal(notionalQuote, 2500);
  assert.equal(rawAmount, 2500);
});

test('margin currency comes from market.settle, not string parsing', () => {
  assert.equal(marginCurrency(linearMarket), 'USDT');
  assert.equal(marginCurrency(inverseMarket), 'BTC');
});

test('notional is symmetric with sizing for both market types', () => {
  const linear = computeOrderSize({ market: linearMarket, price: 50_000, freeBalance: 10_000, fraction: 0.05 });
  assert.equal(notionalOf({ amount: linear.rawAmount, price: 50_000, market: linearMarket }), 500);

  const inverse = computeOrderSize({ market: inverseMarket, price: 50_000, freeBalance: 1, fraction: 0.05 });
  assert.equal(notionalOf({ amount: inverse.rawAmount, price: 50_000, market: inverseMarket }), 2500);
});

test('a NaN fraction is rejected instead of reaching the exchange', () => {
  // The original `if (amount <= 0)` guard let NaN through, since NaN <= 0 is false.
  assert.throws(
    () => computeOrderSize({ market: linearMarket, price: 50_000, freeBalance: 10_000, fraction: NaN }),
    RequestError
  );
});

test('balance reader handles both ccxt shapes', () => {
  assert.equal(readFreeBalance({ USDT: { free: 12 } }, 'USDT'), 12);
  assert.equal(readFreeBalance({ free: { USDT: 34 } }, 'USDT'), 34);
  assert.equal(readFreeBalance({ USDT: { total: 56 } }, 'USDT'), 56);
  assert.equal(readFreeBalance({}, 'USDT'), 0);
});

test('price resolver falls back and rejects junk', () => {
  assert.equal(resolvePrice({ last: 5 }), 5);
  assert.equal(resolvePrice({ last: null, close: 7 }), 7);
  assert.equal(resolvePrice({ last: 0, bid: 0 }), null);
  assert.equal(resolvePrice(undefined), null);
});

/* ------------------------------------------------------------------ *
 * Request validation
 * ------------------------------------------------------------------ */

test('validation rejects malformed input rather than throwing deep in ccxt', () => {
  const exchanges = { fake: fakeExchange() };
  const bad = [
    null,
    'string body',
    { exchange: 'fake', symbol: 'BTC/USDT:USDT' },
    { exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 123 },
    { exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'BUY!' },
    { exchange: 'fake', symbol: 42, side: 'buy' },
    { exchange: 'nope', symbol: 'BTC/USDT:USDT', side: 'buy' },
    { exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy', reduceOnly: 'yes' },
    { exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy', clientOrderId: 'has spaces' },
  ];
  for (const body of bad) {
    assert.throws(() => validateTradeRequest(body, exchanges), RequestError, JSON.stringify(body));
  }
});

test('side is case-insensitive but must be exactly buy or sell', () => {
  const exchanges = { fake: fakeExchange() };
  const ok = validateTradeRequest(
    { exchange: 'FAKE', symbol: 'BTC/USDT:USDT', side: 'SELL' },
    exchanges
  );
  assert.equal(ok.side, 'sell');
  assert.equal(ok.exchangeId, 'fake');
});

test('unlisted symbols are a 400, not an exchange error', async () => {
  const exchanges = { fake: fakeExchange() };
  await assert.rejects(
    run({ exchange: 'fake', symbol: 'DOGE/USDT:USDT', side: 'buy' }, { exchanges }),
    (err) => err instanceof RequestError && err.status === 400
  );
});

/* ------------------------------------------------------------------ *
 * Guards
 * ------------------------------------------------------------------ */

test('dry run computes a full plan without sending an order', async () => {
  let sent = false;
  const exchanges = { fake: fakeExchange({ onCreateOrder: () => { sent = true; } }) };
  const result = await run({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy' }, { exchanges });

  assert.equal(sent, false);
  assert.equal(result.dryRun, true);
  assert.equal(result.plan.amount, 0.01);
  assert.equal(result.plan.notionalQuote, 500);
  assert.equal(result.plan.stopPrice, 49000, '2% stop below a 50k entry');
});

test('position cap blocks an order that would breach it', async () => {
  const config = { ...baseConfig, maxPositionNotional: 400 };
  const exchanges = { fake: fakeExchange() };
  await assert.rejects(
    run({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy' }, { config, exchanges }),
    (err) => err instanceof RequestError && err.status === 409 && /cap/.test(err.message)
  );
});

test('existing exposure counts towards the cap', async () => {
  const config = { ...baseConfig, maxPositionNotional: 600 };
  const exchanges = {
    fake: fakeExchange({
      positions: [{ symbol: 'BTC/USDT:USDT', side: 'long', contracts: 0.01, notional: 500 }],
    }),
  };
  await assert.rejects(
    run({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy' }, { config, exchanges }),
    (err) => err.status === 409
  );
});

test('an opposite open position blocks a naked flip', async () => {
  const exchanges = {
    fake: fakeExchange({
      positions: [{ symbol: 'BTC/USDT:USDT', side: 'short', contracts: 0.02, notional: 1000 }],
    }),
  };
  await assert.rejects(
    run({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy' }, { exchanges }),
    (err) => err.status === 409 && /reduceOnly/.test(err.message)
  );
});

test('reduceOnly closes the whole open position', async () => {
  const exchanges = {
    fake: fakeExchange({
      positions: [{ symbol: 'BTC/USDT:USDT', side: 'short', contracts: 0.02, notional: 1000 }],
    }),
  };
  const result = await run(
    { exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy', reduceOnly: true },
    { exchanges }
  );
  assert.equal(result.plan.amount, 0.02);
  assert.equal(result.plan.reduceOnly, true);
  assert.equal(result.plan.stopPrice, null, 'a closing order carries no stop');
});

test('reduceOnly with nothing open is rejected', async () => {
  const exchanges = { fake: fakeExchange() };
  await assert.rejects(
    run({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'sell', reduceOnly: true }, { exchanges }),
    (err) => err.status === 409
  );
});

test('an order below the market minimum is refused before submission', async () => {
  const exchanges = { fake: fakeExchange({ balance: { USDT: { free: 20 } } }) };
  await assert.rejects(
    run({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy' }, { exchanges }),
    (err) => err instanceof RequestError && err.status === 422
  );
});

test('an empty balance is a clean 409, not a crash', async () => {
  const exchanges = { fake: fakeExchange({ balance: {} }) };
  await assert.rejects(
    run({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy' }, { exchanges }),
    (err) => err.status === 409 && /free USDT/.test(err.message)
  );
});

/* ------------------------------------------------------------------ *
 * Idempotency
 * ------------------------------------------------------------------ */

test('a repeated signal within the TTL is suppressed', async () => {
  let calls = 0;
  const config = { ...baseConfig, dryRun: false };
  const exchanges = {
    fake: fakeExchange({
      onCreateOrder: () => {
        calls += 1;
        return { id: `order-${calls}`, status: 'closed' };
      },
    }),
  };
  const dedupe = new DedupeCache(60_000);
  const body = { exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy' };
  const opts = { config, dedupe, logger: { log() {}, warn() {}, error() {} }, requestId: 't' };

  const first = await executeTrade(validateTradeRequest(body, exchanges), opts);
  const second = await executeTrade(validateTradeRequest(body, exchanges), opts);

  assert.equal(calls, 1, 'the exchange is only hit once');
  assert.equal(first.duplicate, undefined);
  assert.equal(second.duplicate, true);
  assert.equal(second.orderId, 'order-1');
});

test('a failed order is not cached, so it can be retried', async () => {
  let calls = 0;
  const config = { ...baseConfig, dryRun: false };
  const exchanges = {
    fake: fakeExchange({
      onCreateOrder: () => {
        calls += 1;
        if (calls === 1) throw new Error('exchange timeout');
        return { id: 'order-2', status: 'closed' };
      },
    }),
  };
  const dedupe = new DedupeCache(60_000);
  const body = { exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy' };
  const opts = { config, dedupe, logger: { log() {}, warn() {}, error() {} }, requestId: 't' };

  await assert.rejects(executeTrade(validateTradeRequest(body, exchanges), opts));
  const retry = await executeTrade(validateTradeRequest(body, exchanges), opts);
  assert.equal(retry.orderId, 'order-2');
  assert.equal(calls, 2);
});

test('distinct clientOrderIds are not treated as duplicates', () => {
  const cache = new DedupeCache(60_000);
  cache.set('cid:fake:one', { ok: true });
  assert.ok(cache.get('cid:fake:one'));
  assert.equal(cache.get('cid:fake:two'), null);
});

/* ------------------------------------------------------------------ *
 * HTTP layer
 * ------------------------------------------------------------------ */

function listen(config = baseConfig, exchanges = { fake: fakeExchange() }) {
  const app = createApp({
    config,
    getExchanges: () => exchanges,
    isReady: () => true,
    logger: { log() {}, warn() {}, error() {} },
  });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test('the trade endpoint rejects unauthenticated callers', async (t) => {
  const { server, url } = await listen();
  t.after(() => server.close());

  const res = await fetch(`${url}/api/trade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy' }),
  });
  assert.equal(res.status, 401);
});

test('a wrong token is rejected', async (t) => {
  const { server, url } = await listen();
  t.after(() => server.close());

  const res = await fetch(`${url}/api/trade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Auth-Token': 'b'.repeat(64) },
    body: JSON.stringify({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy' }),
  });
  assert.equal(res.status, 401);
});

test('a valid token gets through and returns a plan', async (t) => {
  const { server, url } = await listen();
  t.after(() => server.close());

  const res = await fetch(`${url}/api/trade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Auth-Token': AUTH_TOKEN },
    body: JSON.stringify({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.plan.amount, 0.01);
});

test('CORS does not hand out a wildcard origin', async (t) => {
  const { server, url } = await listen();
  t.after(() => server.close());

  const evil = await fetch(`${url}/health`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);

  const good = await fetch(`${url}/health`, {
    headers: { Origin: 'https://patterndesk.netlify.app' },
  });
  assert.equal(
    good.headers.get('access-control-allow-origin'),
    'https://patterndesk.netlify.app'
  );
});

test('internal failures do not leak exchange internals to the caller', async (t) => {
  const exchanges = {
    fake: fakeExchange({
      onCreateOrder: () => {
        throw new Error('SECRET internal exchange detail');
      },
    }),
  };
  const { server, url } = await listen({ ...baseConfig, dryRun: false }, exchanges);
  t.after(() => server.close());

  const res = await fetch(`${url}/api/trade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Auth-Token': AUTH_TOKEN },
    body: JSON.stringify({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy' }),
  });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.doesNotMatch(body.error, /SECRET/);
  assert.ok(body.requestId);
});

test('the rate limiter returns 429 past the window', async (t) => {
  const { server, url } = await listen({ ...baseConfig, rateLimitPerMinute: 3 });
  t.after(() => server.close());

  const send = () =>
    fetch(`${url}/api/trade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': AUTH_TOKEN },
      body: JSON.stringify({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy' }),
    });

  const codes = [];
  for (let i = 0; i < 5; i += 1) codes.push((await send()).status);
  assert.equal(codes.at(-1), 429);
});

test('a forged X-Forwarded-For cannot buy extra rate-limit budget', async (t) => {
  // With nothing in front of the process, X-Forwarded-For is written by
  // whoever is calling. Believing it would hand an attacker a fresh bucket
  // per request, and with it unlimited guesses at the auth token.
  const { server, url } = await listen({ ...baseConfig, rateLimitPerMinute: 3, trustProxy: 0 });
  t.after(() => server.close());

  const send = (ip) =>
    fetch(`${url}/api/trade`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Token': AUTH_TOKEN,
        'X-Forwarded-For': ip,
      },
      body: JSON.stringify({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy' }),
    });

  const codes = [];
  for (let i = 0; i < 5; i += 1) codes.push((await send(`10.0.0.${i}`)).status);
  assert.equal(codes.at(-1), 429, 'a new spoofed IP per request must not reset the window');
});

test('behind a real proxy, X-Forwarded-For is what the limiter counts', async (t) => {
  // The other half of the trade-off: with trustProxy on, every browser
  // arriving through Caddy must not share one 127.0.0.1 bucket.
  const { server, url } = await listen({ ...baseConfig, rateLimitPerMinute: 3, trustProxy: 1 });
  t.after(() => server.close());

  const send = (ip) =>
    fetch(`${url}/api/trade`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Token': AUTH_TOKEN,
        'X-Forwarded-For': ip,
      },
      body: JSON.stringify({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy' }),
    });

  for (let i = 0; i < 4; i += 1) await send('203.0.113.9');
  assert.equal((await send('203.0.113.9')).status, 429, 'the noisy client is limited');
  assert.notEqual((await send('203.0.113.10')).status, 429, 'a different client is not');
});

test('an oversized body is refused', async (t) => {
  const { server, url } = await listen();
  t.after(() => server.close());

  const res = await fetch(`${url}/api/trade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Auth-Token': AUTH_TOKEN },
    body: JSON.stringify({ exchange: 'fake', pad: 'x'.repeat(40_000) }),
  });
  assert.ok(res.status >= 400);
});

test('health reports mode without requiring auth', async (t) => {
  const { server, url } = await listen();
  t.after(() => server.close());

  const body = await (await fetch(`${url}/health`)).json();
  assert.equal(body.ok, true);
  assert.equal(body.dryRun, true);
  assert.deepEqual(body.exchanges, ['fake']);
});

/* ------------------------------------------------------------------ *
 * Exchange construction
 *
 * These run offline with dummy credentials — no request is made. They exist
 * because a wiring bug here (a value passed in but never destructured) only
 * surfaces at startup on a real machine, which is a slow way to find it.
 * ------------------------------------------------------------------ */

const { buildExchange, syncClock } = require('../exchanges');

test('buildExchange wires every option it is handed', () => {
  const ex = buildExchange(
    'bybit',
    { apiKey: 'k', secret: 's' },
    { useTestnet: false, orderTimeoutMs: 12_345, recvWindowMs: 9_876 }
  );
  assert.equal(ex.options.recvWindow, 9_876, 'recvWindow must reach the client');
  assert.equal(ex.timeout, 12_345);
  assert.equal(ex.options.defaultType, 'swap');
  assert.equal(ex.options.adjustForTimeDifference, true);
  assert.equal(ex.options.timeDifference, 0);
  assert.equal(ex.enableRateLimit, true);
});

test('buildExchange rejects an unknown exchange id', () => {
  assert.throws(
    () => buildExchange('nosuchexchange', { apiKey: 'k', secret: 's' }, { recvWindowMs: 5000 }),
    /no exchange named/
  );
});

test('testnet is verified, not assumed', () => {
  const ex = buildExchange(
    'bybit',
    { apiKey: 'k', secret: 's' },
    { useTestnet: true, orderTimeoutMs: 1000, recvWindowMs: 5000 }
  );
  assert.match(JSON.stringify(ex.urls.api), /testnet/, 'bybit endpoints must switch');

  // Weex has no working sandbox in ccxt; startup must refuse rather than
  // trade live funds under a testnet flag.
  assert.throws(
    () => buildExchange(
      'weex',
      { apiKey: 'k', secret: 's' },
      { useTestnet: true, orderTimeoutMs: 1000, recvWindowMs: 5000 }
    ),
    /cannot be put into sandbox mode/
  );
});

test('clock offset is measured and applied to the signed nonce', async () => {
  const ex = buildExchange(
    'bybit',
    { apiKey: 'k', secret: 's' },
    { useTestnet: true, orderTimeoutMs: 1000, recvWindowMs: 10_000 }
  );
  // Simulate the 6s skew that produced retCode 10002.
  ex.fetchTime = async () => Date.now() + 6035;

  const warnings = [];
  const before = ex.nonce();
  const offset = await syncClock(ex, { warn: (m) => warnings.push(m), log() {} });
  const after = ex.nonce();

  assert.ok(Math.abs(offset + 6035) < 50, 'offset should be about -6035ms');
  assert.ok(after - before > 5900, 'nonce must shift forward to match the exchange');
  assert.equal(warnings.length, 1, 'a multi-second skew is warned about');
  assert.match(warnings[0], /clock/i);
});

test('a small clock offset is corrected without warning', async () => {
  const ex = buildExchange(
    'bybit',
    { apiKey: 'k', secret: 's' },
    { useTestnet: true, orderTimeoutMs: 1000, recvWindowMs: 10_000 }
  );
  ex.fetchTime = async () => Date.now() + 300;
  const warnings = [];
  await syncClock(ex, { warn: (m) => warnings.push(m), log() {} });
  assert.equal(warnings.length, 0);
});

test('a failed clock probe degrades to a warning, not a crash', async () => {
  const ex = buildExchange(
    'bybit',
    { apiKey: 'k', secret: 's' },
    { useTestnet: true, orderTimeoutMs: 1000, recvWindowMs: 10_000 }
  );
  ex.fetchTime = async () => { throw new Error('network down'); };
  const warnings = [];
  const offset = await syncClock(ex, { warn: (m) => warnings.push(m), log() {} });
  assert.equal(offset, null);
  assert.equal(warnings.length, 1);
});

test('a passphrase is passed through when the exchange needs one', () => {
  const weex = buildExchange(
    'weex',
    { apiKey: 'k', secret: 's', password: 'p' },
    { useTestnet: false, orderTimeoutMs: 1000, recvWindowMs: 10_000 }
  );
  assert.equal(weex.password, 'p', 'weex signs with a third credential');

  // Exchanges that do not use one must not receive an empty string.
  const bybit = buildExchange(
    'bybit',
    { apiKey: 'k', secret: 's' },
    { useTestnet: false, orderTimeoutMs: 1000, recvWindowMs: 10_000 }
  );
  assert.equal(bybit.password, undefined);
});

test('TP and SL reach Bybit as native order fields', () => {
  // Locks the wire format. ccxt's unified stopLoss/takeProfit params must
  // translate into Bybit V5's own fields — if a ccxt upgrade changes this
  // shape, orders would silently go out unprotected.
  const ccxt = require('ccxt');
  const ex = new ccxt.bybit({ apiKey: 'k', secret: 's', options: { defaultType: 'swap' } });
  const market = {
    id: 'BTCUSDT', symbol: 'BTC/USDT:USDT', base: 'BTC', quote: 'USDT', settle: 'USDT',
    linear: true, inverse: false, contract: true, swap: true, spot: false, type: 'swap',
    contractSize: 1, active: true, taker: 0.00055,
    precision: { amount: 0.001, price: 0.1 },
    limits: { amount: { min: 0.001 }, cost: { min: 5 } }, info: {},
  };
  ex.markets = { 'BTC/USDT:USDT': market };
  ex.markets_by_id = { BTCUSDT: [market] };

  const req = ex.createOrderRequest('BTC/USDT:USDT', 'market', 'buy', 0.01, undefined, {
    clientOrderId: 'pd-test-1',
    stopLoss: { triggerPrice: 76000, type: 'market' },
    takeProfit: { triggerPrice: 82000, type: 'market' },
  });

  assert.equal(req.stopLoss, '76000', 'stop must reach bybit as a native field');
  assert.equal(req.takeProfit, '82000', 'target must reach bybit as a native field');
  assert.equal(req.orderLinkId, 'pd-test-1', 'clientOrderId is what makes retries idempotent');
  assert.equal(req.orderType, 'Market');
  assert.equal(req.category, 'linear');
});

test('protective levels on the wrong side of the entry are discarded', () => {
  const { resolveProtectiveLevels } = require('../trading');

  // A stop above a long entry would fill the instant it is placed.
  const bad = resolveProtectiveLevels({
    side: 'buy', price: 100,
    requested: { stopPrice: 110, targetPrice: 90 },
    stopLossPercent: 2, takeProfitPercent: 4,
  });
  assert.equal(bad.problems.length, 2);
  assert.equal(bad.stop, 98, 'falls back to the percentage stop');
  assert.equal(bad.target, 104, 'falls back to the percentage target');

  // Valid pattern levels win over the percentages.
  const good = resolveProtectiveLevels({
    side: 'buy', price: 100,
    requested: { stopPrice: 95, targetPrice: 115 },
    stopLossPercent: 2, takeProfitPercent: 4,
  });
  assert.deepEqual([good.stop, good.target, good.problems.length], [95, 115, 0]);

  // Shorts invert.
  const short = resolveProtectiveLevels({
    side: 'sell', price: 100,
    requested: { stopPrice: 105, targetPrice: 85 },
    stopLossPercent: 2, takeProfitPercent: 4,
  });
  assert.deepEqual([short.stop, short.target, short.problems.length], [105, 85, 0]);
});

/* ------------------------------------------------------------------ *
 * Leverage
 * ------------------------------------------------------------------ */

const { assertStopInsideLiquidation } = require('../trading');

test('a stop beyond the liquidation distance is refused', () => {
  // At 10x, roughly a 10% adverse move liquidates. A 12% stop never triggers —
  // the position is gone first, and the real loss is the whole margin.
  assert.throws(
    () => assertStopInsideLiquidation({ price: 100, stop: 88, leverage: 10, safetyFactor: 0.7 }),
    (err) => err.status === 422 && /liquidated before the stop/.test(err.message)
  );
});

test('the refusal suggests a leverage that would actually work', () => {
  try {
    assertStopInsideLiquidation({ price: 100, stop: 90, leverage: 20, safetyFactor: 0.7 });
    assert.fail('should have thrown');
  } catch (err) {
    // 10% stop, 0.7 buffer -> 7x or lower
    assert.match(err.message, /Lower LEVERAGE to about 7x/);
  }
});

test('a stop comfortably inside the liquidation distance passes', () => {
  const r = assertStopInsideLiquidation({ price: 100, stop: 98, leverage: 10, safetyFactor: 0.7 });
  assert.equal(r.stopDistancePct, 2);
  assert.equal(r.liquidationPct, 10);
});

test('the liquidation check is inert at 1x and when unset', () => {
  assert.equal(assertStopInsideLiquidation({ price: 100, stop: 50, leverage: 1, safetyFactor: 0.7 }), null);
  assert.equal(assertStopInsideLiquidation({ price: 100, stop: 50, leverage: null, safetyFactor: 0.7 }), null);
  assert.equal(assertStopInsideLiquidation({ price: 100, stop: null, leverage: 10, safetyFactor: 0.7 }), null);
});

test('shorts are measured the same way', () => {
  assert.throws(
    () => assertStopInsideLiquidation({ price: 100, stop: 112, leverage: 10, safetyFactor: 0.7 }),
    /liquidated before the stop/
  );
  assert.ok(assertStopInsideLiquidation({ price: 100, stop: 102, leverage: 10, safetyFactor: 0.7 }));
});

test('a trade is refused when leverage cannot be applied', async () => {
  const exchanges = {
    fake: fakeExchange({
      onCreateOrder: () => { throw new Error('must not be reached'); },
    }),
  };
  exchanges.fake.setLeverage = async () => { throw new Error('leverage rejected by exchange'); };
  exchanges.fake.has.setMarginMode = false;

  const config = { ...baseConfig, dryRun: false, requireLeverageApplied: true, liquidationSafetyFactor: 0.7 };
  await assert.rejects(
    run({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy' }, { config, exchanges }),
    (err) => err.status === 409 && /leverage could not be set/.test(err.message)
  );
});

test('the plan reports margin used, not just notional', async () => {
  const exchanges = { fake: fakeExchange() };
  const config = { ...baseConfig, leverage: 5, liquidationSafetyFactor: 0.7 };
  const result = await run({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy' }, { config, exchanges });

  assert.equal(result.plan.notionalQuote, 500);
  assert.equal(result.plan.marginUsed, 100, '500 notional at 5x posts 100 of margin');
  assert.equal(result.plan.leverage, 5);
});

test('Render is detected and the bind host defaults accordingly', () => {
  // Loopback on Render fails health checks and the service is unreachable.
  // Detection avoids a manual step that is silent when forgotten.
  const { execFileSync } = require('node:child_process');
  const probe = "console.log(require('./config').loadConfig().bindHost)";
  const base = {
    PATH: process.env.PATH,
    AUTH_TOKEN: 'a'.repeat(64),
    USE_TESTNET: 'true',
    BYBIT_API_KEY: 'k',
    BYBIT_API_SECRET: 's',
  };
  const run = (extra) =>
    execFileSync(process.execPath, ['-e', probe], {
      cwd: __dirname + '/..',
      env: { ...base, ...extra },
      encoding: 'utf8',
    }).trim().split('\n').pop();

  assert.equal(run({}), '127.0.0.1', 'loopback everywhere else');
  assert.equal(run({ RENDER: 'true' }), '0.0.0.0', 'all interfaces on Render');
  assert.equal(run({ RENDER_SERVICE_ID: 'srv-abc' }), '0.0.0.0', 'service id also identifies Render');
  assert.equal(run({ RENDER: 'true', BIND_HOST: '127.0.0.1' }), '127.0.0.1', 'an explicit value always wins');
});

test('TRUST_PROXY defaults to off except where a proxy is known to exist', () => {
  // On a VM the process is often the only listener, so X-Forwarded-For is
  // attacker-controlled. Defaulting it on there is what makes the rate limiter
  // decorative. Render always terminates at a proxy, so 1 is correct there.
  const { execFileSync } = require('node:child_process');
  const probe = "console.log(require('./config').loadConfig().trustProxy)";
  const base = {
    PATH: process.env.PATH,
    AUTH_TOKEN: 'a'.repeat(64),
    USE_TESTNET: 'true',
    BYBIT_API_KEY: 'k',
    BYBIT_API_SECRET: 's',
  };
  const run = (extra) =>
    execFileSync(process.execPath, ['-e', probe], {
      cwd: __dirname + '/..',
      env: { ...base, ...extra },
      encoding: 'utf8',
    }).trim().split('\n').pop();

  assert.equal(run({}), '0', 'nothing in front by default');
  assert.equal(run({ RENDER: 'true' }), '1', 'Render terminates at a proxy');
  assert.equal(run({ TRUST_PROXY: '1' }), '1', 'set it explicitly behind Caddy or nginx');
  assert.equal(run({ RENDER: 'true', TRUST_PROXY: '0' }), '0', 'an explicit value always wins');
});

/* ------------------------------------------------------------------ *
 * Cross margin
 *
 * Under cross the free balance backs the book, so leverage is not what sets
 * the distance to liquidation — equity against exposure is. Applying the
 * isolated formula here refused ordinary pattern stops on a high-leverage
 * account that were never actually at risk.
 * ------------------------------------------------------------------ */

const CROSS = {
  price: 100,
  leverage: 25,
  safetyFactor: 0.7,
  marginMode: 'cross',
  maintenanceMarginRate: 0.01,
};

test('under cross, a small position on a healthy balance tolerates a wide stop', () => {
  // 100 of exposure behind 1000 of free margin. At 25x the isolated formula
  // would allow only 2.8%; the real distance here is an order of magnitude more.
  const r = assertStopInsideLiquidation({
    ...CROSS, stop: 90, equity: 1000, notionalQuote: 100,
  });
  assert.equal(r.marginMode, 'cross');
  assert.ok(r.liquidationPct > 90, `expected a distant liquidation, got ${r.liquidationPct}`);
});

test('the same stop and leverage is refused under isolated', () => {
  // The contrast that motivates the whole change: identical inputs, and only
  // the margin mode decides whether this is a sane trade.
  assert.throws(
    () => assertStopInsideLiquidation({
      ...CROSS, marginMode: 'isolated', stop: 90, equity: 1000, notionalQuote: 100,
    }),
    /liquidated before the stop/
  );
});

test('cross still refuses when the exposure is large against the balance', () => {
  // 1000 of exposure behind 50 of free margin: liquidation is ~4% away, so a
  // 10% stop really would never trigger.
  assert.throws(
    () => assertStopInsideLiquidation({
      ...CROSS, stop: 90, equity: 50, notionalQuote: 1000,
    }),
    /liquidated before the stop/
  );
});

test('the cross refusal names the setting that would actually help', () => {
  // Telling someone to lower LEVERAGE under cross sends them to change a
  // number that cannot move the outcome.
  assert.throws(
    () => assertStopInsideLiquidation({ ...CROSS, stop: 90, equity: 50, notionalQuote: 1000 }),
    (err) => {
      assert.match(err.message, /TRADE_BALANCE_PERCENTAGE/);
      assert.doesNotMatch(err.message, /Lower LEVERAGE/);
      assert.match(err.message, /cross exposure/);
      return true;
    }
  );
});

test('an existing position counts against the same balance', () => {
  // Cross shares one pot. A second position must be measured against the
  // exposure already open, not on its own.
  // 100 of equity behind 100 of exposure: liquidation is ~99% away.
  const alone = assertStopInsideLiquidation({
    ...CROSS, stop: 97, equity: 100, notionalQuote: 100,
  });
  assert.ok(alone.liquidationPct > 90, 'the first 100 of exposure is fine on its own');

  // The same order with 2900 already open shares the same 100 of margin, so
  // the book is 3000 against 100 and liquidation is ~2.3% away — closer than
  // the 3% stop.
  assert.throws(
    () => assertStopInsideLiquidation({
      ...CROSS, stop: 97, equity: 100, notionalQuote: 100, existingNotional: 2900,
    }),
    /liquidated before the stop/,
    'but not once 2900 is already open against the same margin'
  );
});

test('maintenance margin is subtracted, not ignored', () => {
  // Exactly enough equity to cover the notional, but the exchange holds back
  // maintenance margin, so the usable distance is short of 100%.
  const r = assertStopInsideLiquidation({
    ...CROSS, stop: 99.5, equity: 100, notionalQuote: 100, maintenanceMarginRate: 0.05,
  });
  assert.ok(r.liquidationPct < 96, `maintenance margin must reduce the distance, got ${r.liquidationPct}`);
});

test('cross refuses outright when equity cannot cover maintenance margin', () => {
  assert.throws(
    () => assertStopInsideLiquidation({
      ...CROSS, stop: 99.9, equity: 1, notionalQuote: 1000, maintenanceMarginRate: 0.01,
    }),
    /does not cover the maintenance margin/
  );
});

test('cross falls back to the isolated formula when the balance is unknown', () => {
  // A missing or zero balance must not be read as "infinite room". Without
  // usable equity the only honest model left is the leverage one.
  assert.throws(
    () => assertStopInsideLiquidation({ ...CROSS, stop: 90, equity: null, notionalQuote: 100 }),
    /at 25x isolated/
  );
  assert.throws(
    () => assertStopInsideLiquidation({ ...CROSS, stop: 90, equity: 0, notionalQuote: 100 }),
    /at 25x isolated/
  );
});

test('a long cannot be further than 100% from liquidation', () => {
  const r = assertStopInsideLiquidation({
    ...CROSS, stop: 99, equity: 1_000_000, notionalQuote: 10,
  });
  assert.equal(r.liquidationPct, 100, 'price cannot fall past zero');
});

test('shorts are measured the same way under cross', () => {
  const long = assertStopInsideLiquidation({ ...CROSS, stop: 90, equity: 1000, notionalQuote: 100 });
  const short = assertStopInsideLiquidation({ ...CROSS, stop: 110, equity: 1000, notionalQuote: 100 });
  assert.equal(long.stopDistancePct, short.stopDistancePct);
});

test('a dry run still applies the liquidation guard', async () => {
  // The guard is pure arithmetic and sends nothing, so a simulation that
  // skipped it would report a plan for a trade the armed path would refuse —
  // and the refusal would land with real money on the line instead.
  const exchanges = {
    fake: fakeExchange({ balance: { USDT: { free: 100 } }, price: 100 }),
  };
  let sent = false;
  exchanges.fake.createOrder = async () => { sent = true; return {}; };

  const config = {
    ...baseConfig,
    dryRun: true,
    marginMode: 'cross',
    leverage: 25,
    liquidationSafetyFactor: 0.7,
    maintenanceMarginRate: 0.01,
    tradeFraction: 5,          // 500 of exposure against 100 free — far too much
    tradePercentage: 500,
    maxPositionNotional: null,
    stopLossPercent: 20,       // and a stop well past liquidation
  };

  await assert.rejects(
    run({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy' }, { config, exchanges }),
    (err) => err instanceof RequestError && /liquidated before the stop/.test(err.message),
    'the plan must report the refusal rather than a clean dry run'
  );
  assert.equal(sent, false, 'and a dry run still sends nothing');
});

test('a dry run that passes the guard reports a plan as before', async () => {
  const exchanges = { fake: fakeExchange({ balance: { USDT: { free: 10_000 } }, price: 100 }) };
  const config = {
    ...baseConfig, dryRun: true, marginMode: 'cross', leverage: 25,
    liquidationSafetyFactor: 0.7, maintenanceMarginRate: 0.01,
  };
  const result = await run({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy' }, { config, exchanges });
  assert.equal(result.dryRun, true);
  assert.equal(result.plan.marginMode, 'cross');
});

test('/health reports the scanner off when it is off', async (t) => {
  // startScanner returns a truthy no-op handle when disabled, so deciding
  // this from the handle reported every server as scanning. /health is the
  // monitoring surface: a bot that is not running must not look alive.
  const app = createApp({
    config: { ...baseConfig, scanner: { enabled: false, execute: false } },
    getExchanges: () => ({ fake: fakeExchange() }),
    isReady: () => true,
    logger: { log() {}, warn() {}, error() {} },
  });
  // Exactly what server.js stores when SCANNER_ENABLED=false: the no-op handle
  // startScanner hands back. Truthy, which is what made the old check wrong.
  app.locals.scanner = { stop() {} };

  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => server.close());

  const body = await (await fetch(`http://127.0.0.1:${server.address().port}/health`)).json();
  assert.equal(body.scanner.enabled, false);
  assert.equal(body.scanner.lastScanAt, undefined, 'no scan fields when nothing is scanning');
});

test('/health reports the scanner on, and how stale its last pass is', async (t) => {
  const app = createApp({
    config: { ...baseConfig, scanner: { enabled: true, execute: true } },
    getExchanges: () => ({ fake: fakeExchange() }),
    isReady: () => true,
    // The breaker is owned by the process now, not by the scanner, because it
    // has to gate hand-sent orders too.
    breaker: { blocked: true, reason: 'down 30%', day: '2026-09-04', baseline: 1000, consecutiveLosses: 2 },
    logger: { log() {}, warn() {}, error() {} },
  });
  app.locals.scanner = { lastTickAt: Date.now() - 90_000 };
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => server.close());

  const body = await (await fetch(`http://127.0.0.1:${server.address().port}/health`)).json();
  assert.equal(body.scanner.enabled, true);
  assert.equal(body.scanner.executing, true);
  assert.ok(body.scanner.secondsSinceScan >= 89, 'staleness is what a monitor alerts on');
  assert.equal(body.scanner.breakerTripped, true);
  assert.equal(body.scanner.breakerReason, 'down 30%');
});

test('/health reports the settings that shape an order', async (t) => {
  // These live in a dashboard, not in the repo. A value that quietly fell back
  // to its default looks identical to one chosen on purpose, right up until a
  // trade is refused for a reason that makes no sense.
  const app = createApp({
    config: { ...baseConfig, marginMode: 'cross', leverage: 25, maxPositionNotional: 100 },
    getExchanges: () => ({ fake: fakeExchange() }),
    isReady: () => true,
    logger: { log() {}, warn() {}, error() {} },
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => server.close());

  const body = await (await fetch(`http://127.0.0.1:${server.address().port}/health`)).json();
  assert.equal(body.marginMode, 'cross');
  assert.equal(body.leverage, 25);
  assert.equal(body.maxPositionNotional, 100);
});

test('/health does not leak the token or the exchange keys', async (t) => {
  // It is unauthenticated by design, so anything added to it is public.
  const { server, url } = await listen();
  t.after(() => server.close());
  const raw = await (await fetch(`${url}/health`)).text();
  assert.doesNotMatch(raw, /authToken|credentials|apiKey|secret/i);
  assert.ok(!raw.includes(AUTH_TOKEN));
});

/* ------------------------------------------------------------------ *
 * The breaker gates EVERY route into an order
 *
 * It used to be created inside startScanner and consulted only in the scan
 * loop, so with SCANNER_ENABLED=false the daily loss limit did nothing at all
 * for trades sent by hand — which is the only way this app trades today.
 * ------------------------------------------------------------------ */

function stubBreaker({ blocked = false, reason = null } = {}) {
  return {
    blocked, reason, day: '2026-09-04', baseline: 1000, consecutiveLosses: 0,
    seen: [],
    needsBaseline() { return false; },
    adoptBaseline() {},
    update(equity) { this.seen.push(equity); },
  };
}

test('a tripped breaker refuses a hand-sent order', async () => {
  let sent = false;
  const exchanges = { fake: fakeExchange({ onCreateOrder: () => { sent = true; return {}; } }) };
  const breaker = stubBreaker({ blocked: true, reason: 'down 30% today (limit 30%)' });

  await assert.rejects(
    executeTrade(
      validateTradeRequest({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy' }, exchanges),
      { config: { ...baseConfig, dryRun: false }, dedupe: new DedupeCache(0), breaker,
        logger: { log() {}, warn() {}, error() {} }, requestId: 't' }
    ),
    (err) => err instanceof RequestError && err.status === 409 && /circuit breaker/.test(err.message)
  );
  assert.equal(sent, false, 'nothing reaches the exchange');
});

test('a tripped breaker still lets you CLOSE a position', async () => {
  // A halt that traps you in a losing position is worse than no halt at all.
  let sent = false;
  const exchanges = {
    fake: fakeExchange({
      positions: [{ symbol: 'BTC/USDT:USDT', side: 'long', contracts: 0.01, notional: 500 }],
      onCreateOrder: () => { sent = true; return { id: 'x', status: 'closed', filled: 0.01 }; },
    }),
  };
  const breaker = stubBreaker({ blocked: true, reason: 'down 30% today' });

  const result = await executeTrade(
    validateTradeRequest(
      { exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'sell', reduceOnly: true }, exchanges
    ),
    { config: { ...baseConfig, dryRun: false }, dedupe: new DedupeCache(0), breaker,
      logger: { log() {}, warn() {}, error() {} }, requestId: 't' }
  );
  assert.equal(result.success, true);
  assert.equal(sent, true, 'reduceOnly is exempt from the halt');
});

test('an untripped breaker observes equity and lets the order through', async () => {
  const exchanges = { fake: fakeExchange({ balance: { USDT: { free: 10_000, total: 12_000 } } }) };
  const breaker = stubBreaker();

  const result = await executeTrade(
    validateTradeRequest({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy' }, exchanges),
    { config: baseConfig, dedupe: new DedupeCache(0), breaker,
      logger: { log() {}, warn() {}, error() {} }, requestId: 't' }
  );
  assert.equal(result.success, true);
  assert.deepEqual(breaker.seen, [12_000], 'total equity is what the daily limit measures');
});

test('with no breaker wired in, trading still works', async () => {
  // Every existing caller passes none; they must not start throwing.
  const exchanges = { fake: fakeExchange() };
  const result = await run({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy' }, { exchanges });
  assert.equal(result.success, true);
});

test('/health surfaces a trip even when the scanner is off', async (t) => {
  const app = createApp({
    config: { ...baseConfig, scanner: { enabled: false, execute: false } },
    getExchanges: () => ({ fake: fakeExchange() }),
    isReady: () => true,
    breaker: stubBreaker({ blocked: true, reason: 'down 30% today' }),
    logger: { log() {}, warn() {}, error() {} },
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => server.close());

  const body = await (await fetch(`http://127.0.0.1:${server.address().port}/health`)).json();
  assert.equal(body.scanner.enabled, false);
  assert.equal(body.breaker.tripped, true, 'a halt must be visible with the scanner off');
  assert.match(body.breaker.reason, /down 30%/);
});

/* ------------------------------------------------------------------ *
 * Orders too small for the market
 *
 * ccxt THROWS InvalidOrder from amountToPrecision when the size is under the
 * lot step — it does not round to zero. So the "rounded to zero" guard never
 * ran, and the most ordinary failure there is reached the browser as an
 * opaque 500 with the reason only in a stack trace.
 * ------------------------------------------------------------------ */

const solMarket = {
  symbol: 'SOL/USDT:USDT', base: 'SOL', quote: 'USDT', settle: 'USDT',
  linear: true, inverse: false, contractSize: 1, active: true,
  precision: { amount: 0.1 },
  limits: { amount: { min: 0.1 }, cost: { min: 5 } },
};

function solExchange(freeBalance) {
  const ex = fakeExchange({ market: solMarket, balance: { USDT: { free: freeBalance } }, price: 101.86 });
  ex.amountToPrecision = (symbol, amt) => {
    if (Number(amt) < 0.1) {
      throw Object.assign(new Error(`bybit amount of ${symbol} must be greater than minimum amount precision of 0.1`), { name: 'InvalidOrder' });
    }
    return (Math.floor(Number(amt) * 10) / 10).toFixed(1);
  };
  return ex;
}

test('an order under the lot step is a 422 that explains itself, not a 500', async () => {
  const exchanges = { fake: solExchange(6) };
  await assert.rejects(
    run({ exchange: 'fake', symbol: 'SOL/USDT:USDT', side: 'buy' },
      { config: { ...baseConfig, tradeFraction: 0.05, tradePercentage: 5 }, exchanges }),
    (err) => {
      assert.ok(err instanceof RequestError, 'must be a RequestError, or the message is redacted');
      assert.equal(err.status, 422);
      assert.equal(err.expose, true, 'the caller has to be able to read this');
      return true;
    }
  );
});

test('the refusal names the percentage that would actually work', async () => {
  // $6 balance, SOL at 101.86, lot step 0.1 -> smallest order is 10.19,
  // which is ~170% of the balance as notional.
  const exchanges = { fake: solExchange(6) };
  await assert.rejects(
    run({ exchange: 'fake', symbol: 'SOL/USDT:USDT', side: 'buy' },
      { config: { ...baseConfig, tradeFraction: 0.05, tradePercentage: 5 }, exchanges }),
    (err) => {
      assert.match(err.message, /0\.30 of notional/, 'says what it tried to send');
      assert.match(err.message, /10\.19/, 'and the smallest order the market accepts');
      assert.match(err.message, /roughly 170/, 'and the percentage that would clear it');
      return true;
    }
  );
});

test('a size the market does accept still goes through', async () => {
  // Same market, 170% of $6 -> ~$10.2 -> 0.1 SOL, exactly the lot step.
  const exchanges = { fake: solExchange(6) };
  const result = await run({ exchange: 'fake', symbol: 'SOL/USDT:USDT', side: 'buy' },
    { config: { ...baseConfig, tradeFraction: 1.7, tradePercentage: 170, dryRun: true }, exchanges });
  assert.equal(result.success, true);
  assert.equal(result.plan.amount, 0.1);
});

test('the suggested percentage clears the minimum ORDER VALUE, not just the lot step', async () => {
  // UNI at 6.15 with a 0.1 lot step: the step is worth only 0.61, but Bybit
  // will not accept an order under 5 at all. Advising the percentage that
  // clears the step alone just moves the refusal to the next guard.
  const uni = {
    symbol: 'UNI/USDT:USDT', base: 'UNI', quote: 'USDT', settle: 'USDT',
    linear: true, inverse: false, contractSize: 1, active: true,
    precision: { amount: 0.1 },
    limits: { amount: { min: 0.1 }, cost: { min: 5 } },
  };
  const ex = fakeExchange({ market: uni, balance: { USDT: { free: 8 } }, price: 6.15 });
  ex.amountToPrecision = (symbol, amt) => {
    if (Number(amt) < 0.1) throw new Error(`bybit amount of ${symbol} must be greater than minimum amount precision of 0.1`);
    return (Math.floor(Number(amt) * 10) / 10).toFixed(1);
  };

  await assert.rejects(
    run({ exchange: 'fake', symbol: 'UNI/USDT:USDT', side: 'buy' },
      { config: { ...baseConfig, tradeFraction: 0.05, tradePercentage: 5 }, exchanges: { fake: ex } }),
    (err) => {
      // 5 / 8 = 62.5% -> 63, not the 8% the lot step alone would suggest.
      assert.match(err.message, /roughly 63/, `wrong suggestion: ${err.message}`);
      assert.match(err.message, /will not accept an order under 5/);
      assert.doesNotMatch(err.message, /roughly 8\b/);
      return true;
    }
  );
});

test('when the lot step is the binding floor, it is the one reported', async () => {
  // SOL at 101.86: the 0.1 step is worth 10.19, well over any 5 minimum.
  const exchanges = { fake: solExchange(6) };
  await assert.rejects(
    run({ exchange: 'fake', symbol: 'SOL/USDT:USDT', side: 'buy' },
      { config: { ...baseConfig, tradeFraction: 0.05, tradePercentage: 5 }, exchanges }),
    (err) => {
      assert.match(err.message, /lot step is worth about 10\.19/);
      assert.match(err.message, /roughly 170/);
      return true;
    }
  );
});

/* ------------------------------------------------------------------ *
 * MIN_NOTIONAL_BUMP — one percentage across a whole watchlist
 * ------------------------------------------------------------------ */

test('an undersized order is raised to the market minimum, not refused', async () => {
  // 5% of $8 is $0.40 on UNI — under the $5 floor. Bumped, it becomes the
  // smallest order the market takes, so 5% works here AND on SOL AND on BNB
  // without retuning anything per symbol.
  const uni = {
    symbol: 'UNI/USDT:USDT', base: 'UNI', quote: 'USDT', settle: 'USDT',
    linear: true, inverse: false, contractSize: 1, active: true,
    precision: { amount: 0.1 }, limits: { amount: { min: 0.1 }, cost: { min: 5 } },
  };
  const ex = fakeExchange({ market: uni, balance: { USDT: { free: 8 } }, price: 6.15 });
  ex.amountToPrecision = (s, a) => (Math.round(Number(a) * 10) / 10).toFixed(1);

  const result = await run({ exchange: 'fake', symbol: 'UNI/USDT:USDT', side: 'buy' }, {
    config: { ...baseConfig, tradeFraction: 0.05, tradePercentage: 5, minNotionalBump: true },
    exchanges: { fake: ex },
  });
  assert.equal(result.success, true);
  assert.ok(result.plan.amount >= 0.9, `expected ~0.9 UNI, got ${result.plan.amount}`);
  assert.ok(result.plan.notionalQuote >= 5, 'clears the minimum order value');
});

test('the bump rounds UP to a whole lot step, never down under the floor', async () => {
  const m = {
    symbol: 'X/USDT:USDT', base: 'X', quote: 'USDT', settle: 'USDT',
    linear: true, inverse: false, contractSize: 1, active: true,
    precision: { amount: 0.1 }, limits: { amount: { min: 0.1 }, cost: { min: 5 } },
  };
  // $5 / $6.15 = 0.813 -> must round to 0.9, not 0.8 (which is $4.92, still under).
  assert.equal(Number(minimumTradeableAmount({ market: m, price: 6.15 }).toFixed(4)), 0.9);
  // An exact multiple must not be pushed to the next step.
  assert.equal(Number(minimumTradeableAmount({ market: m, price: 5 }).toFixed(4)), 1);
});

test('the bump is off by default, so sizing does not change under anyone', async () => {
  const exchanges = { fake: solExchange(6) };
  await assert.rejects(
    run({ exchange: 'fake', symbol: 'SOL/USDT:USDT', side: 'buy' },
      { config: { ...baseConfig, tradeFraction: 0.05, tradePercentage: 5 }, exchanges }),
    (err) => err.status === 422
  );
});

test('the bump cannot push past the position cap', async () => {
  // BTC's floor is far above a $50 cap: raising the size must not smuggle an
  // order past the ceiling that exists to bound it.
  const btc = {
    symbol: 'BTC/USDT:USDT', base: 'BTC', quote: 'USDT', settle: 'USDT',
    linear: true, inverse: false, contractSize: 1, active: true,
    precision: { amount: 0.001 }, limits: { amount: { min: 0.001 }, cost: { min: 5 } },
  };
  const ex = fakeExchange({ market: btc, balance: { USDT: { free: 8 } }, price: 80_248 });
  ex.amountToPrecision = (s, a) => Number(a).toFixed(3);

  await assert.rejects(
    run({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy' }, {
      config: { ...baseConfig, tradeFraction: 0.05, tradePercentage: 5,
        minNotionalBump: true, maxPositionNotional: 50 },
      exchanges: { fake: ex },
    }),
    (err) => err.status === 409 && /over the cap/.test(err.message)
  );
});

test('the bump still has to satisfy the liquidation guard', async () => {
  // A raised size eats the equity backing it. On a tiny balance that can pull
  // liquidation closer than the stop, and the guard must still refuse.
  const btc = {
    symbol: 'BTC/USDT:USDT', base: 'BTC', quote: 'USDT', settle: 'USDT',
    linear: true, inverse: false, contractSize: 1, active: true,
    precision: { amount: 0.001 }, limits: { amount: { min: 0.001 }, cost: { min: 5 } },
  };
  const ex = fakeExchange({ market: btc, balance: { USDT: { free: 8 } }, price: 80_248 });
  ex.amountToPrecision = (s, a) => Number(a).toFixed(3);

  await assert.rejects(
    run({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy' }, {
      config: { ...baseConfig, tradeFraction: 0.05, tradePercentage: 5, dryRun: false,
        minNotionalBump: true, maxPositionNotional: 1000, marginMode: 'cross',
        leverage: 25, liquidationSafetyFactor: 0.7, maintenanceMarginRate: 0.01,
        // $80.25 of BTC against $8 of equity puts liquidation 8.97% away, so
        // 6.28% is usable after the buffer. A 7% stop is past it.
        stopLossPercent: 7 },
      exchanges: { fake: ex },
    }),
    (err) => /liquidated before the stop/.test(err.message)
  );
});

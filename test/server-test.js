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
  readAccountEquity,
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
    breakers: stubRegistry({ blocked: true, reason: 'down 30%', day: '2026-09-04', baseline: 1000, consecutiveLosses: 2 }),
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

function stubRegistry(breaker, id = 'fake') {
  return { for: () => breaker, entries: () => [[id, breaker]] };
}

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
    breakers: stubRegistry(stubBreaker({ blocked: true, reason: 'down 30% today' })),
    logger: { log() {}, warn() {}, error() {} },
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => server.close());

  const body = await (await fetch(`http://127.0.0.1:${server.address().port}/health`)).json();
  assert.equal(body.scanner.enabled, false);
  assert.equal(body.breakers.fake.tripped, true, 'a halt must be visible with the scanner off');
  assert.match(body.breakers.fake.reason, /down 30%/);
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
    (err) => err.status === 409 && /over the fixed cap/.test(err.message)
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

test('/health reports whether undersized orders get raised', async (t) => {
  // The setting changes how large a real order is. Not reporting it left the
  // same blind spot marginMode had: no way to tell a value that was set from
  // one that quietly fell back to its default.
  const app = createApp({
    config: { ...baseConfig, minNotionalBump: true },
    getExchanges: () => ({ fake: fakeExchange() }),
    isReady: () => true,
    logger: { log() {}, warn() {}, error() {} },
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => server.close());
  const body = await (await fetch(`http://127.0.0.1:${server.address().port}/health`)).json();
  assert.equal(body.minNotionalBump, true);
});

/* ------------------------------------------------------------------ *
 * Markets that declare no minimum order value
 *
 * ccxt leaves limits.cost.min empty on some Bybit markets. Reading that as
 * "no minimum" put a real $0.25 order on RAVE, whose actual floor is $5:
 * the bump saw only the 1-unit lot, and the limits check skipped cost
 * entirely. A missing figure is not a zero.
 * ------------------------------------------------------------------ */

const raveMarket = {
  symbol: 'RAVE/USDT:USDT', base: 'RAVE', quote: 'USDT', settle: 'USDT',
  linear: true, inverse: false, contractSize: 1, active: true,
  precision: { amount: 1 },
  limits: { amount: { min: 1 } },   // NOTE: no cost.min, exactly as ccxt reports it
};

function raveExchange(free = 8) {
  const ex = fakeExchange({ market: raveMarket, balance: { USDT: { free } }, price: 0.2529 });
  ex.amountToPrecision = (s, a) => String(Math.floor(Number(a)));
  return ex;
}

test('a market with no declared cost.min still gets the configured floor', () => {
  // 5% of $8 = $0.40 = 1.58 RAVE, which rounds to 1 = $0.25.
  assert.equal(minimumTradeableAmount({ market: raveMarket, price: 0.2529 }), 1,
    'with no floor configured, the lot is the only constraint — the old behaviour');
  assert.equal(minimumTradeableAmount({ market: raveMarket, price: 0.2529, minNotional: 5 }), 20,
    '20 RAVE = $5.06, the first whole lot clearing $5');
});

test('the bump reaches the configured floor on such a market', async () => {
  const result = await run({ exchange: 'fake', symbol: 'RAVE/USDT:USDT', side: 'buy' }, {
    config: { ...baseConfig, tradeFraction: 0.05, tradePercentage: 5,
      minNotionalBump: true, minOrderNotional: 5 },
    exchanges: { fake: raveExchange() },
  });
  assert.equal(result.plan.amount, 20);
  assert.ok(result.plan.notionalQuote >= 5, `got ${result.plan.notionalQuote}`);
});

test('without the bump, an under-floor order is refused rather than sent', async () => {
  // The exact order that reached Bybit: $0.2529 of notional. It must not.
  let sent = false;
  const ex = raveExchange();
  ex.createOrder = async () => { sent = true; return { id: 'x' }; };
  await assert.rejects(
    run({ exchange: 'fake', symbol: 'RAVE/USDT:USDT', side: 'buy' }, {
      config: { ...baseConfig, tradeFraction: 0.05, tradePercentage: 5,
        dryRun: false, minOrderNotional: 5 },
      exchanges: { fake: ex },
    }),
    (err) => err.status === 422 && /below the RAVE\/USDT:USDT minimum of 5/.test(err.message)
  );
  assert.equal(sent, false, 'a sub-floor order must never reach the exchange');
});

test('an exchange-declared minimum still wins when it is higher', () => {
  const strict = { ...raveMarket, limits: { amount: { min: 1 }, cost: { min: 20 } } };
  assert.equal(minimumTradeableAmount({ market: strict, price: 0.2529, minNotional: 5 }), 80,
    '80 RAVE = $20.23; the configured 5 must not lower a real 20');
});

test('the order-value floor defaults to 1, not 5', () => {
  // Bybit accepted a $0.2529 order on RAVE, so 5 was never a validity floor —
  // defaulting to it would refuse orders the exchange is happy to take.
  const { execFileSync } = require('node:child_process');
  const out = execFileSync(process.execPath,
    ['-e', "console.log(require('./config').loadConfig().minOrderNotional)"],
    { cwd: __dirname + '/..', encoding: 'utf8',
      env: { PATH: process.env.PATH, AUTH_TOKEN: 'a'.repeat(64), USE_TESTNET: 'true',
        BYBIT_API_KEY: 'k', BYBIT_API_SECRET: 's',
        // Explicitly empty, which config reads as "not set". Without this the
        // subprocess loads the real .env sitting next to config.js and the
        // test measures whatever the developer happens to have configured
        // rather than the built-in default.
        MIN_ORDER_NOTIONAL_QUOTE: '' } }
  ).trim().split('\n').pop();
  assert.equal(out, '1', 'the code default, independent of any local .env');
});

test('a $1 floor still lifts a sub-dollar order off the floor', async () => {
  // 5% of $8 on RAVE is $0.40 -> 1 lot -> $0.25. With a $1 floor it becomes
  // 4 lots -> $1.01, which is the smallest whole lot clearing a dollar.
  const result = await run({ exchange: 'fake', symbol: 'RAVE/USDT:USDT', side: 'buy' }, {
    config: { ...baseConfig, tradeFraction: 0.05, tradePercentage: 5,
      minNotionalBump: true, minOrderNotional: 1 },
    exchanges: { fake: raveExchange() },
  });
  assert.equal(result.plan.amount, 4);
  assert.ok(result.plan.notionalQuote >= 1, `got ${result.plan.notionalQuote}`);
});

test('a floor of 0 defers entirely to the exchange', () => {
  assert.equal(minimumTradeableAmount({ market: raveMarket, price: 0.2529, minNotional: 0 }), 1,
    'no opinion of our own — whatever the lot allows');
});

/* ------------------------------------------------------------------ *
 * Cross margin sees the WHOLE book
 *
 * The per-symbol cap bounds one symbol. Under cross every position draws on
 * the same balance, so measuring only the symbol being traded made the guard
 * blind exactly where it mattered: ten symbols at the cap is ten times the
 * exposure it could see, and it approved each one while real liquidation
 * distance fell from 15% to under 1%.
 * ------------------------------------------------------------------ */

function bookExchange({ free = 8, price = 100, positions = [], failAllQuery = false } = {}) {
  const ex = fakeExchange({ balance: { USDT: { free, total: free } }, price, positions });
  ex.fetchPositions = async (symbols) => {
    if (!symbols && failAllQuery) throw new Error('bybit requires a category');
    if (!symbols) return positions;
    return positions.filter((p) => symbols.includes(p.symbol));
  };
  return ex;
}

const crossCfg = {
  ...baseConfig, dryRun: false, marginMode: 'cross', leverage: 25,
  liquidationSafetyFactor: 0.7, maintenanceMarginRate: 0.01,
  maxPositionNotional: 1000, stopLossPercent: 5,
  tradeFraction: 0.05, tradePercentage: 5, minNotionalBump: true, minOrderNotional: 50,
};

test('positions on OTHER symbols count toward the cross liquidation distance', async () => {
  // $8 of equity already backing $200 elsewhere. Adding $50 makes $250, so
  // liquidation sits ~2% away — closer than the 5% stop.
  const positions = ['A/USDT:USDT', 'B/USDT:USDT', 'C/USDT:USDT', 'D/USDT:USDT'].map((symbol) => ({
    symbol, side: 'long', contracts: 1, notional: 50,
  }));
  const ex = bookExchange({ positions });

  await assert.rejects(
    run({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy' }, { config: crossCfg, exchanges: { fake: ex } }),
    (err) => /liquidated before the stop/.test(err.message),
    'a book this size must not accept another position'
  );
});

test('the same order is fine when nothing else is open', async () => {
  const ex = bookExchange({ positions: [] });
  const result = await run({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy' },
    { config: crossCfg, exchanges: { fake: ex } });
  assert.equal(result.success, true, 'one $50 position on $8 is 15% from liquidation, well past a 5% stop');
});

test('isolated ignores other symbols, because their margin is separate', async () => {
  const positions = ['A/USDT:USDT', 'B/USDT:USDT', 'C/USDT:USDT', 'D/USDT:USDT'].map((symbol) => ({
    symbol, side: 'long', contracts: 1, notional: 50,
  }));
  const ex = bookExchange({ positions });
  // At 25x isolated, liquidation is 4% and usable 2.8%, so use a stop inside it.
  const result = await run({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy' }, {
    config: { ...crossCfg, marginMode: 'isolated', stopLossPercent: 2 },
    exchanges: { fake: ex },
  });
  assert.equal(result.success, true, 'other positions do not share this one\'s margin');
});

test('an unreadable book refuses a cross entry rather than assuming zero', async () => {
  const ex = bookExchange({ positions: [{ symbol: 'BTC/USDT:USDT', side: 'long', contracts: 1, notional: 50 }], failAllQuery: true });
  await assert.rejects(
    run({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy' }, { config: crossCfg, exchanges: { fake: ex } }),
    (err) => err.status === 502 && /total open exposure could not be read/.test(err.message)
  );
});

test('an unreadable book still lets you close', async () => {
  const ex = bookExchange({ positions: [{ symbol: 'BTC/USDT:USDT', side: 'long', contracts: 1, notional: 50 }], failAllQuery: true });
  const result = await run({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'sell', reduceOnly: true },
    { config: crossCfg, exchanges: { fake: ex } });
  assert.equal(result.success, true, 'never trap someone in a position');
});

test('a dry run tolerates an unreadable book', async () => {
  const ex = bookExchange({ positions: [], failAllQuery: true });
  const result = await run({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy' },
    { config: { ...crossCfg, dryRun: true }, exchanges: { fake: ex } });
  assert.equal(result.dryRun, true, 'nothing is at stake, so let the plan be seen');
});

/* ------------------------------------------------------------------ *
 * MAX_POSITION_PERCENT — a ceiling that scales with the account
 *
 * A fixed cap refuses rather than clamps, so the day the balance grows past
 * it every trade starts failing for a number set months earlier.
 * ------------------------------------------------------------------ */

function pctCapExchange(total) {
  return fakeExchange({ balance: { USDT: { free: total, total } }, price: 100 });
}

test('the percentage ceiling scales instead of expiring', async () => {
  // 5% of the account as the ceiling, 5% as the size: always exactly at the
  // limit and always allowed, whatever the balance.
  for (const equity of [200, 2_000, 20_000]) {
    const result = await run({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy' }, {
      config: { ...baseConfig, tradeFraction: 0.05, tradePercentage: 5,
        maxPositionNotional: null, maxPositionPercent: 5 },
      exchanges: { fake: pctCapExchange(equity) },
    });
    assert.equal(result.success, true, `should still trade at $${equity}`);
    assert.ok(Math.abs(result.plan.notionalQuote - equity * 0.05) < 0.01);
  }
});

test('a fixed cap alone stops working once the account outgrows it', async () => {
  // The exact failure this setting exists to avoid: 5% of $2000 is $100,
  // over a $50 cap that was sensible when the account held $8.
  await assert.rejects(
    run({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy' }, {
      config: { ...baseConfig, tradeFraction: 0.05, tradePercentage: 5,
        maxPositionNotional: 50, maxPositionPercent: null },
      exchanges: { fake: pctCapExchange(2000) },
    }),
    (err) => err.status === 409 && /over the fixed cap of 50/.test(err.message)
  );
});

test('with both set, the tighter ceiling wins', async () => {
  // $2000 account: 5% = $100 wanted. Percentage ceiling 10% = $200, fixed $50.
  await assert.rejects(
    run({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy' }, {
      config: { ...baseConfig, tradeFraction: 0.05, tradePercentage: 5,
        maxPositionNotional: 50, maxPositionPercent: 10 },
      exchanges: { fake: pctCapExchange(2000) },
    }),
    (err) => /over the fixed cap of 50/.test(err.message), 'the fixed 50 is tighter than 10%'
  );

  // Same account, fixed ceiling raised well clear: now the percentage binds.
  await assert.rejects(
    run({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy' }, {
      config: { ...baseConfig, tradeFraction: 0.05, tradePercentage: 5,
        maxPositionNotional: 10_000, maxPositionPercent: 2 },
      exchanges: { fake: pctCapExchange(2000) },
    }),
    (err) => /over 2% of a 2000\.00 account/.test(err.message), 'the 2% ceiling is tighter'
  );
});

test('the percentage ceiling counts an existing position too', async () => {
  const ex = fakeExchange({ balance: { USDT: { free: 1000, total: 1000 } }, price: 100,
    positions: [{ symbol: 'BTC/USDT:USDT', side: 'long', contracts: 0.4, notional: 40 }] });
  // 5% of $1000 = $50 wanted, $40 already open, ceiling 8% = $80. 90 > 80.
  await assert.rejects(
    run({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy' }, {
      config: { ...baseConfig, tradeFraction: 0.05, tradePercentage: 5,
        maxPositionNotional: null, maxPositionPercent: 8 },
      exchanges: { fake: ex },
    }),
    (err) => /exposure to 90\.00/.test(err.message) && /Existing position: 40\.00/.test(err.message)
  );
});

test('equity for the ceiling is total, not what is left uncommitted', async () => {
  // Otherwise the limit shrinks as positions open and depends on the order
  // things happened in rather than on the size of the account.
  assert.equal(readAccountEquity({ USDT: { free: 10, total: 100 } }, 'USDT'), 100);
  assert.equal(readAccountEquity({ total: { USDT: 250 } }, 'USDT'), 250);
  assert.equal(readAccountEquity({ USDT: { free: 7 } }, 'USDT'), 7, 'falls back when total is absent');
  assert.equal(readAccountEquity({}, 'USDT'), 0);
});

/* ------------------------------------------------------------------ *
 * The percentage ceiling has to work at BOTH ends of the range
 *
 * 10% of $8 is $0.80 against a $25 market minimum. Read literally that is a
 * ban on trading, not a position limit, and it refused every symbol. The
 * market's own floor raises the ceiling so one setting spans $8 to $100k.
 * ------------------------------------------------------------------ */

function scaleExchange(total, positions = []) {
  const m = {
    symbol: 'UNI/USDT:USDT', base: 'UNI', quote: 'USDT', settle: 'USDT',
    linear: true, inverse: false, contractSize: 1, active: true,
    precision: { amount: 0.1 }, limits: { amount: { min: 0.1 } },
  };
  const ex = fakeExchange({ market: m, balance: { USDT: { free: total, total } }, price: 6.15, positions });
  ex.amountToPrecision = (s, a) => (Math.round(Number(a) * 10) / 10).toFixed(1);
  ex.priceToPrecision = (s, p) => Number(p).toFixed(4);
  return ex;
}

const scaleCfg = {
  ...baseConfig, tradeFraction: 0.05, tradePercentage: 5,
  minNotionalBump: true, minOrderNotional: 25,
  maxPositionNotional: null, maxPositionPercent: 10,
};

test('one percentage ceiling works from a tiny account to a large one', async () => {
  for (const [equity, expected] of [[8, 25.21], [200, 25.21], [1000, 49.81], [50_000, 2499.97]]) {
    const r = await run({ exchange: 'fake', symbol: 'UNI/USDT:USDT', side: 'buy' },
      { config: scaleCfg, exchanges: { fake: scaleExchange(equity) } });
    assert.ok(Math.abs(r.plan.notionalQuote - expected) < 0.5,
      `$${equity}: expected ~${expected}, got ${r.plan.notionalQuote}`);
  }
});

test('a small account gets exactly one minimum position, not a second', async () => {
  // The ceiling was raised to the market floor, so the floor-sized order fits
  // and the next one does not. That is a limit, which is what was wanted.
  const ex = scaleExchange(8, [{ symbol: 'UNI/USDT:USDT', side: 'long', contracts: 4, notional: 25.21 }]);
  await assert.rejects(
    run({ exchange: 'fake', symbol: 'UNI/USDT:USDT', side: 'buy' }, { config: scaleCfg, exchanges: { fake: ex } }),
    (err) => err.status === 409 && /already above 10% of a 8\.00 account/.test(err.message)
  );
});

test('a large account is governed by the percentage, not the market floor', async () => {
  // $1000: 10% = $100 ceiling, 5% = $50 order, so a second one still fits.
  const ex = scaleExchange(1000, [{ symbol: 'UNI/USDT:USDT', side: 'long', contracts: 8, notional: 49.81 }]);
  const r = await run({ exchange: 'fake', symbol: 'UNI/USDT:USDT', side: 'buy' },
    { config: scaleCfg, exchanges: { fake: ex } });
  assert.equal(r.success, true);
});

test('the fixed cap is NOT raised by the market floor', async () => {
  // That one exists to say "never more than $X in a symbol", and excluding a
  // market whose minimum exceeds it is exactly its job.
  await assert.rejects(
    run({ exchange: 'fake', symbol: 'UNI/USDT:USDT', side: 'buy' }, {
      config: { ...scaleCfg, maxPositionNotional: 10, maxPositionPercent: null },
      exchanges: { fake: scaleExchange(8) },
    }),
    (err) => err.status === 409 && /over the fixed cap of 10/.test(err.message)
  );
});

/* ------------------------------------------------------------------ *
 * One breaker per exchange
 *
 * A shared breaker read equity from whichever exchange the trade targeted, so
 * a Bybit tap set the baseline from one account and a Weex tap compared a
 * different account against it. The "daily loss" was then just the gap
 * between two balances.
 * ------------------------------------------------------------------ */

const { createBreakers, reconstructBaseline, DailyLossBreaker } = require('../scanner');

test('each exchange gets its own breaker, and they are independent', () => {
  const reg = createBreakers({
    config: { ...baseConfig, stateDir: null, scanner: { maxDailyLossPercent: 5, maxConsecutiveLosses: 4 } },
    logger: { log() {}, warn() {}, error() {} },
  });
  const bybit = reg.for('bybit');
  const weex = reg.for('weex');

  assert.notEqual(bybit, weex, 'two venues must not share one baseline');
  assert.equal(reg.for('bybit'), bybit, 'the same venue returns the same breaker');

  bybit.update(1000, { log() {}, warn() {}, error() {} });
  bybit.update(900, { log() {}, warn() {}, error() {} });   // 10% down -> tripped
  assert.equal(bybit.blocked, true);
  assert.equal(weex.blocked, false, 'a loss on one exchange must not halt the other');
  assert.equal(weex.baseline, null, 'nor pollute its baseline');
});

test('the ledger is asked for a currency first, and unfiltered only as a fallback', async () => {
  // Weex answers "could not resolve currency" to fetchLedger(undefined), which
  // left the baseline unestablished and failed the breaker closed on BOTH
  // exchanges.
  const calls = [];
  const weexLike = {
    has: { fetchLedger: true },
    async fetchLedger(code, _since, _limit) {
      calls.push(code);
      if (code === undefined) throw new Error('weex fetchLedger() could not resolve currency');
      return [{ timestamp: Date.now(), type: 'trade', direction: 'out', amount: 2 }];
    },
  };
  const baseline = await reconstructBaseline({
    exchange: weexLike, equity: 98, logger: { log() {}, warn() {}, error() {} },
  });
  assert.equal(calls[0], 'USDT', 'the currency is supplied up front');
  assert.equal(baseline, 100, 'so the day’s result resolves instead of failing');
});

test('an exchange that rejects a currency still works', async () => {
  const calls = [];
  const picky = {
    has: { fetchLedger: true },
    async fetchLedger(code) {
      calls.push(code);
      if (code !== undefined) throw new Error('this exchange takes no currency');
      return [];
    },
  };
  const baseline = await reconstructBaseline({
    exchange: picky, equity: 50, logger: { log() {}, warn() {}, error() {} },
  });
  // The ladder narrows one argument at a time: currency+time, currency alone,
  // then no currency. An exchange that rejects any currency reaches step three.
  assert.deepEqual(calls, ['USDT', 'USDT', undefined], 'tries the currency both ways before dropping it');
  assert.equal(baseline, 50);
});

test('both ledger attempts failing still refuses to guess', async () => {
  const dead = { has: { fetchLedger: true }, async fetchLedger() { throw new Error('nope'); } };
  assert.equal(
    await reconstructBaseline({ exchange: dead, equity: 50, logger: { log() {}, warn() {}, error() {} } }),
    null
  );
});

test('a Weex-shaped exchange — rejects the timestamp, demands a currency', async () => {
  // The exact pair of failures from the live log:
  //   fetchLedger('USDT', since) -> "Parameter 'startTime' is invalid"
  //   fetchLedger(undefined, ...) -> "could not resolve currency"
  // Dropping the currency kept the bad timestamp, so both attempts failed and
  // the breaker halted trading on an exchange that was working fine.
  const calls = [];
  const weex = {
    has: { fetchLedger: true },
    async fetchLedger(code, since, _limit) {
      calls.push([code, since === undefined ? 'no-since' : 'since']);
      if (code === undefined) throw new Error('weex fetchLedger() could not resolve currency');
      if (since !== undefined) throw new Error(`weex {"code":-1142,"msg":"Parameter 'startTime' is invalid."}`);
      const today = Date.parse(new Date().toISOString().slice(0, 10) + 'T02:00:00Z');
      return [
        { timestamp: today - 86_400_000, type: 'trade', direction: 'out', amount: 999 }, // yesterday
        { timestamp: today, type: 'trade', direction: 'out', amount: 3 },
      ];
    },
  };

  const baseline = await reconstructBaseline({
    exchange: weex, equity: 97, logger: { log() {}, warn() {}, error() {} },
  });
  assert.deepEqual(calls, [['USDT', 'since'], ['USDT', 'no-since']],
    'it keeps the currency and drops the timestamp, not the other way round');
  assert.equal(baseline, 100,
    'yesterday’s 999 is filtered out locally, so a wider query gives the same answer');
});

/* ------------------------------------------------------------------ *
 * Reading a ledger entry's direction
 *
 * A Weex account produced a baseline of -98.72 because entries with no
 * `direction` were counted as inflows, so the day's losses were added instead
 * of subtracted and the total came out larger than the balance.
 * ------------------------------------------------------------------ */

const { signedLedgerAmount } = require('../scanner');

test('direction is read from whichever field the exchange actually filled', () => {
  assert.equal(signedLedgerAmount({ direction: 'out', amount: 5 }), -5, 'ccxt’s documented shape');
  assert.equal(signedLedgerAmount({ direction: 'in', amount: 5 }), 5);
  assert.equal(signedLedgerAmount({ direction: 'out', amount: -5 }), -5, 'direction wins over a stray sign');
  assert.equal(signedLedgerAmount({ amount: -5 }), -5, 'a negative amount is unambiguous on its own');
  assert.equal(signedLedgerAmount({ amount: 5, before: 100, after: 95 }), -5,
    'before/after settles it even when the amount looks positive');
  assert.equal(signedLedgerAmount({ amount: 5 }), null,
    'a bare positive amount could be either way — that is not a guess worth making');
});

test('entries with no usable direction abort the reconstruction', async () => {
  // Totalling only the entries we understood would silently under-count the
  // day, which moves the baseline the wrong way.
  const vague = {
    has: { fetchLedger: true },
    async fetchLedger() {
      return [
        { timestamp: Date.now(), type: 'trade', direction: 'out', amount: 2 },
        { timestamp: Date.now(), type: 'trade', amount: 100 },   // no direction, positive
      ];
    },
  };
  const warned = [];
  assert.equal(
    await reconstructBaseline({ exchange: vague, equity: 50,
      logger: { log() {}, warn: m => warned.push(m), error() {} } }),
    null
  );
  assert.ok(warned.some(m => /no usable direction/.test(m)), 'and says why');
});

test('the cold-start halt can be opted out of, deliberately', () => {
  const quiet = { log() {}, warn() {}, error() {} };

  const strict = new DailyLossBreaker({
    maxDailyLossPercent: 5, maxConsecutiveLosses: null, failClosed: true, logger: quiet,
  });
  strict.adoptBaseline(null, quiet, 900);
  assert.equal(strict.blocked, true, 'default: no baseline means no trading');

  const lenient = new DailyLossBreaker({
    maxDailyLossPercent: 5, maxConsecutiveLosses: null, failClosed: false, logger: quiet,
  });
  lenient.adoptBaseline(null, quiet, 900);
  assert.equal(lenient.blocked, false, 'opted out: carries on from current equity');
  assert.equal(lenient.baseline, 900, 'so the limit measures from now, not midnight');
});

test('an exchange that reports success as an error is not read as a failure', async () => {
  // Weex answers setMarginMode with {"msg":"success","code":"200"} and ccxt
  // throws on it. Logged as "could not set cross margin", that left the cross
  // liquidation maths running without knowing its own premise held.
  const { applyMarginMode, looksLikeSuccess } = require('../exchanges');

  assert.equal(looksLikeSuccess('weex {"msg":"success","requestTime":1788826391040,"code":"200"}'), true);
  assert.equal(looksLikeSuccess('bybit 110026 margin mode is not modified'), true);
  assert.equal(looksLikeSuccess('weex {"msg":"insufficient balance","code":"-1004"}'), false,
    'a real failure must still read as one');

  const weexy = {
    id: 'weex',
    has: { setMarginMode: true },
    async setMarginMode() { throw new Error('weex {"msg":"success","requestTime":1,"code":"200"}'); },
  };
  const r = await applyMarginMode(weexy, 'ICP/USDT:USDT', 'cross', 25, { log() {}, warn() {}, error() {} });
  assert.equal(r.ok, true, 'the mode was applied, so the caller must be told so');

  const broken = {
    id: 'weex',
    has: { setMarginMode: true },
    async setMarginMode() { throw new Error('weex {"msg":"position exists","code":"-1"}'); },
  };
  const bad = await applyMarginMode(broken, 'ICP/USDT:USDT', 'cross', 25, { log() {}, warn() {}, error() {} });
  assert.equal(bad.ok, false, 'and a genuine refusal still reports failure');
});

test('a ledger whose total cannot be true is refused, with the fields shown', async () => {
  // Weex's real shape: four trades on one day, all direction "in", totalling
  // +137.80 against an account holding 12.25. Summed literally that makes the
  // day look like a large gain and the baseline negative.
  const today = Date.parse(new Date().toISOString().slice(0, 10) + 'T03:00:00Z');
  const weex = {
    has: { fetchLedger: true },
    async fetchLedger() {
      return [34.4, 34.5, 34.4, 34.5].map((amount) => ({
        timestamp: today, type: 'trade', direction: 'in', amount, currency: 'USDT',
      }));
    },
  };
  const warned = [];
  const baseline = await reconstructBaseline({
    exchange: weex, equity: 12.25,
    logger: { log() {}, warn: m => warned.push(m), error() {} },
  });
  assert.equal(baseline, null);
  assert.ok(warned.some(m => /implausible/.test(m) && /directions seen: in/.test(m)),
    `expected the implausible-total diagnosis, got: ${warned.join(' | ')}`);
  assert.ok(warned.some(m => /BREAKER_FALLBACK_TO_EQUITY/.test(m)), 'and says what to do about it');
});

test('a genuine mix of gains and losses is still totalled normally', async () => {
  const today = Date.parse(new Date().toISOString().slice(0, 10) + 'T03:00:00Z');
  const healthy = {
    has: { fetchLedger: true },
    async fetchLedger() {
      return [
        { timestamp: today, type: 'trade', direction: 'in', amount: 10 },
        { timestamp: today, type: 'trade', direction: 'out', amount: 4 },
        { timestamp: today, type: 'fee', direction: 'out', amount: 1 },
      ];
    },
  };
  assert.equal(
    await reconstructBaseline({ exchange: healthy, equity: 105, logger: { log() {}, warn() {}, error() {} } }),
    100, 'up 5 on the day means it opened at 100'
  );
});

test('a day of losses only is an ordinary day, not a broken ledger', async () => {
  // One trade in a day is legitimately one direction; the check needs more
  // than that before calling the ledger unusable.
  const today = Date.parse(new Date().toISOString().slice(0, 10) + 'T03:00:00Z');
  const one = {
    has: { fetchLedger: true },
    async fetchLedger() {
      return [{ timestamp: today, type: 'trade', direction: 'out', amount: 5 }];
    },
  };
  assert.equal(
    await reconstructBaseline({ exchange: one, equity: 95, logger: { log() {}, warn() {}, error() {} } }),
    100
  );
});

/* ------------------------------------------------------------------ *
 * The ledger fallback is named per exchange
 *
 * ccxt reads Bybit's ledger cleanly and cannot total Weex's at all. A single
 * on/off switch would have relaxed Bybit for failures it has never had,
 * purely to unblock Weex.
 * ------------------------------------------------------------------ */

const { mayFallBack } = require('../scanner');

test('naming one exchange does not relax the others', () => {
  const cfg = { breakerFallbackExchanges: ['weex'] };
  assert.equal(mayFallBack(cfg, 'weex'), true);
  assert.equal(mayFallBack(cfg, 'bybit'), false, 'bybit keeps the strict behaviour');
});

test('the default is strict everywhere', () => {
  for (const cfg of [{ breakerFallbackExchanges: [] }, {}]) {
    assert.equal(mayFallBack(cfg, 'weex'), false);
    assert.equal(mayFallBack(cfg, 'bybit'), false);
  }
});

test('"all" is available, and case does not matter', () => {
  assert.equal(mayFallBack({ breakerFallbackExchanges: ['all'] }, 'bybit'), true);
  assert.equal(mayFallBack({ breakerFallbackExchanges: ['WEEX'] }, 'weex'), true);
  assert.equal(mayFallBack({ breakerFallbackExchanges: ['weex'] }, 'WEEX'), true);
});

test('a named exchange halts on a cold start, an unnamed one still refuses', () => {
  const quiet = { log() {}, warn() {}, error() {} };
  const cfg = {
    dryRun: false,
    breakerFallbackExchanges: ['weex'],
    stateDir: null,
    scanner: { maxDailyLossPercent: 5, maxConsecutiveLosses: 4 },
  };
  const reg = createBreakers({ config: cfg, logger: quiet });

  const weex = reg.for('weex');
  weex.adoptBaseline(null, quiet, 900);
  assert.equal(weex.blocked, false, 'named: carries on from current equity');
  assert.equal(weex.baseline, 900);

  const bybit = reg.for('bybit');
  bybit.adoptBaseline(null, quiet, 900);
  assert.equal(bybit.blocked, true, 'unnamed: still refuses to trade without a baseline');
});

/* ------------------------------------------------------------------ *
 * Market data proxy
 *
 * Tokenised-stock perps (MSTRUSDT.P, QQQUSDT.P) exist on Bybit and Weex but
 * on none of the chart's three crypto sources, and a browser cannot reach
 * Bybit from a geo-blocked location anyway. The server can, so it serves them.
 * ------------------------------------------------------------------ */

const { searchMarkets, searchAcrossExchanges, minNotionalOf, fetchCandles } = require('../marketdata');

function marketExchange(extra = {}) {
  const mk = (symbol, base, over = {}) => ({
    symbol, base, quote: 'USDT', settle: 'USDT', type: 'swap', active: true,
    precision: { amount: 0.1 }, limits: { amount: { min: 0.1 }, cost: { min: 5 } }, ...over,
  });
  const markets = {
    'MSTR/USDT:USDT': mk('MSTR/USDT:USDT', 'MSTR'),
    'QQQ/USDT:USDT': mk('QQQ/USDT:USDT', 'QQQ'),
    'BTC/USDT:USDT': mk('BTC/USDT:USDT', 'BTC'),
    'MSTRX/USDT:USDT': mk('MSTRX/USDT:USDT', 'MSTRX'),
    'DEAD/USDT:USDT': mk('DEAD/USDT:USDT', 'DEAD', { active: false }),
  };
  return {
    id: 'bybit', has: { fetchOHLCV: true }, markets,
    market(s) { if (!markets[s]) throw new Error('no market'); return markets[s]; },
    async fetchOHLCV() {
      return [[1_700_000_000_000, 1, 2, 0.5, 1.5, 100], [1_700_000_060_000, 1.5, 2.5, 1, 2, 120]];
    },
    ...extra,
  };
}

test('searching finds a tokenised-stock perp by its ticker', () => {
  const found = searchMarkets(marketExchange(), 'MSTR');
  assert.equal(found[0].symbol, 'MSTR/USDT:USDT', 'the exact base ranks first');
  assert.ok(found.some(m => m.symbol === 'MSTRX/USDT:USDT'), 'near matches still appear, below it');
  assert.equal(found[0].minCost, 5, 'and it reports what the market will accept');
  assert.equal(found[0].precision, 0.1);
});

test('search is case-insensitive and skips delisted markets', () => {
  const found = searchMarkets(marketExchange(), 'qqq');
  assert.equal(found[0].symbol, 'QQQ/USDT:USDT');
  assert.equal(searchMarkets(marketExchange(), 'DEAD').length, 0, 'an inactive market is not offered');
});

test('an empty query is refused rather than dumping every market', () => {
  assert.throws(() => searchMarkets(marketExchange(), ''), RequestError);
});

test('candles come back in the shape the chart already draws', async () => {
  const out = await fetchCandles(marketExchange(), { symbol: 'MSTR/USDT:USDT', timeframe: '1h' });
  assert.equal(out.src, 'bybit');
  assert.equal(out.symbol, 'MSTR/USDT:USDT');
  assert.deepEqual(out.candles[0], { t: 1_700_000_000_000, o: 1, h: 2, l: 0.5, c: 1.5, v: 100 });
});

test('an unlisted symbol or bad timeframe is a 400, not a 500', async () => {
  await assert.rejects(
    fetchCandles(marketExchange(), { symbol: 'NOPE/USDT:USDT', timeframe: '1h' }),
    (err) => err instanceof RequestError && /not listed on bybit/.test(err.message)
  );
  await assert.rejects(
    fetchCandles(marketExchange(), { symbol: 'MSTR/USDT:USDT', timeframe: '7s' }),
    (err) => err instanceof RequestError && /timeframe/.test(err.message)
  );
});

test('an exchange that refuses is a 502, and rows with junk prices are dropped', async () => {
  await assert.rejects(
    fetchCandles(marketExchange({ async fetchOHLCV() { throw new Error('rate limited'); } }),
      { symbol: 'MSTR/USDT:USDT', timeframe: '1h' }),
    (err) => err.status === 502
  );

  const junky = marketExchange({
    async fetchOHLCV() {
      return [[1, 1, 2, 0.5, 1.5, 10], [2, null, 'x', undefined, NaN, 0]];
    },
  });
  const out = await fetchCandles(junky, { symbol: 'MSTR/USDT:USDT', timeframe: '1h' });
  assert.equal(out.candles.length, 1, 'a row the chart cannot scale is not drawn');
});

test('the candle limit is clamped to something the exchange will serve', async () => {
  let asked = null;
  const ex = marketExchange({
    async fetchOHLCV(_s, _tf, _since, limit) { asked = limit; return [[1, 1, 1, 1, 1, 1]]; },
  });
  await fetchCandles(ex, { symbol: 'MSTR/USDT:USDT', timeframe: '1h', limit: 99_999 });
  assert.equal(asked, 1000);
  await fetchCandles(ex, { symbol: 'MSTR/USDT:USDT', timeframe: '1h', limit: 1 });
  assert.equal(asked, 10);
});

test('the market endpoints require the token like everything else', async (t) => {
  // Each call spends this server's rate limit with the exchange; an open
  // proxy would be someone else's free market-data feed.
  const app = createApp({
    config: baseConfig,
    getExchanges: () => ({ bybit: marketExchange() }),
    isReady: () => true,
    logger: { log() {}, warn() {}, error() {} },
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  for (const path of ['/api/markets?exchange=bybit&q=MSTR', '/api/candles?exchange=bybit&symbol=MSTR/USDT:USDT&timeframe=1h']) {
    assert.equal((await fetch(base + path)).status, 401, `${path} must be authenticated`);
  }

  const auth = { 'X-Auth-Token': AUTH_TOKEN };
  const markets = await (await fetch(`${base}/api/markets?exchange=bybit&q=MSTR`, { headers: auth })).json();
  assert.equal(markets.success, true);
  assert.equal(markets.markets[0].symbol, 'MSTR/USDT:USDT');
  assert.equal(markets.markets[0].exchange, 'bybit', 'every row says which venue it came from');

  const candles = await (await fetch(
    `${base}/api/candles?exchange=bybit&symbol=${encodeURIComponent('MSTR/USDT:USDT')}&timeframe=1h`,
    { headers: auth })).json();
  assert.equal(candles.success, true);
  assert.equal(candles.candles.length, 2);

  const unknown = await fetch(`${base}/api/markets?exchange=kraken&q=MSTR`, { headers: auth });
  assert.equal(unknown.status, 400, 'an exchange with no credentials is a clear 400');
});

/* ------------------------------------------------------------------ *
 * Searching both venues at once
 *
 * The same ticker lists on both with very different minimums — SUI floors
 * near $5 on Bybit and $82.89 on Weex, purely because the lot step there is
 * 10 SUI. A result is only meaningful with its exchange and price attached.
 * ------------------------------------------------------------------ */

function venue(id, defs, { prices = {}, tickersThrow = false } = {}) {
  const markets = {};
  for (const [symbol, over] of Object.entries(defs)) {
    markets[symbol] = {
      symbol, base: symbol.split('/')[0], quote: 'USDT', settle: 'USDT',
      type: 'swap', active: true,
      precision: { amount: over.step }, limits: { amount: { min: over.step }, cost: { min: over.minCost ?? 0 } },
    };
  }
  return {
    id, markets, has: { fetchOHLCV: true, fetchTickers: true },
    market(s) { if (!markets[s]) throw new Error('no market'); return markets[s]; },
    async fetchTickers(symbols) {
      if (tickersThrow) throw new Error('ticker endpoint unavailable');
      return Object.fromEntries(symbols.filter(s => prices[s] != null).map(s => [s, { last: prices[s] }]));
    },
  };
}

test('one search returns the same ticker from both venues, priced', async () => {
  const exchanges = {
    bybit: venue('bybit', { 'SUI/USDT:USDT': { step: 0.1, minCost: 5 } }, { prices: { 'SUI/USDT:USDT': 3.2 } }),
    weex: venue('weex', { 'SUI/USDT:USDT': { step: 10 } }, { prices: { 'SUI/USDT:USDT': 3.2 } }),
  };
  const rows = await searchAcrossExchanges(exchanges, 'SUI', { logger: { log() {}, warn() {}, error() {} } });

  assert.equal(rows.length, 2, 'both venues appear');
  assert.deepEqual(rows.map(r => r.exchange), ['bybit', 'weex'], 'cheapest minimum first');
  assert.equal(rows[0].price, 3.2, 'each row carries its own price');

  // 0.1 x 3.2 = 0.32, below the declared 5 -> the $5 floor binds.
  assert.equal(rows[0].minNotional, 5);
  // 10 x 3.2 = 32, and nothing declared -> the lot step is the floor.
  assert.equal(rows[1].minNotional, 32);
});

test('a venue that cannot price its markets still lists them', async () => {
  const exchanges = {
    bybit: venue('bybit', { 'MSTR/USDT:USDT': { step: 0.1, minCost: 5 } }, { tickersThrow: true }),
  };
  const rows = await searchAcrossExchanges(exchanges, 'MSTR', { logger: { log() {}, warn() {}, error() {} } });
  assert.equal(rows.length, 1, 'a null price is worth more than no result');
  assert.equal(rows[0].price, null);
  assert.equal(rows[0].minNotional, 5, 'the declared minimum still stands without a price');
});

test('the minimum is the larger of the lot value and the declared floor', () => {
  assert.equal(minNotionalOf({ precision: 0.001, minCost: 5 }, 80_248), 80.248, 'BTC: the lot dominates');
  assert.equal(minNotionalOf({ precision: 1, minCost: 5 }, 0.21), 5, 'ADA: the declared floor dominates');
  assert.equal(minNotionalOf({ precision: 0, minCost: 0 }, 10), null, 'nothing known is null, not zero');
});

test('a bad query is refused once, not once per exchange', async () => {
  const exchanges = { bybit: venue('bybit', { 'A/USDT:USDT': { step: 1 } }), weex: venue('weex', {}) };
  await assert.rejects(
    searchAcrossExchanges(exchanges, '', { logger: { log() {}, warn() {}, error() {} } }),
    RequestError
  );
});

test('the tradeable USDT perp outranks the other contracts on the same base', () => {
  // Searching BTC on Bybit matches the USDT perp, the USDC perp, the inverse
  // coin-margined contract and spot. They are different instruments at
  // different prices, and only the USDT swap is one this app can size.
  const mk = (symbol, type, settle) => ({
    symbol, base: 'BTC', quote: symbol.split('/')[1].split(':')[0], settle, type, active: true,
    precision: { amount: 0.001 }, limits: { amount: { min: 0.001 }, cost: { min: 5 } },
  });
  const ex = {
    id: 'bybit',
    markets: {
      'BTC/USDC:USDC': mk('BTC/USDC:USDC', 'swap', 'USDC'),
      'BTC/USD:BTC': mk('BTC/USD:BTC', 'swap', 'BTC'),
      'BTC/USDT': mk('BTC/USDT', 'spot', undefined),
      'BTC/USDT:USDT': mk('BTC/USDT:USDT', 'swap', 'USDT'),
    },
  };
  const found = searchMarkets(ex, 'BTC');
  assert.equal(found[0].symbol, 'BTC/USDT:USDT', 'the USDT-settled perp comes first');
  assert.equal(found.length, 4, 'the others are still offered, just below it');
});

test('tickers are fetched per market type, not in one mixed call', async () => {
  // Bybit splits its API into spot / linear / inverse categories and rejects a
  // fetchTickers that mixes them — which left every result unpriced and every
  // added symbol sitting at a placeholder price.
  const calls = [];
  const mk = (symbol, type, settle) => ({
    symbol, base: 'BTC', quote: 'USDT', settle, type, active: true,
    precision: { amount: 0.001 }, limits: { amount: { min: 0.001 }, cost: { min: 5 } },
  });
  const ex = {
    id: 'bybit',
    has: { fetchTickers: true },
    markets: {
      'BTC/USDT:USDT': mk('BTC/USDT:USDT', 'swap', 'USDT'),
      'BTC/USDT': mk('BTC/USDT', 'spot', undefined),
    },
    async fetchTickers(symbols) {
      calls.push(symbols);
      const types = new Set(symbols.map(s => this.markets[s].type));
      if (types.size > 1) throw new Error('bybit: category cannot be inferred from mixed symbols');
      return Object.fromEntries(symbols.map(s => [s, { last: 80_248 }]));
    },
  };

  const rows = await searchAcrossExchanges({ bybit: ex }, 'BTC',
    { logger: { log() {}, warn() {}, error() {} } });

  assert.equal(calls.length, 2, 'one call per market type');
  for (const batch of calls) {
    assert.equal(new Set(batch.map(s => ex.markets[s].type)).size, 1, 'and never mixed');
  }
  assert.ok(rows.every(r => r.price === 80_248), 'so every row comes back priced');
});

/* ------------------------------------------------------------------ *
 * Tickers written the way charting sites write them
 *
 * People read a symbol on TradingView and type it here. Matching only the
 * ccxt spelling meant MSTRUSDT.P, QQQUSDT.P and BYBIT:BTCUSDT.P all found
 * nothing, with no hint as to why.
 * ------------------------------------------------------------------ */

const { listedSymbols } = require('../marketdata');

/* ------------------------------------------------------------------ *
 * Which symbols a venue lists
 *
 * The scanner runs every symbol on one exchange, but the watchlist holds
 * symbols found on either. This is what lets the panel grey out the ones
 * the selected venue cannot trade, instead of letting the save fail.
 * ------------------------------------------------------------------ */

const listingVenue = (listed) => ({
  id: 'bybit',
  market(sym) {
    if (!listed.includes(sym)) throw new Error(`bybit does not have market symbol ${sym}`);
    return { symbol: sym };
  },
});

test('a symbol the venue lists is reported listed, one it does not is not', () => {
  const out = listedSymbols(listingVenue(['BTC/USDT:USDT']), ['BTC/USDT:USDT', 'AAPLX/USDT']);
  assert.equal(out['BTC/USDT:USDT'], true);
  assert.equal(out['AAPLX/USDT'], false);
});

test('every symbol asked about gets an answer', () => {
  // A missing key would read as "unknown" in the panel and quietly leave a
  // chip enabled that the server will refuse.
  const asked = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'DOGE/USDT:USDT'];
  const out = listedSymbols(listingVenue(['ETH/USDT:USDT']), asked);
  assert.deepEqual(Object.keys(out).sort(), [...asked].sort());
});

test('an exchange whose markets never loaded reports nothing as listed', () => {
  // ccxt throws the same way for an unknown symbol and for an unloaded market
  // map. Both mean "cannot trade this here", which is the honest answer —
  // and the safe one, since it disables the chip rather than enabling it.
  const broken = { id: 'weex', market() { throw new Error('markets not loaded'); } };
  const out = listedSymbols(broken, ['BTC/USDT:USDT']);
  assert.equal(out['BTC/USDT:USDT'], false);
});

test('the check reads the loaded market map rather than calling the exchange', () => {
  // A network call per symbol would make switching exchange in the panel cost
  // one round trip per watchlist entry.
  let calls = 0;
  const venue = {
    id: 'bybit',
    market: (s2) => { calls += 1; return { symbol: s2 }; },
    fetchMarkets() { throw new Error('must not be called'); },
    loadMarkets() { throw new Error('must not be called'); },
  };
  listedSymbols(venue, ['BTC/USDT:USDT', 'ETH/USDT:USDT']);
  assert.equal(calls, 2, 'one map lookup per symbol, nothing more');
});

const { normaliseTicker } = require('../marketdata');

test('a TradingView-style ticker resolves to its base currency', () => {
  assert.equal(normaliseTicker('MSTRUSDT.P'), 'MSTR');
  assert.equal(normaliseTicker('QQQUSDT.P'), 'QQQ');
  assert.equal(normaliseTicker('BYBIT:MSTRUSDT.P'), 'MSTR', 'the exchange prefix is dropped');
  assert.equal(normaliseTicker('WEEX:AAPLXUSDT.PERP'), 'AAPLX', '.PERP too');
  assert.equal(normaliseTicker('BTCUSDT'), 'BTC', 'no suffix needed');
  assert.equal(normaliseTicker('  mstrusdt.p  '), 'MSTR', 'whitespace and case do not matter');
});

test('a pasted ccxt symbol keeps its base, not its settle currency', () => {
  // BASE/QUOTE:SETTLE — that colon is the settle separator, not an exchange
  // prefix. Stripping at it turned MSTR/USDT:USDT into a search for USDT.
  assert.equal(normaliseTicker('MSTR/USDT:USDT'), 'MSTR');
  assert.equal(normaliseTicker('BTC/USD:BTC'), 'BTC');
});

test('a bare quote currency is still searchable as itself', () => {
  // Stripping unconditionally would leave nothing to search for.
  assert.equal(normaliseTicker('USDT'), 'USDT');
  assert.equal(normaliseTicker('BTC'), 'BTC');
  assert.equal(normaliseTicker('ETHBTC'), 'ETH', 'but a real pair still splits');
});

test('the normalised ticker is what search actually matches on', () => {
  const mk = (symbol, base) => ({
    symbol, base, quote: 'USDT', settle: 'USDT', type: 'swap', active: true,
    precision: { amount: 0.1 }, limits: { amount: { min: 0.1 }, cost: { min: 5 } },
  });
  const ex = { id: 'bybit', markets: { 'MSTR/USDT:USDT': mk('MSTR/USDT:USDT', 'MSTR') } };
  for (const q of ['MSTR', 'MSTRUSDT.P', 'BYBIT:MSTRUSDT.P', 'MSTRUSDT']) {
    assert.equal(searchMarkets(ex, q).length, 1, `"${q}" should find the market`);
  }
});

/* ------------------------------------------------------------------ *
 * Hedge mode — a long and a short on the same symbol at once
 *
 * One-way accounts hold one position, so an order against it silently
 * REVERSES it: closing the old and opening the opposite at twice the size.
 * The flip guard exists for that. Hedge accounts hold both by design, so the
 * guard has to stand down — but the two positions must stay separate, or a
 * new long looks like it is reducing the short.
 * ------------------------------------------------------------------ */

// Named 'bybit' because the side-index convention is exchange-specific and
// only Bybit's is known here — an unnamed venue is deliberately refused.
function hedgeExchange(positions = [], onOrder) {
  const ex = fakeExchange({
    balance: { USDT: { free: 10_000, total: 10_000 } },
    price: 100,
    positions,
    onCreateOrder: (...args) => { if (onOrder) onOrder(...args); return { id: 'o', status: 'closed', filled: args[3] }; },
  });
  ex.id = 'bybit';
  return ex;
}
const hedgeCfg = (over = {}) => ({ ...baseConfig, dryRun: false, hedgeMode: true, ...over });
const hedged = (ex) => ({ bybit: ex });
const longPos = { symbol: 'BTC/USDT:USDT', side: 'long', contracts: 1, notional: 100 };
const shortPos = { symbol: 'BTC/USDT:USDT', side: 'short', contracts: 1, notional: 100 };

test('without hedge mode, opening against a position is refused', async () => {
  await assert.rejects(
    run({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy' }, {
      config: { ...baseConfig, dryRun: false, hedgeMode: false },
      exchanges: { fake: hedgeExchange([shortPos]) },
    }),
    (err) => err.status === 409 && /HEDGE_MODE=true to hold both/.test(err.message)
  );
});

test('with hedge mode, both directions can be open at once', async () => {
  let params = null;
  const result = await run({ exchange: 'bybit', symbol: 'BTC/USDT:USDT', side: 'buy' }, {
    config: hedgeCfg(),
    exchanges: hedged(hedgeExchange([shortPos], (...a) => { params = a[5]; })),
  });
  assert.equal(result.success, true, 'a long opens while a short is held');
  assert.equal(params.positionIdx, 1, 'and names the long side so it is not applied to the short');
});

test('the side index follows the POSITION, not the order', async () => {
  // A reduceOnly sell closes a LONG, so it is still index 1. Sending 2 there
  // would aim the close at the short and leave the long untouched.
  let params = null;
  await run({ exchange: 'bybit', symbol: 'BTC/USDT:USDT', side: 'sell', reduceOnly: true }, {
    config: hedgeCfg(),
    exchanges: hedged(hedgeExchange([longPos, shortPos], (...a) => { params = a[5]; })),
  });
  assert.equal(params.positionIdx, 1, 'closing a long is index 1 even though the order sells');
});

test('a hedged close targets the matching side, not the larger one', async () => {
  // With a 5-contract short and a 1-contract long open, closing the long must
  // sell 1 — netting or picking the larger would sell five.
  let amount = null;
  await run({ exchange: 'bybit', symbol: 'BTC/USDT:USDT', side: 'sell', reduceOnly: true }, {
    config: hedgeCfg(),
    exchanges: {
      bybit: hedgeExchange(
        [{ ...longPos, contracts: 1 }, { ...shortPos, contracts: 5, notional: 500 }],
        (...a) => { amount = a[3]; }
      ),
    },
  });
  assert.equal(Number(amount), 1, 'closes the long it was aimed at');
});

test('an exchange with an unknown side convention is refused, not guessed', async () => {
  // Sending the wrong index could open a short where a long was meant.
  await assert.rejects(
    executeTrade(
      validateTradeRequest({ exchange: 'fake', symbol: 'BTC/USDT:USDT', side: 'buy' },
        { fake: hedgeExchange() }),
      { config: { ...baseConfig, dryRun: false, hedgeMode: true }, dedupe: new DedupeCache(0),
        logger: { log() {}, warn() {}, error() {} }, requestId: 't' }
    ).then(() => { throw new Error('should have refused'); }, (e) => { throw e; }),
    (err) => err.status === 501 && /side index convention for fake is not known/.test(err.message)
  );
});

test('the plan says which side of a hedge it is', async () => {
  const result = await run({ exchange: 'bybit', symbol: 'BTC/USDT:USDT', side: 'sell' }, {
    config: hedgeCfg({ dryRun: true }),
    exchanges: hedged(hedgeExchange()),
  });
  assert.equal(result.plan.hedgeMode, true);
  assert.equal(result.plan.positionSide, 'sell');
});

/* ------------------------------------------------------------------ *
 * Runtime scanner settings
 *
 * The one API that can start an autonomous trader, so every field is
 * validated rather than merged, and a half-valid patch changes nothing.
 * ------------------------------------------------------------------ */

const { readSettings, applySettings, saveSettings, loadSettings, settingsPath } = require('../scannerapi');

const scannerCfg = {
  ...baseConfig,
  scanner: {
    enabled: false, execute: false, strategy: 'pattern',
    exchange: 'bybit', symbols: ['BTC/USDT:USDT'], timeframe: '1h', timeframes: ['1h'],
    intervalMs: 60_000,
    rules: { minRR: 1.5 },
    supertrend: { period: 10, multiplier: 3, rewardRisk: 2, minRR: 1.5 },
  },
};
const liveSettings = () => ({
  ...scannerCfg.scanner,
  symbols: [...scannerCfg.scanner.symbols],
  timeframes: [...scannerCfg.scanner.timeframes],
  rules: { ...scannerCfg.scanner.rules },
  supertrend: { ...scannerCfg.scanner.supertrend },
});
const venues = () => ({
  bybit: { id: 'bybit', market: (s) => { if (s !== 'BTC/USDT:USDT' && s !== 'ETH/USDT:USDT') throw new Error('no'); return {}; } },
  weex: { id: 'weex', market: (s) => { if (s !== 'BTC/USDT:USDT') throw new Error('no'); return {}; } },
});

test('a valid patch changes the running settings', () => {
  const s = liveSettings();
  applySettings(s, { strategy: 'supertrend', timeframe: '15m', enabled: true }, { exchanges: venues() });
  assert.equal(s.strategy, 'supertrend');
  assert.equal(s.timeframe, '15m');
  assert.equal(s.enabled, true);
  assert.equal(s.execute, false, 'fields not named are left alone');
});

test('an unknown setting is refused, not ignored', () => {
  // Silently dropping it leaves someone believing they changed something.
  const s = liveSettings();
  assert.throws(
    () => applySettings(s, { stratgy: 'supertrend' }, { exchanges: venues() }),
    (e) => e instanceof RequestError && /Unknown setting: stratgy/.test(e.message)
  );
  assert.equal(s.strategy, 'pattern', 'and nothing changed');
});

test('a half-valid patch changes nothing at all', () => {
  // Otherwise the scanner runs the new strategy against the old symbol.
  const s = liveSettings();
  assert.throws(
    () => applySettings(s, { strategy: 'supertrend', timeframe: 'banana' }, { exchanges: venues() }),
    RequestError
  );
  assert.equal(s.strategy, 'pattern', 'the valid half was not applied either');
  assert.equal(s.timeframe, '1h');
});

test('symbols are checked against the exchange that will poll them', () => {
  const s = liveSettings();
  assert.throws(
    () => applySettings(s, { symbols: ['ETH/USDT:USDT'], exchange: 'weex' }, { exchanges: venues() }),
    (e) => /not listed on weex/.test(e.message),
    'weex does not list it, so refuse now rather than failing hourly in the log'
  );
  applySettings(s, { symbols: ['ETH/USDT:USDT'], exchange: 'bybit' }, { exchanges: venues() });
  assert.deepEqual(s.symbols, ['ETH/USDT:USDT'], 'bybit does, so it is accepted');
});

test('an exchange with no credentials is refused', () => {
  const s = liveSettings();
  assert.throws(
    () => applySettings(s, { exchange: 'kraken' }, { exchanges: venues() }),
    (e) => /must be one this server has credentials for/.test(e.message)
  );
});

test('a reward multiple below the floor is refused as unusable', () => {
  // Every signal would be rejected as under-RR, which reads as the strategy
  // being broken rather than misconfigured.
  const s = liveSettings();
  assert.throws(
    () => applySettings(s, { strategy: 'supertrend', supertrend: { rewardRisk: 1 } }, { exchanges: venues() }),
    (e) => /below supertrend.minRR/.test(e.message)
  );
  applySettings(s, { strategy: 'supertrend', supertrend: { rewardRisk: 1, minRR: 1 } }, { exchanges: venues() });
  assert.equal(s.supertrend.rewardRisk, 1, 'lowering the floor with it is fine');
});

test('numeric settings are bounded', () => {
  const s = liveSettings();
  for (const bad of [{ period: 1 }, { period: 500 }, { period: 10.5 }, { multiplier: 0 }, { multiplier: 99 }]) {
    assert.throws(() => applySettings(s, { supertrend: bad }, { exchanges: venues() }), RequestError,
      `supertrend ${JSON.stringify(bad)} should be refused`);
  }
  assert.equal(s.supertrend.period, 10, 'and none of them stuck');
});

test('the readout says a runtime change does not survive a restart', () => {
  const s = liveSettings();
  applySettings(s, { strategy: 'supertrend' }, { exchanges: venues() });
  const out = readSettings(s, scannerCfg);
  assert.equal(out.strategy, 'supertrend', 'the live value');
  assert.equal(out.persistsAcrossRestart, false, 'and that it is in memory only');
  assert.equal(out.bootedWith.strategy, 'pattern',
    'alongside what the environment said, so the difference is visible');
});

test('the scanner endpoints require the token', async (t) => {
  const app = createApp({
    config: scannerCfg,
    getExchanges: venues,
    isReady: () => true,
    scannerSettings: liveSettings(),
    logger: { log() {}, warn() {}, error() {} },
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  assert.equal((await fetch(`${base}/api/scanner`)).status, 401);
  assert.equal((await fetch(`${base}/api/scanner`, { method: 'POST' })).status, 401);

  const auth = { 'X-Auth-Token': AUTH_TOKEN, 'Content-Type': 'application/json' };
  const got = await (await fetch(`${base}/api/scanner`, { headers: auth })).json();
  assert.equal(got.scanner.strategy, 'pattern');

  const put = await (await fetch(`${base}/api/scanner`, {
    method: 'POST', headers: auth, body: JSON.stringify({ strategy: 'supertrend', enabled: true }),
  })).json();
  assert.equal(put.scanner.strategy, 'supertrend');
  assert.equal(put.scanner.enabled, true);

  const bad = await fetch(`${base}/api/scanner`, {
    method: 'POST', headers: auth, body: JSON.stringify({ timeframe: '7s' }),
  });
  assert.equal(bad.status, 400, 'a bad value is a 400, with the reason');
});

test('the scanner watches every symbol against every timeframe', () => {
  const s = liveSettings();
  applySettings(s, { symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT'], timeframes: ['15m', '1h', '4h'] },
    { exchanges: venues() });
  assert.deepEqual(s.timeframes, ['15m', '1h', '4h']);
  assert.equal(s.symbols.length * s.timeframes.length, 6, 'six symbol/timeframe pairs per sweep');
});

test('timeframes accept a comma string as well as an array', () => {
  const s = liveSettings();
  applySettings(s, { timeframes: '5m, 1h ,1d' }, { exchanges: venues() });
  assert.deepEqual(s.timeframes, ['5m', '1h', '1d'], 'trimmed, and blanks dropped');
});

test('an unknown timeframe is refused, and the sweep size is capped', () => {
  const s = liveSettings();
  assert.throws(
    () => applySettings(s, { timeframes: ['1h', '7s'] }, { exchanges: venues() }),
    (e) => /"7s" is not a timeframe/.test(e.message)
  );
  assert.throws(
    () => applySettings(s, { timeframes: ['1m','3m','5m','15m','30m','1h','2h','4h','6h','12h'] }, { exchanges: venues() }),
    (e) => /limited to 9/.test(e.message),
    'a sweep that outlasts its own interval is not a useful setting'
  );
  assert.deepEqual(s.timeframes, ['1h'], 'and neither attempt changed anything');
});

test('/health says whether state actually survives a restart', async (t) => {
  // Attaching a Render disk and forgetting STATE_DIR leaves it mounted and
  // unused. The only symptom is the breaker rebuilding its baseline on every
  // boot, which is invisible until the day it cannot.
  const mk = async (stateDir) => {
    const app = createApp({
      config: { ...baseConfig, stateDir },
      getExchanges: () => ({}),
      isReady: () => true,
      logger: { log() {}, warn() {}, error() {} },
    });
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    t.after(() => server.close());
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/health`)).json();
    return body.state;
  };

  const missing = await mk('/no/such/directory/anywhere');
  assert.equal(missing.writable, false, 'a path that does not exist is not writable');
  assert.equal(missing.persistent, false, 'and cannot be persistent');

  const inApp = await mk(__dirname + '/..');
  assert.equal(inApp.writable, true, 'the app directory is writable');
  assert.equal(inApp.persistent, false,
    'but ephemeral on Render however writable — saying otherwise implies durability it does not have');

  const mounted = await mk(require('os').tmpdir());
  assert.equal(mounted.writable, true);
  assert.equal(mounted.persistent, true, 'a writable path outside the app directory counts as a mount');
});


/* ------------------------------------------------------------------ *
 * Settings persistence
 *
 * The dangerous direction is not losing an enable — it is losing a
 * DISABLE. Turn the scanner off in the UI, let Render move the instance,
 * and SCANNER_ENABLED=true would arm it again unattended.
 * ------------------------------------------------------------------ */

const os = require('os');
const fsp = require('fs');
const pathp = require('path');

/** Matches the inline { log(){} } stubs elsewhere, but keeps what was said. */
function quietLogger(warnings = null, errors = null) {
  return {
    log() {},
    warn(m) { if (warnings) warnings.push(m); },
    error(m) { if (errors) errors.push(m); },
  };
}

function tempStateDir() {
  const dir = fsp.mkdtempSync(pathp.join(os.tmpdir(), 'pd-state-'));
  test.after(() => { try { fsp.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

test('a disable survives a restart that the environment would have re-armed', () => {
  const stateDir = tempStateDir();
  // The environment says ON; the operator turns it OFF through the API.
  const cfg = { ...scannerCfg, stateDir, scanner: { ...scannerCfg.scanner, enabled: true } };
  const live = { ...liveSettings(), enabled: true };
  applySettings(live, { enabled: false }, { exchanges: venues() });
  assert.equal(saveSettings(live, cfg), true);

  // Restart: fresh settings built from the environment, which still says on.
  const rebooted = { ...liveSettings(), enabled: true };
  assert.equal(loadSettings(rebooted, cfg, { exchanges: venues(), logger: quietLogger() }), true);
  assert.equal(rebooted.enabled, false, 'the saved disable wins over SCANNER_ENABLED=true');
});

test('every saved field is restored, not just the flags', () => {
  const stateDir = tempStateDir();
  const cfg = { ...scannerCfg, stateDir };
  const live = liveSettings();
  applySettings(live, {
    strategy: 'supertrend', exchange: 'bybit', symbols: ['ETH/USDT:USDT'],
    timeframe: '15m', timeframes: ['15m', '4h'], execute: true,
    supertrend: { period: 14, multiplier: 2.5 },
  }, { exchanges: venues() });
  saveSettings(live, cfg);

  const rebooted = liveSettings();
  loadSettings(rebooted, cfg, { exchanges: venues(), logger: quietLogger() });
  assert.equal(rebooted.strategy, 'supertrend');
  assert.deepEqual(rebooted.symbols, ['ETH/USDT:USDT']);
  assert.equal(rebooted.timeframe, '15m', 'the single timeframe is restored too');
  assert.deepEqual(rebooted.timeframes, ['15m', '4h']);
  assert.equal(rebooted.execute, true);
  assert.equal(rebooted.supertrend.period, 14);
  assert.equal(rebooted.supertrend.multiplier, 2.5);
});

test('a saved file that the API would refuse is ignored, not applied', () => {
  // Hand-edited, or written by a build that allowed something this one does
  // not. Trusting it would let the file set what the endpoint rejects.
  const stateDir = tempStateDir();
  const cfg = { ...scannerCfg, stateDir };
  fsp.writeFileSync(
    pathp.join(stateDir, 'scanner-settings.json'),
    JSON.stringify({ enabled: true, timeframe: '7s', strategy: 'supertrend' })
  );
  const live = liveSettings();
  const warnings = [];
  assert.equal(loadSettings(live, cfg, { exchanges: venues(), logger: quietLogger(warnings) }), false);
  assert.equal(live.enabled, false, 'nothing from the bad file was applied');
  assert.equal(live.strategy, 'pattern');
  assert.match(warnings.join(' '), /rejected/);
});

test('a truncated settings file does not stop the server booting', () => {
  const stateDir = tempStateDir();
  const cfg = { ...scannerCfg, stateDir };
  fsp.writeFileSync(pathp.join(stateDir, 'scanner-settings.json'), '{"enabled": tr');
  const live = liveSettings();
  assert.equal(loadSettings(live, cfg, { exchanges: venues(), logger: quietLogger() }), false);
  assert.equal(live.enabled, false, 'boot config still applies');
});

test('with no state directory nothing is written and the API says so', () => {
  // No disk attached: the settings still change, but claiming they persist
  // would be the lie that matters.
  const cfg = { ...scannerCfg, stateDir: null };
  assert.equal(settingsPath(cfg), null);
  assert.equal(saveSettings(liveSettings(), cfg), false);
  assert.equal(loadSettings(liveSettings(), cfg, { exchanges: venues() }), false);
  assert.equal(readSettings(liveSettings(), cfg, { persists: false }).persistsAcrossRestart, false);
});

test('a failed write is reported rather than returning success', () => {
  const cfg = { ...scannerCfg, stateDir: pathp.join(tempStateDir(), 'a-file', 'nested') };
  fsp.writeFileSync(pathp.join(pathp.dirname(pathp.dirname(cfg.stateDir)), 'a-file'), 'not a directory');
  const errors = [];
  assert.equal(saveSettings(liveSettings(), cfg, quietLogger(null, errors)), false);
  assert.match(errors.join(' '), /will not survive a restart/);
});

test('the write is atomic, leaving no partial file behind', () => {
  const stateDir = tempStateDir();
  const cfg = { ...scannerCfg, stateDir };
  saveSettings(liveSettings(), cfg);
  const left = fsp.readdirSync(stateDir);
  assert.deepEqual(left, ['scanner-settings.json'], 'the temp file was renamed, not left in place');
  assert.doesNotThrow(() => JSON.parse(fsp.readFileSync(pathp.join(stateDir, 'scanner-settings.json'), 'utf8')));
});

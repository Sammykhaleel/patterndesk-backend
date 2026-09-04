# PatternDesk trading backend

Executes signals as market orders on ccxt-supported exchanges. Designed to sit
behind your alert scanner, not to be exposed to the open internet.

## Before anything else

If the previous `.env` was ever zipped, emailed, or committed, rotate every key
on both exchanges. Re-issue with **trade permission only** (no withdrawal) and
an **IP allowlist** for your server.

## Setup

```bash
cp .env.example .env
openssl rand -hex 32          # paste into AUTH_TOKEN
npm install
npm test
npm start
```

The server refuses to start on invalid config and prints every problem at once.

## Arming sequence

It ships disarmed. Move one step at a time and check `/health` between each.

1. `USE_TESTNET=true`, `DRY_RUN=true` — plans are computed and logged, nothing sent.
2. `USE_TESTNET=true`, `DRY_RUN=false` — real orders on Bybit testnet.
3. `USE_TESTNET=false`, `DRY_RUN=false` with the smallest workable
   `TRADE_BALANCE_PERCENTAGE` and a `MAX_POSITION_NOTIONAL_QUOTE` you would be
   comfortable losing entirely.

## API

### `GET /health`
Unauthenticated. Reports readiness, loaded exchanges, and whether the server is
on testnet and in dry run.

### `POST /api/trade`
Requires `X-Auth-Token` (or `Authorization: Bearer …`).

```json
{
  "exchange": "bybit",
  "symbol": "BTC/USDT:USDT",
  "side": "buy",
  "reduceOnly": false,
  "clientOrderId": "sig-btc-1h-1724668800"
}
```

`clientOrderId` is optional but recommended: derive it from
symbol + timeframe + candle timestamp so a retried alert is recognised as the
same signal instead of opening a second position.

Set `reduceOnly: true` to close an open position. The side must oppose the
position; the whole position is closed.

```bash
curl -X POST http://127.0.0.1:3000/api/trade \
  -H "Content-Type: application/json" \
  -H "X-Auth-Token: $AUTH_TOKEN" \
  -d '{"exchange":"bybit","symbol":"BTC/USDT:USDT","side":"buy"}'
```

Status codes: `400` malformed request, `401` bad token, `409` blocked by a
position guard, `422` size outside market limits, `429` rate limited, `500`
exchange or server failure (details in the log, not the response).

## Guards

| Guard | Behaviour |
|---|---|
| Auth | Constant-time token check on every trade request |
| CORS | Explicit origin allowlist, no wildcard |
| Rate limit | Fixed window per IP |
| Config validation | Startup fails on any invalid value; no silent fallbacks |
| Testnet verification | Startup fails if `setSandboxMode` did not actually change the endpoints |
| Dry run | Default on |
| Idempotency | Repeat signals inside `DEDUPE_TTL_MS` return the first result without re-ordering |
| Position cap | Order refused if it would push symbol exposure past `MAX_POSITION_NOTIONAL_QUOTE` |
| Flip protection | Opening against an existing opposite position is refused; close it explicitly |
| Stop loss | Attached to the entry order itself when `STOP_LOSS_PERCENT` is set |
| Market limits | Min/max amount and min notional checked before submission |
| Circuit breaker | Halts new positions for the UTC day at `MAX_DAILY_LOSS_PERCENT` or `MAX_CONSECUTIVE_LOSSES`. State persists to `STATE_DIR`; where there is no disk, the day's baseline is rebuilt from the exchange ledger instead. If neither works and orders are live, it halts rather than resetting |

## Sizing

`TRADE_BALANCE_PERCENTAGE` is a share of the free **margin** balance, expressed
as notional exposure. Margin consumed is roughly that divided by `LEVERAGE`.

Handled correctly for linear (USDT-settled), inverse (coin-settled), and
non-unit `contractSize` markets. The margin currency comes from `market.settle`.

## Deployment

Do not serve the frontend from this process — Netlify does that.

Two supported targets:

- **[Oracle Cloud Always Free VM](deploy/oracle/README.md)** — free, a fixed IP
  you can pin the exchange API key to, and with the scanner on it runs with no
  inbound port at all. `deploy/oracle/` has the provisioning script, the
  systemd unit, and the runbook.
- **Render** — `render.yaml` is a blueprint; point the dashboard at it. Simpler,
  but the free instance sleeps after 15 minutes idle (which stops the scanner)
  and the outbound IP is shared, so the exchange-side IP allowlist is unusable
  below a Pro workspace. The blueprint mounts a 1 GB disk at `/var/data` and
  sets `STATE_DIR` to it — without that the container's filesystem is ephemeral
  and every deploy resets the circuit breaker.

Anywhere else, the rules are the same: keep `BIND_HOST=127.0.0.1`, put Caddy or
nginx in front if anything needs to call in, and set `TRUST_PROXY=1` only when
a proxy is genuinely in front — otherwise a caller can forge `X-Forwarded-For`
and walk past the rate limiter.

Run under a supervisor. The process exits on any unhandled error rather than
continuing in an unknown state, so it needs something to restart it.
`deploy/oracle/patterndesk.service` is the hardened unit; note that it leaves
`MemoryDenyWriteExecute` off, because V8's JIT cannot start without W^X pages.

## Tests

`npm test` runs 30 tests covering sizing across market types, the NaN guard,
request validation, every position guard, idempotency, and the HTTP auth, CORS,
rate limit, and error-redaction layers. No network or credentials required.

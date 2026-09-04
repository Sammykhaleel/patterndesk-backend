# Running the backend on an Oracle Cloud Always Free VM

The alternative to `render.yaml`. Both still work; this one is free, and it can
run with **no inbound port open at all**, which Render cannot.

Three things make it a better home for a bot that moves money:

- **A fixed public IP.** Bybit API keys take an IP allowlist. On Render your
  outbound IP is shared and can change, so the allowlist is unusable and
  `AUTH_TOKEN` is the only thing between the internet and your balance. Here
  you can pin the key to one address.
- **No inbound port.** With the scanner on, nothing ever needs to call in. The
  process binds loopback and the VM exposes only SSH.
- **No sleeping.** Render's free instances stop after 15 minutes idle, which
  stops the scanner; `render.yaml` therefore pins `plan: starter`, which bills.

The cost is that you now own a machine: patches, reboots, and the reclamation
policy below are yours to think about.

---

## The decision you cannot undo

**Your tenancy's home region is chosen at signup and is permanent, and Always
Free compute exists only in the home region.**

**Bybit blocks US IP addresses.** A US home region gives you a VM that cannot
reach the exchange, and no way to move it. Pick Frankfurt, Amsterdam, Zurich,
London, Singapore, or Tokyo.

If you already have an OCI account homed in a US region, that account cannot
be used for this. Make a new one with the correct region — do not spend an
afternoon on it first and find out at the `loadMarkets` step.

## Creating the account

Sign up at <https://signup.cloud.oracle.com/>. Budget 15 minutes, plus up to a
few hours if verification stalls.

**1. Country/Territory, name, email.** The country here filters which home
regions you are offered later, and it should match your card's billing country
— a mismatch is the most common reason a signup is rejected.

**2. Verify the email, then set the password and cloud account name.** The
account name becomes part of your console URL and cannot be changed. Something
plain and permanent.

**3. Home region — the irreversible one.** Frankfurt, Amsterdam, Zurich,
London, Singapore, or Tokyo. Not a US region, for the reason above. Read the
dropdown carefully; it is grouped by country and the list is shorter than the
full region list.

If you have a free choice, Frankfurt and Amsterdam tend to have the deepest
Ampere A1 capacity, which is the resource you will actually be fighting for.

**4. Card verification.** Oracle needs a real **credit or debit card**. It will
reject virtual cards, single-use numbers, prepaid cards, and debit cards that
only work with a PIN. It places a temporary authorisation hold (about $1,
sometimes a little more) which drops off in three to five business days. You
are not charged, and you cannot be charged until you explicitly upgrade to a
paid account.

Billing address must match the card exactly. If signup fails with a vague
"we are unable to process your request", it is almost always this, the
country mismatch from step 1, or a VPN putting you in a different country from
the one you selected — turn the VPN off and retry.

**5. Wait for provisioning.** Usually minutes; occasionally a few hours, and
sometimes it lands in a manual review queue. The confirmation arrives by email.

### What you get, and what expires

Signup starts a **30-day trial with $300 of credits**. That is *separate* from
Always Free, and this is where people get caught: anything you build on trial
credits is deleted when the trial ends, while Always Free resources continue
indefinitely.

So when you create the VM, take the shapes marked **"Always Free eligible"** in
the Console. If you let it default to something larger because the trial
credits are covering it, the instance disappears in a month.

After the trial ends you are downgraded to Always Free automatically. You do
not have to do anything, and you are not charged.

### Before you go further

Check that A1 capacity actually exists in your region: Console → Compute →
Instances → Create, pick `VM.Standard.A1.Flex`, and see whether it errors with
"Out of host capacity". Better to learn that now than after writing a `.env`.
The fallback shape is in the next section.

## Shape

Ask for **VM.Standard.A1.Flex, 1 OCPU / 6 GB, arm64**. Comfortable for Node and
ccxt, and it leaves room inside the free allowance for a second instance.

Oracle halved the Always Free A1 allowance on 15 June 2026, from 4 OCPU / 24 GB
down to 2 OCPU / 12 GB, without announcing it. Existing instances above the new
limit were shut down. Staying at 1 OCPU / 6 GB keeps you well clear of the
next cut.

A1 capacity is frequently exhausted — "Out of host capacity" is the normal
response in popular regions, not a fault. Retry over a few days, or take
**VM.Standard.E2.1.Micro** (1/8 OCPU, 1 GB, x86_64) instead. Everything here
works on it; `setup.sh` adds 2 GB of swap on that shape because `npm ci` runs
out of memory in 1 GB otherwise.

Image: **Ubuntu 24.04** or **Oracle Linux 9**. `setup.sh` handles both.

---

## Do you actually need a public port?

Answer this before creating the VM; it decides most of the rest.

| How signals reach the backend | Inbound port | TLS |
|---|---|---|
| `SCANNER_ENABLED=true` — the backend finds its own signals | none | none |
| You `curl` it from another machine | 3000, or 443 via Caddy | yes |
| The browser calls it from the Netlify site | 443 via Caddy | yes, and see below |

**Take the first row if you can.** The scanner is already in this codebase and
does the same job the browser path was reaching for. Nothing listens, so
nothing can be attacked, and `AUTH_TOKEN` protects a socket only the VM itself
can open.

### About the browser path

`src/main.js` calls the backend with no `X-Auth-Token` header, so every one of
those requests is a 401 today. That is the safe failure, and it is worth
understanding before "fixing" it: adding the token to frontend JavaScript
publishes it. Anyone who opens devtools on the Netlify site gets a credential
that opens leveraged positions on your account.

If a browser genuinely needs to trigger trades, the token cannot live in the
page — it needs a per-user session issued by something that authenticates the
user first. That is a feature, not a config change. Until then, leave the
scanner to do it server-side.

---

## Install

### 1. Create the instance

Console → Compute → Instances → Create. Shape and image as above. Add your SSH
public key (`~/.ssh/id_ed25519.pub`; generate with `ssh-keygen -t ed25519` if
you have none). Leave "Assign a public IPv4 address" on.

Note the public IP. It survives reboots and stop/start, but is released if you
ever *terminate* the instance — which means rebuilding the VM invalidates the
Bybit allowlist entry you are about to create.

### 2. Provision

```bash
ssh ubuntu@<vm-ip>          # opc@<vm-ip> on Oracle Linux
```

Copy the two files across and run the setup:

```bash
scp server/deploy/oracle/{setup.sh,patterndesk.service} ubuntu@<vm-ip>:~
ssh ubuntu@<vm-ip> 'sudo bash setup.sh'
```

That installs Node 22, creates the `patterndesk` system user, prepares
`/opt/patterndesk/server`, verifies clock sync, installs the hardened systemd
unit, and caps the journal at 200 MB. It leaves the port closed and the service
stopped — there are no credentials yet.

It is idempotent. Re-run it after an OS upgrade.

### 3. Deploy the code

From your own machine, anywhere in the repo:

```bash
bash server/deploy/oracle/deploy.sh ubuntu@<vm-ip>
```

Runs the test suite locally first, tars the server directory over SSH,
`npm ci --omit=dev` on the VM, restarts, and polls `/health`. Uses only `ssh`
and `tar`, so it works from Git Bash on Windows with no rsync.

**`.env` is never uploaded.** The keys live on the VM and nowhere else.

### 4. Credentials

```bash
ssh ubuntu@<vm-ip>
sudo -u patterndesk -H cp /opt/patterndesk/server/.env.example /opt/patterndesk/server/.env
sudo -u patterndesk -H nano /opt/patterndesk/server/.env
sudo chmod 600 /opt/patterndesk/server/.env
```

Generate the token on the VM so it never touches your laptop:

```bash
openssl rand -hex 32
```

For a scanner-only box, the values that differ from `.env.example`:

```ini
BIND_HOST=127.0.0.1
TRUST_PROXY=0
ALLOWED_ORIGINS=
SCANNER_ENABLED=true
SCANNER_EXECUTE=false
USE_TESTNET=true
DRY_RUN=true
```

Then start it:

```bash
sudo systemctl start patterndesk
journalctl -u patterndesk -f
```

### 5. Pin the API key to this VM

This is the step that makes the whole exercise worth it. In the Bybit dashboard,
edit the API key and restrict it to the VM's public IP. Trade permission only,
never withdrawal.

Now a leaked key is useless anywhere but this machine.

### 6. Arm it, one notch at a time

Follow the arming sequence in [../../README.md](../../README.md). Do not skip
it because the VM is new — testnet first, then live with `DRY_RUN=true`, then
the smallest `TRADE_BALANCE_PERCENTAGE` you can place, checking `/health` and
the log between each. `npm run check` is read-only and never places an order.

---

## The firewall trap

OCI filters twice, and forgetting the second layer is the most common way to
lose an hour here:

1. **VCN security list** (or a network security group) — Console side.
2. **The host firewall** — `iptables` on OCI's Ubuntu images, `firewalld` on
   Oracle Linux. Both images ship with a ruleset that rejects everything but
   SSH, which is not obvious from the Console.

`setup.sh` handles layer 2 only:

```bash
sudo EXPOSE_PORT=1 bash setup.sh    # open 3000
sudo EXPOSE_PORT=0 bash setup.sh    # close it again
```

Layer 1 stays a deliberate click in the Console. **Scanner-only deployments
should open neither.**

## TLS, if you do need to be called

[`Caddyfile`](./Caddyfile) puts Caddy in front on 443 with an automatic
Let's Encrypt certificate, and blocks `/health` from the outside — it reports
whether the bot is armed and how much it risks per trade.

Open **80 and 443** in both layers; port 80 is not optional, it is how the
certificate is issued and renewed. Keep `BIND_HOST=127.0.0.1` so Caddy is the
only public listener, and set `TRUST_PROXY=1` so the rate limiter buckets by
real client IP instead of lumping everyone into `127.0.0.1`.

With no domain, `<dashed-ip>.sslip.io` resolves to the IP in its own name and
Let's Encrypt will issue for it. Fine to get going; use a real name for
anything you keep.

## Idle reclamation

Oracle documents that Always Free compute instances **may be reclaimed** when,
across a 7-day window, *all* of these hold:

- 95th-percentile CPU utilisation below 20%
- network utilisation below 20%
- memory utilisation below 20% *(A1 shapes only)*

A scanner polling one symbol every 60 seconds is close to that profile, and a
reclaimed instance is a bot that silently stopped trading. Options, honestly:

- The criteria are **all-of**, so exceeding any single one is enough. On the
  1/8-OCPU E2.1.Micro, Node's ordinary work is a large share of a very small
  CPU allocation — that shape is the *less* likely of the two to be judged idle.
- Watch it. `/health` reports `secondsSinceScan`; something that pings it and
  tells you when it goes stale will catch a reclamation, a crash, and a Bybit
  outage alike.
- Upgrading to Pay As You Go while staying inside the Always Free limits is
  widely claimed to exempt you. Oracle's own documentation does not say so.
  Treat it as a rumour with a credit card attached.

Separately, an account left unused for 30 days may be suspended. Log in
occasionally.

---

## Operations

```bash
systemctl status patterndesk           # is it up
journalctl -u patterndesk -f           # follow
journalctl -u patterndesk -n 200       # recent history
journalctl -u patterndesk -S -1h       # last hour
curl -s localhost:3000/health | jq     # armed? scanner alive?

sudo systemctl restart patterndesk     # after editing .env
sudo systemctl stop patterndesk        # halt trading now
sudo systemctl disable --now patterndesk   # ...and keep it off across reboots
```

Update: edit locally, then `bash server/deploy/oracle/deploy.sh ubuntu@<vm-ip>`
again. It re-runs the tests, replaces the code, and restarts.

The unit gives up after 10 restarts in 5 minutes and shows as `failed`. That is
deliberate: transient exchange errors clear well inside that budget, but an
invalid `.env` never will, and a service crash-looping forever is easy to miss.
`systemctl status` will say so.

Uninstall:

```bash
sudo systemctl disable --now patterndesk
sudo rm /etc/systemd/system/patterndesk.service && sudo systemctl daemon-reload
sudo rm -rf /opt/patterndesk
sudo userdel -r patterndesk
```

## Keeping Render as a fallback

[`../../render.yaml`](../../render.yaml) is untouched and still deploys. The
environment variables are the same set, so a `.env` from this VM maps onto the
Render dashboard one-for-one — except `BIND_HOST` and `TRUST_PROXY`, which
Render detects on its own.

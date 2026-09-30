# AgentX Cloud Browser — PoC

EXPERIMENTAL. Runs headless Chromium on a GitHub Actions runner (dummy
account only), exposed through a Cloudflare Worker at ONE stable URL.

```
Phone/app ──https/wss + CLIENT_TOKEN──▶ Cloudflare Worker (stable URL)
                                            │  Durable Object binding
                                            ▼
                              BrowserRelay DO (singleton "browser-main",
                                               no KV — tracks the runner itself)
                                            ▲  one outbound WSS
                                            │  (/relay?secret=RELAY_SECRET)
                     GitHub runner: relay.py ─┴─▶ Chromium --headless (CDP 127.0.0.1:9222)
```

No third-party tunnel service. The runner opens a single outbound
WebSocket to the Durable Object; the DO relays CDP HTTP (`/json/*`) and
WebSocket (`/devtools/*`) between clients and whichever runner is
currently connected. Successor runners just open a new uplink — the DO
swaps it in with zero client-visible downtime.

Tunnel history (all dropped): cloudflared quick tunnels (edge 403-blocks
datacenter IPs, including Workers themselves), localhost.run (never prints
the URL without a terminal), pinggy (60-min free cap), ngrok (signup wants
a payment method), bore (URL printed but forwarded no data), tunnelmole
(URL fine, tunnel returned empty HTTP 500s).

## How it stays up (no GitHub cron)

GitHub kills every job before 6h. Instead of trusting GitHub's scheduler,
each run **dispatches its own successor** via the API at ~4h50m. The new
runner boots, connects its uplink, and takes over — the client always uses
the same Worker URL and never sees downtime. A watchdog (`cloud-browser-watchdog`,
every 30 min) re-dispatches if the chain ever breaks.

## Free-tier budget (Cloudflare)

- Workers: 100k requests/day — normal PoC use is far below.
- Durable Objects (free plan, SQLite backend): 100k requests/day,
  13,000 GB-s/day duration. The DO hibernates while idle (no duration
  billing); CDP traffic is tiny. Well within limits.
- KV: not used at all anymore (the DO holds runner state in memory).
- No signup, no payment, no extra account beyond Cloudflare + GitHub.

## Files

- `.github/workflows/browser.yml` — runner: Chromium + relay uplink + chain
- `runner/relay.py` — bridges local CDP to the DO over one outbound WSS
- `worker/worker.js` — the Worker + BrowserRelay Durable Object
- `worker/deploy-worker.py` — deploys via the Cloudflare API (DO binding
  with `new_sqlite_classes` migration — required on the free plan)

## Repo secrets

- `WORKER_URL` — the Worker's public URL (set after first deploy)
- `RELAY_SECRET` — must match the Worker's `RELAY_SECRET` secret

## Test (verified 2026-10-01)

```bash
curl https://<worker>/health                       # {"ok":true,"ts":...}
curl "https://<worker>/json/version?token=<TOKEN>"  # Chromium descriptor
```

End-to-end CDP verified: `GET /json/version` → 200 (Chrome/154.0.8037.57),
`PUT /json/new` → 200, CDP WebSocket navigated to example.com, page
loaded, PNG screenshot captured (780×493). Note: Cloudflare's edge
403-blocks Python's stdlib `Python-urllib/3.12` user agent — use a
browser-like UA (okhttp/Dart/curl/requests all fine, so the app is
unaffected).

## Notes

- Public repo = unlimited Actions minutes, but this pattern is against
  GitHub's Actions ToS for production use — dummy account only. Never run
  this on the account that builds/releases AgentX.
- The workflow commits `.heartbeat` on every run to keep the repo active.
- There is no public tunnel URL anymore — the only surface is the Worker,
  gated by CLIENT_TOKEN. The runner's uplink needs RELAY_SECRET.

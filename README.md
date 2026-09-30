# AgentX Cloud Browser — PoC

EXPERIMENTAL. Runs headless Chromium on a GitHub Actions runner (dummy
account only), exposed through a Cloudflare Worker at ONE stable URL.

```
Phone/app ──wss/https──▶ Cloudflare Worker (stable URL, token auth)
                              │  KV: current tunnel URL (cached in memory,
                              │      KV read at most once/60s per isolate)
                              ▼
                     GitHub runner: Chromium --headless
                              + ngrok tunnel (free tier)
```

## How it stays up (no GitHub cron)

GitHub kills every job before 6h. Instead of trusting GitHub's scheduler,
each run **dispatches its own successor** via the API at ~4h50m. The new
runner boots, registers its tunnel URL with the Worker, and takes over —
the client always uses the same Worker URL and never sees downtime.
A watchdog also re-dispatches if the chain ever breaks.

## Free-tier budget (Cloudflare)

- Workers: 100k requests/day — normal PoC use is far below.
- KV reads: 100k/day free. The Worker caches the backend URL in memory
  (60s TTL), so KV is read ~once/minute per isolate, not per request.
- KV writes: 1k/day free. We write ~5/day (once per runner restart).
- KV storage: 1GB free. We store ~100 bytes.

## Files

- `.github/workflows/browser.yml` — runner: Chromium + tunnel + register + chain
- `worker/worker.js` — the Worker (stable URL, token auth, WS proxy)
- `worker/deploy-worker.py` — deploys everything via the Cloudflare API

## Repo secrets

- `WORKER_URL` — the Worker's public URL (set after first deploy)
- `RELAY_SECRET` — must match the Worker's `RELAY_SECRET` secret
- `NGROK_AUTHTOKEN` — free ngrok account authtoken (ngrok.com dashboard)

## Test

```bash
curl https://<worker>/health                       # {"ok":true,"backend_age_s":42}
curl "https://<worker>/json/version?token=<TOKEN>"  # Chromium descriptor
```

Full CDP (navigate, screenshot) goes over
`wss://<worker>/devtools/...?token=<TOKEN>`.

## Notes

- Public repo = unlimited Actions minutes, but this pattern is against
  GitHub's Actions ToS for production use — dummy account only. Never run
  this on the account that builds/releases AgentX.
- The workflow commits `.heartbeat` on every run to keep the repo active.
- Quick-tunnel URLs are unguessable but not authenticated; the CLIENT_TOKEN
  at the Worker is the real gate. (cloudflared quick tunnels were dropped:
  their edge 403-blocks datacenter IPs, including the Worker itself, so the
  Worker could never reach them.) For anything beyond a PoC, add a
  token-checking sidecar on the runner in front of CDP.

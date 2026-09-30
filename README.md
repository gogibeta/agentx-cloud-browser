# AgentX Cloud Browser — PoC

EXPERIMENTAL. Runs headless Chromium on a GitHub Actions runner (dummy
account only), exposed through a Cloudflare Worker at ONE stable URL.

```
Phone/app ──wss/https──▶ Cloudflare Worker (stable URL, token auth)
                              │  KV: current tunnel URL
                              ▼
                     GitHub runner: Chromium --headless
                              + cloudflared quick tunnel
```

A new runner boots every 5h and registers its tunnel URL with the Worker
*before* the old job is killed at ~6h, so the client never sees downtime
and never needs to learn a new URL.

## Setup

### 1. Cloudflare Worker (dashboard, ~5 min)

1. Create a free Cloudflare account.
2. Workers & Pages → Create → Create Worker → paste `worker/worker.js` → Deploy.
3. Worker → Settings → Variables → Add secret variables:
   - `RELAY_SECRET` — random string, e.g. `openssl rand -hex 32`
   - `CLIENT_TOKEN` — random string, e.g. `openssl rand -hex 32`
4. Worker → Settings → Bindings → Add binding → KV namespace:
   - create namespace `BROWSER_BACKEND`, variable name `BACKEND`.
5. Note the Worker URL, e.g. `https://agentx-browser.<you>.workers.dev`.

### 2. Dummy GitHub account

1. Create a throwaway GitHub account (keeps any ToS risk off your main account).
2. Settings → Developer settings → Personal access tokens → Tokens (classic)
   → Generate new token (classic), scopes: `repo`, `workflow`.
   ⚠️ Do NOT paste the token in chat — enter it on the secure card Muse sends.
3. Create a **public** repo (public = unlimited Actions minutes), e.g.
   `agentx-cloud-browser`.
4. Repo → Settings → Secrets and variables → Actions → New repository secret:
   - `WORKER_URL` = your Worker URL (no trailing slash)
   - `RELAY_SECRET` = same value as in the Worker
5. Muse pushes this folder's files, then triggers the workflow
   (Actions → cloud-browser → Run workflow).

### 3. Test

```bash
# backend registered? (public, no URL leak)
curl https://<worker>/health
# {"ok":true,"backend_age_s":42}

# without token -> 401
curl https://<worker>/json/version
# with token -> Chromium descriptor, debugger URLs rewritten to the Worker
curl "https://<worker>/json/version?token=<CLIENT_TOKEN>"
```

Full CDP round-trip (navigate + screenshot) is done over
`wss://<worker>/devtools/...?token=<CLIENT_TOKEN>`.

## Notes / limits

- Each job is killed before 6h (GitHub limit); overlap keeps it continuous.
- Public repo = unlimited minutes, but this pattern is against GitHub's
  Actions ToS for production use — hence the dummy account. Never run this
  on the account that builds/releases AgentX.
- Scheduled workflows get disabled after 60 days of repo inactivity; the
  workflow commits `.heartbeat` on every run to prevent that.
- Free Worker plan: 100k requests/day. Fine for a PoC; heavy screenshot
  streaming would need watching.
- Quick-tunnel URLs are unguessable but not authenticated; the CLIENT_TOKEN
  at the Worker is the real gate. For anything beyond a PoC, add a
  token-checking sidecar on the runner in front of CDP.

/**
 * agentx-browser Worker — ONE stable URL in front of rotating GitHub runners.
 *
 * Setup (Cloudflare dashboard, no CLI needed):
 *   1. Workers & Pages -> Create Worker -> paste this file -> Deploy.
 *   2. Settings -> Variables -> Add secret variables:
 *        RELAY_SECRET  (runner registration secret, e.g. openssl rand -hex 32)
 *        CLIENT_TOKEN  (the token your app/tests must present)
 *   3. Settings -> Bindings -> Add binding -> KV namespace:
 *        create namespace "BROWSER_BACKEND", variable name BACKEND.
 *
 * API:
 *   POST /register   (runner only, Authorization: Bearer <RELAY_SECRET>)
 *                    body: {"url":"https://xxx.trycloudflare.com"}
 *   GET  /health     public, returns backend age only (never the URL)
 *   ALL  /*          requires ?token=<CLIENT_TOKEN> or
 *                    Authorization: Bearer <CLIENT_TOKEN>; proxies HTTP and
 *                    WebSocket (CDP) to the current backend, rewriting
 *                    debugger URLs to point back at this Worker.
 */

const BACKEND_KEY = "current";
// Tunnel providers: cloudflared quick tunnels are OUT (their edge 403s all
// datacenter IPs, including Cloudflare Workers themselves), so the runner
// uses an SSH reverse tunnel via localhost.run (no account needed).
const TUNNEL_RE = /^https:\/\/[a-z0-9.-]+\.(trycloudflare\.com|localhost\.run)\/?$/;

// Free-tier KV guard: the tunnel URL is cached in the Worker's memory and
// KV is read at most ONCE PER 60 SECONDS per Worker isolate, instead of on
// every proxied request. Writes happen ~5x/day (once per runner restart).
// Free KV limits: 100k reads/day, 1k writes/day, 1GB — we stay far below.
let cachedBackend = null; // {url, updated_at, fetched_at}
const BACKEND_CACHE_TTL_MS = 60_000;

async function getBackend(env) {
  const now = Date.now();
  if (cachedBackend && now - cachedBackend.fetched_at < BACKEND_CACHE_TTL_MS) {
    return cachedBackend;
  }
  let raw = await env.BACKEND.get(BACKEND_KEY);
  if (!raw) {
    // KV is eventually consistent across PoPs; one quick retry so a fresh
    // registration is not reported missing to the next request.
    await new Promise(r => setTimeout(r, 2000));
    raw = await env.BACKEND.get(BACKEND_KEY);
  }
  if (!raw) { cachedBackend = null; return null; }
  const b = JSON.parse(raw);
  cachedBackend = { url: b.url, updated_at: b.updated_at, fetched_at: now };
  return cachedBackend;
}

function clientToken(request) {
  const url = new URL(request.url);
  const q = url.searchParams.get("token");
  if (q) return q;
  const h = request.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : "";
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function rewriteDebuggerUrls(text, publicOrigin, backendUrl) {
  const wssOrigin = publicOrigin.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
  return text
    .split(backendUrl).join(publicOrigin)
    .split(backendUrl.replace(/^https:\/\//, "wss://")).join(wssOrigin)
    .replace(/ws:\/\/127\.0\.0\.1:9222/g, wssOrigin)
    .replace(/ws:\/\/localhost:9222/g, wssOrigin);
}

async function proxyWebSocket(clientRequest, backendUrl) {
  const upstreamUrl = backendUrl.toString()
    .replace(/^https:\/\//, "wss://")
    .replace(/^http:\/\//, "ws://");
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  let upstream;
  try {
    upstream = new WebSocket(upstreamUrl);
    await new Promise((resolve, reject) => {
      upstream.addEventListener("open", resolve, { once: true });
      upstream.addEventListener("error", reject, { once: true });
    });
  } catch (e) {
    try { server.close(1011, "backend unreachable"); } catch {}
    return new Response("backend unreachable", { status: 502 });
  }

  const closeBoth = () => {
    try { upstream.close(); } catch {}
    try { server.close(); } catch {}
  };
  server.addEventListener("message", (e) => { try { upstream.send(e.data); } catch {} });
  upstream.addEventListener("message", (e) => { try { server.send(e.data); } catch {} });
  server.addEventListener("close", closeBoth);
  server.addEventListener("error", closeBoth);
  upstream.addEventListener("close", closeBoth);
  upstream.addEventListener("error", closeBoth);

  return new Response(null, { status: 101, webSocket: client });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ---- runner registration ----
    if (request.method === "POST" && path === "/register") {
      const auth = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      if (!env.RELAY_SECRET || auth !== env.RELAY_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      let body;
      try { body = await request.json(); }
      catch { return new Response("bad json", { status: 400 }); }
      const backend = String(body.url || "").replace(/\/$/, "");
      if (!TUNNEL_RE.test(backend)) return new Response("bad url", { status: 400 });
      const record = { url: backend, updated_at: Date.now() };
      await env.BACKEND.put(BACKEND_KEY, JSON.stringify(record));
      cachedBackend = { ...record, fetched_at: Date.now() }; // serve fresh immediately
      return json({ ok: true });
    }

    // ---- public health (no URL leak) ----
    if (path === "/health") {
      const b = await getBackend(env);
      if (!b) return json({ ok: false, reason: "no backend registered" }, 503);
      return json({ ok: true, backend_age_s: Math.floor((Date.now() - b.updated_at) / 1000) });
    }

    // ---- everything else needs the client token ----
    const token = clientToken(request);
    if (!env.CLIENT_TOKEN || token !== env.CLIENT_TOKEN) {
      return new Response("unauthorized", { status: 401 });
    }

    const b = await getBackend(env);
    if (!b) return new Response("no backend registered", { status: 502 });
    const backend = b.url;

    const fwd = new URL(backend + path);
    // forward query string minus our token param
    url.searchParams.forEach((v, k) => { if (k !== "token") fwd.searchParams.append(k, v); });

    if (request.headers.get("Upgrade") === "websocket") {
      return proxyWebSocket(request, fwd);
    }

    const headers = new Headers();
    const ct = request.headers.get("content-type");
    if (ct) headers.set("content-type", ct);
    const accept = request.headers.get("accept");
    if (accept) headers.set("accept", accept);

    let resp;
    try {
      resp = await fetch(fwd.toString(), {
        method: request.method,
        headers,
        body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
      });
    } catch {
      return new Response("backend unreachable", { status: 502 });
    }

    const text = rewriteDebuggerUrls(await resp.text(), url.origin, backend);
    return new Response(text, {
      status: resp.status,
      headers: { "content-type": resp.headers.get("content-type") || "application/json" },
    });
  },
};

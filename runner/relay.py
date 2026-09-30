#!/usr/bin/env python3
"""
Runner-side relay: bridges local Chromium CDP (127.0.0.1:9222) to the
Cloudflare Durable Object over one outbound WebSocket.

Protocol (JSON messages over the uplink WS):
  DO -> runner: {"type":"http","id":..,"method":..,"path":..,"body":..}
  runner -> DO: {"type":"http_res","id":..,"status":..,"body":..}
  DO -> runner: {"type":"ws_open","id":..,"path":..}      (open local CDP WS)
  DO -> runner: {"type":"ws_msg","id":..,"data":..}       (client -> Chromium)
  DO -> runner: {"type":"ws_close","id":..}               (client disconnected)
  runner -> DO: {"type":"ws_msg","id":..,"data":..}       (Chromium -> client)
  runner -> DO: {"type":"ws_closed","id":..}              (local CDP WS closed)

Env: WORKER_URL (https://agentx-browser.<sub>.workers.dev), RELAY_SECRET.
Auto-reconnects with backoff; exits non-zero only if Chromium itself is gone.
"""
import asyncio
import json
import os
import sys
import urllib.error
import urllib.request

try:
    import websockets
except ImportError:
    sys.exit("websockets package missing: pip install websockets")

CHROME_HTTP = "http://127.0.0.1:9222"
CHROME_WS = "ws://127.0.0.1:9222"
WORKER_URL = os.environ["WORKER_URL"].rstrip("/")
RELAY_SECRET = os.environ["RELAY_SECRET"]
RELAY_WS = WORKER_URL.replace("https://", "wss://").replace("http://", "ws://") \
    + "/relay?secret=" + RELAY_SECRET


def fetch_chrome(method, path, body):
    url = CHROME_HTTP + path
    data = body.encode() if body else None
    req = urllib.request.Request(url, data=data, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        try:
            return e.code, e.read().decode("utf-8", "replace")
        except Exception:
            return e.code, ""
    except Exception as e:
        return 502, json.dumps({"error": str(e)[:200]})


async def pump_local_to_uplink(local_ws, uplink, conn_id):
    try:
        async for msg in local_ws:
            await uplink.send(json.dumps({"type": "ws_msg", "id": conn_id, "data": msg}))
    except Exception:
        pass
    finally:
        try:
            await uplink.send(json.dumps({"type": "ws_closed", "id": conn_id}))
        except Exception:
            pass


async def run_once():
    local_conns = {}
    pumps = {}
    async with websockets.connect(RELAY_WS, max_size=32 * 1024 * 1024,
                                  ping_interval=20, ping_timeout=20) as uplink:
        print("relay: connected to DO", flush=True)
        async for raw in uplink:
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            t = msg.get("type")
            if t == "http":
                loop = asyncio.get_running_loop()
                status, body = await loop.run_in_executor(
                    None, fetch_chrome, msg["method"], msg["path"], msg.get("body"))
                await uplink.send(json.dumps(
                    {"type": "http_res", "id": msg["id"], "status": status, "body": body}))
            elif t == "ws_open":
                conn_id = msg["id"]
                try:
                    local = await websockets.connect(
                        CHROME_WS + msg["path"], max_size=32 * 1024 * 1024,
                        ping_interval=20, ping_timeout=20)
                except Exception as e:
                    await uplink.send(json.dumps(
                        {"type": "ws_closed", "id": conn_id}))
                    print(f"relay: local ws_open failed: {e}", flush=True)
                    continue
                local_conns[conn_id] = local
                pumps[conn_id] = asyncio.create_task(
                    pump_local_to_uplink(local, uplink, conn_id))
            elif t == "ws_msg":
                local = local_conns.get(msg["id"])
                if local is not None:
                    try:
                        await local.send(msg["data"])
                    except Exception:
                        pass
            elif t == "ws_close":
                conn_id = msg["id"]
                local = local_conns.pop(conn_id, None)
                pump = pumps.pop(conn_id, None)
                if pump:
                    pump.cancel()
                if local is not None:
                    try:
                        await local.close()
                    except Exception:
                        pass


async def main():
    backoff = 2
    while True:
        # Bail out permanently if Chromium itself is unreachable.
        try:
            urllib.request.urlopen(CHROME_HTTP + "/json/version", timeout=5).read()
        except Exception as e:
            print(f"relay: chromium unreachable, exiting: {e}", flush=True)
            sys.exit(1)
        try:
            await run_once()
        except Exception as e:
            print(f"relay: uplink lost ({e}), retrying in {backoff}s", flush=True)
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 60)


if __name__ == "__main__":
    asyncio.run(main())

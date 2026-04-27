#!/usr/bin/env python3
"""Public-facing UK Amazon Locker map.

Default behaviour: serve the harvested `lockers.jsonl` to the browser.
On demand, individual lockers (or arbitrary lat/lng points) can be refreshed
by proxying to the live amazon.co.uk endpoint via `harvest_uk.fetch_locations`.

Run: python3 server.py [--host 0.0.0.0] [--port 8000]
"""
from __future__ import annotations

import argparse
import gzip
import json
import mimetypes
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from harvest_uk import APIError, fetch_locations, looks_real

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(ROOT, "web")
JSONL_PATH = os.path.join(ROOT, "lockers.jsonl")
KIOSKS_JSON_PATH = os.path.join(ROOT, "morrisons_kiosks.json")

_LOCKERS: dict[str, dict] = {}
_LOCKERS_LOCK = threading.Lock()
_LAST_REFRESHED: dict[str, float] = {}

# Fields the API returns but which were null in every record of the
# baseline harvest (15,435 records sampled). Stripped at serialization so
# they don't pollute the panel; if the API ever returns a non-null value,
# it's still kept verbatim — only nulls are dropped.
ALWAYS_NULL_FIELDS = frozenset({
    "cdexResponseDto",
    "ctaText",
    "ctaUrl",
    "delivery",
    "exceptionHours",
    "instructions",
    "isEligible",
    "landmark",
    "locationSelectorUrl",
    "programType",
    "promotionMessageInformation",
    "restrictionCode",
    "restrictionReasonCode",
})


def _strip_dead_nulls(rec: dict) -> dict:
    """Drop the always-null fields when (and only when) they're still null."""
    return {k: v for k, v in rec.items()
            if not (k in ALWAYS_NULL_FIELDS and v is None)}


def load_baseline() -> None:
    if not os.path.exists(JSONL_PATH):
        print(f"WARNING: {JSONL_PATH} not found — starting with empty baseline")
        return
    n = 0
    with open(JSONL_PATH, encoding="utf-8") as f:
        for line in f:
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            lid = rec.get("id") or rec.get("addressId") or rec.get("storeId")
            if lid:
                _LOCKERS[lid] = rec
                n += 1
    print(f"Loaded {n} lockers from {JSONL_PATH}")


def serialize_lockers() -> bytes:
    with _LOCKERS_LOCK:
        records = [_strip_dead_nulls(r) for r in _LOCKERS.values()]
        refreshed = dict(_LAST_REFRESHED)
    payload = {
        "count": len(records),
        "lockers": records,
        "refreshedAt": refreshed,
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def refresh_at(lat: float, lng: float) -> dict:
    """Proxy a single live API call, merge results into the in-memory store."""
    data = fetch_locations(lat, lng)
    locs = data.get("locationList") or []
    valid: list[dict] = []
    rejected = 0
    now = time.time()
    new_ids: list[str] = []
    updated_ids: list[str] = []
    with _LOCKERS_LOCK:
        for loc in locs:
            if not looks_real(loc, lat, lng):
                rejected += 1
                continue
            lid = loc.get("id") or loc.get("addressId") or loc.get("storeId")
            if not lid:
                continue
            valid.append(loc)
            (updated_ids if lid in _LOCKERS else new_ids).append(lid)
            _LOCKERS[lid] = loc
            _LAST_REFRESHED[lid] = now
    return {
        "query": {"lat": lat, "lng": lng},
        "received": len(locs),
        "rejected": rejected,
        "added": new_ids,
        "updated": updated_ids,
        "lockers": [_strip_dead_nulls(r) for r in valid],
        "raw": data,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "AmznLockerMap/0.1"

    def log_message(self, fmt, *args):
        sys.stderr.write(f"{self.address_string()} - {fmt % args}\n")

    # ---- low-level send helpers ------------------------------------------
    def _send_bytes(self, body: bytes, ctype: str, status: int = 200, gz_ok: bool = True) -> None:
        accept = self.headers.get("Accept-Encoding", "")
        do_gz = gz_ok and "gzip" in accept and len(body) > 1024
        if do_gz:
            body = gzip.compress(body)
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if do_gz:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, obj, status: int = 200) -> None:
        body = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self._send_bytes(body, "application/json", status=status)

    def _serve_static(self, path: str) -> None:
        # Defend against path traversal — resolve to within WEB_DIR only.
        safe = os.path.normpath(os.path.join(WEB_DIR, path))
        if not safe.startswith(os.path.realpath(WEB_DIR)):
            self.send_error(403, "Forbidden")
            return
        try:
            with open(safe, "rb") as f:
                body = f.read()
        except FileNotFoundError:
            self.send_error(404, "Not found")
            return
        ctype, _ = mimetypes.guess_type(safe)
        self._send_bytes(body, ctype or "application/octet-stream")

    # ---- routing ---------------------------------------------------------
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        u = urlparse(self.path)
        path, qs = u.path, parse_qs(u.query)
        try:
            if path == "/":
                return self._serve_static("index.html")
            if path.startswith("/static/"):
                return self._serve_static(path[len("/static/"):])
            if path == "/data/lockers.json":
                return self._send_bytes(serialize_lockers(), "application/json")
            if path == "/data/morrisons_kiosks.json":
                try:
                    with open(KIOSKS_JSON_PATH, "rb") as f:
                        return self._send_bytes(f.read(), "application/json")
                except FileNotFoundError:
                    return self._send_json(
                        {"count": 0, "kiosks": [],
                         "error": "morrisons_kiosks.json not found — run "
                                  "`python3 harvest_morrisons_kiosks.py`"},
                        status=404,
                    )
            if path.startswith("/api/locker/") and path.endswith("/refresh"):
                lid = path[len("/api/locker/"):-len("/refresh")]
                with _LOCKERS_LOCK:
                    rec = _LOCKERS.get(lid)
                if not rec:
                    return self._send_json({"error": "unknown locker id"}, status=404)
                loc = rec.get("location") or {}
                lat, lng = loc.get("latitude"), loc.get("longitude")
                if lat is None or lng is None:
                    return self._send_json({"error": "locker has no coordinates"}, status=400)
                try:
                    return self._send_json(refresh_at(float(lat), float(lng)))
                except APIError as e:
                    return self._send_json({"error": str(e)}, status=502)
            if path == "/api/refresh":
                try:
                    lat = float(qs.get("lat", [""])[0])
                    lng = float(qs.get("lng", [""])[0])
                except ValueError:
                    return self._send_json({"error": "lat and lng required"}, status=400)
                try:
                    return self._send_json(refresh_at(lat, lng))
                except APIError as e:
                    return self._send_json({"error": str(e)}, status=502)
            self.send_error(404, "Not found")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # noqa: BLE001 — top-level handler
            self.log_error("handler crash: %r", e)
            try:
                self.send_error(500, "Internal error")
            except Exception:
                pass


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()
    load_baseline()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Listening on http://{args.host}:{args.port}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("Shutting down…")
        srv.shutdown()


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Harvest Morrisons stores that host an Amazon self-service Returns Kiosk.

The kiosks (announced Dec 2025, ~350 sites rolling out into early 2026) are
return-only QR drop-off points and so don't appear in Amazon's
location_selector/fetch_locations endpoint that powers lockers.jsonl. They
ARE visible in Morrisons' own Gatsby-built store finder, where each store's
page-data lists the services it offers.

Pipeline:
  1. /storefinder/page-data/list/{a-y}/page-data.json  -> every store ID
  2. /storefinder/page-data/{id}/page-data.json        -> services + details
  3. keep stores whose `services` array contains `amazonReturnsKiosk`

Output: morrisons_kiosks.json
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE = "https://my.morrisons.com/storefinder/page-data"
LETTERS = "abcdefghijklmnopqrstuvwy"  # the set the storefinder itself exposes
KIOSK_SERVICE = "amazonReturnsKiosk"
LOCKER_SERVICE = "amazonLockers"

OUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "morrisons_kiosks.json")

HEADERS = {
    "Accept": "application/json",
    "User-Agent": "amzn-locker-map/harvest_morrisons_kiosks.py",
}
WORKERS = 10
MAX_RETRIES = 3


def fetch_json(url: str) -> dict:
    last: Exception | None = None
    for attempt in range(MAX_RETRIES):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            last = e
            time.sleep(0.5 * (attempt + 1))
    raise RuntimeError(f"GET {url} failed: {last!r}")


def list_all_store_ids() -> list[int]:
    ids: list[int] = []
    seen: set[int] = set()
    for letter in LETTERS:
        d = fetch_json(f"{BASE}/list/{letter}/page-data.json")
        for s in d["result"]["pageContext"].get("stores", []):
            sid = s.get("name")
            if isinstance(sid, int) and sid not in seen:
                seen.add(sid)
                ids.append(sid)
    return ids


def normalize(ctx: dict) -> dict:
    """Pull a stable subset of fields out of the page-data context."""
    services = [s.get("name") for s in ctx.get("services", []) if s.get("name")]
    departments = [
        {"name": d.get("name"), "openingTimes": d.get("openingTimes")}
        for d in ctx.get("departments", []) if d.get("name")
    ]
    addr = ctx.get("address") or {}
    loc = ctx.get("location") or {}
    return {
        "id": ctx.get("name"),
        "storeName": ctx.get("storeName"),
        "storeType": ctx.get("storeType"),
        "category": ctx.get("category"),
        "region": ctx.get("region"),
        "telephone": ctx.get("telephone"),
        "address": {
            "addressLine1": addr.get("addressLine1"),
            "addressLine2": addr.get("addressLine2"),
            "city": addr.get("city"),
            "county": addr.get("county"),
            "postcode": addr.get("postcode"),
            "country": addr.get("country"),
        },
        "location": {
            "latitude": loc.get("latitude"),
            "longitude": loc.get("longitude"),
        },
        "openingTimes": ctx.get("openingTimes"),
        "specialOpeningTimes": ctx.get("specialOpeningTimes"),
        "departments": departments,
        "services": services,
        "hasAmazonLocker": LOCKER_SERVICE in services,
        "storefinderUrl": f"https://my.morrisons.com/storefinder/{ctx.get('name')}/",
    }


def fetch_store(sid: int) -> dict | None:
    d = fetch_json(f"{BASE}/{sid}/page-data.json")
    ctx = d.get("result", {}).get("pageContext") or {}
    services = {s.get("name") for s in ctx.get("services", [])}
    if KIOSK_SERVICE not in services:
        return None
    return normalize(ctx)


def main() -> None:
    print("Enumerating Morrisons store IDs…")
    ids = list_all_store_ids()
    print(f"  {len(ids)} stores listed across {len(LETTERS)} letters")

    print(f"Fetching per-store page-data with {WORKERS} workers…")
    kiosks: list[dict] = []
    errors = 0
    started = time.time()
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(fetch_store, sid): sid for sid in ids}
        done = 0
        for fut in as_completed(futures):
            sid = futures[fut]
            done += 1
            try:
                rec = fut.result()
            except Exception as e:
                errors += 1
                print(f"  ! {sid}: {e}")
                continue
            if rec:
                kiosks.append(rec)
            if done % 50 == 0 or done == len(ids):
                print(f"  {done}/{len(ids)} stores checked, "
                      f"{len(kiosks)} kiosks so far ({errors} errors)")

    kiosks.sort(key=lambda r: (r.get("storeName") or "").lower())

    payload = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": BASE,
        "filterService": KIOSK_SERVICE,
        "totalStoresChecked": len(ids),
        "count": len(kiosks),
        "kiosks": kiosks,
    }
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    elapsed = time.time() - started
    print(f"Wrote {OUT_PATH}: {len(kiosks)} kiosks "
          f"(of {len(ids)} stores, {errors} errors) in {elapsed:.1f}s")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)

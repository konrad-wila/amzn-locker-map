#!/usr/bin/env python3
"""Fetch UK railway stations from the OpenStreetMap Overpass API and write
a lean GeoJSON-ish JSON file for the frontend.

Output: web/stations.json — { count, stations: [{name, lat, lng, kind, network}] }

Run: python3 fetch_stations.py        (idempotent — re-running re-fetches)
"""
from __future__ import annotations

import gzip
import json
import os
import sys
import urllib.parse
import urllib.request

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# National rail (railway=station + halt) plus Tube/DLR/Metro/Tram (station=subway/light_rail).
# Restricted to UK by ISO country code via Overpass's area filter.
QUERY = """
[out:json][timeout:90];
area["ISO3166-1"="GB"][admin_level=2]->.uk;
(
  node["railway"="station"](area.uk);
  node["railway"="halt"](area.uk);
  node["station"="subway"](area.uk);
  node["station"="light_rail"](area.uk);
);
out tags center;
"""

OUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "web", "stations.json")


def fetch() -> dict:
    body = urllib.parse.urlencode({"data": QUERY}).encode()
    req = urllib.request.Request(
        OVERPASS_URL,
        data=body,
        headers={
            "User-Agent": "amzn-locker-map/fetch_stations.py",
            "Accept-Encoding": "gzip",
        },
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        raw = resp.read()
        if resp.headers.get("Content-Encoding", "").lower() == "gzip":
            raw = gzip.decompress(raw)
    return json.loads(raw.decode("utf-8"))


def normalize(elements: list[dict]) -> list[dict]:
    seen: set[tuple] = set()
    out: list[dict] = []
    for el in elements:
        if el.get("type") != "node":
            continue
        lat, lng = el.get("lat"), el.get("lon")
        if lat is None or lng is None:
            continue
        tags = el.get("tags") or {}
        name = tags.get("name") or tags.get("ref") or ""
        if not name:
            continue
        # `kind` distinguishes national rail vs subway/light rail. Halts are
        # folded into rail since they're just small request stops.
        if tags.get("station") in ("subway", "light_rail"):
            kind = tags["station"]
        else:
            kind = "rail"
        key = (round(lat, 4), round(lng, 4), name, kind)
        if key in seen:
            continue
        seen.add(key)
        out.append({
            "name": name,
            "lat": lat,
            "lng": lng,
            "kind": kind,
            "network": tags.get("network") or tags.get("operator") or "",
        })
    out.sort(key=lambda s: s["name"])
    return out


def main() -> None:
    print("Querying Overpass…")
    raw = fetch()
    elements = raw.get("elements", [])
    print(f"  {len(elements)} elements returned")
    stations = normalize(elements)
    by_kind: dict[str, int] = {}
    for s in stations:
        by_kind[s["kind"]] = by_kind.get(s["kind"], 0) + 1
    print(f"  kept {len(stations)} unique stations:")
    for k, v in sorted(by_kind.items(), key=lambda kv: -kv[1]):
        print(f"    {k:12s} {v}")
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump({"count": len(stations), "stations": stations},
                  f, ensure_ascii=False, separators=(",", ":"))
    print(f"Wrote {OUT_PATH}")


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as e:
        sys.exit(f"Overpass HTTP {e.code}: {e.reason}")
    except urllib.error.URLError as e:
        sys.exit(f"Network error: {e.reason}")

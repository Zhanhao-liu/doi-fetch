"""School registry for 网瑞达 (WEngine / wrdvpn) WebVPN gateways.

Data compiled from the public scansci-pdf school list (Apache-2.0); every entry
can be overridden in ~/.doifetch/config.json if a gateway changes its crypto key.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

# 网瑞达's stock AES-128-CFB key. Gateways that never rotate it omit crypto_key.
DEFAULT_KEY = b"wrdvpnisthebest!"

_DATA_FILE = Path(__file__).parent / "data" / "schools.json"

# Friendly handles -> canonical name in schools.json
_ALIASES = {
    "ustc": "中国科学技术大学",
    "中科大": "中国科学技术大学",
    "科大": "中国科学技术大学",
    "中国科大": "中国科学技术大学",
    "pku": "北京大学",
    "thu": "清华大学",
    "zju": "浙江大学",
    "fdu": "复旦大学",
    "sjtu": "上海交通大学",
    "nju": "南京大学",
}


@dataclass(frozen=True)
class School:
    name: str
    province: str
    host: str
    key: bytes = DEFAULT_KEY
    iv: bytes | None = None

    @property
    def base(self) -> str:
        return self.host if self.host.startswith("http") else f"https://{self.host}"

    @property
    def iv_bytes(self) -> bytes:
        return self.iv or self.key

    @property
    def ticket_cookie_hint(self) -> str:
        """wengine names its session cookie wengine_vpn_ticket<escaped host>."""
        return "wengine_vpn_ticket" + self.host.replace("-", "_").replace(".", "_")


_cache: list[School] | None = None


def _load() -> list[School]:
    global _cache
    if _cache is not None:
        return _cache

    schools: list[School] = []
    try:
        raw = json.loads(_DATA_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raw = {}

    for province, entries in raw.items():
        if not isinstance(entries, dict):
            continue
        for name, info in entries.items():
            if not isinstance(info, dict):
                continue
            host = (info.get("host") or "").strip()
            if not host:
                continue
            key = (info.get("crypto_key") or "").encode() or DEFAULT_KEY
            iv_raw = (info.get("crypto_iv") or "").encode() or None
            schools.append(School(name=name, province=province, host=host, key=key, iv=iv_raw))

    schools.sort(key=lambda s: (s.province, s.name))
    _cache = schools
    return schools


def all_schools() -> list[School]:
    return list(_load())


def search(query: str) -> list[School]:
    q = (query or "").strip().lower()
    if not q:
        return []
    canonical = _ALIASES.get(q)
    if canonical:
        q = canonical.lower()
    hits = [
        s
        for s in _load()
        if q in s.name.lower() or q in s.province.lower() or q in s.host.lower()
    ]
    hits.sort(key=lambda s: (not s.name.lower().startswith(q), len(s.name)))
    return hits


def get(name_or_host: str) -> School:
    needle = (name_or_host or "").strip()
    if not needle:
        raise ValueError("school name is empty")

    canonical = _ALIASES.get(needle.lower())
    if canonical:
        needle = canonical

    schools = _load()
    for s in schools:
        if s.name == needle:
            return s
    for s in schools:
        if s.host == needle or s.host == needle.removeprefix("https://").removeprefix("http://"):
            return s

    hits = search(needle)
    if len(hits) == 1:
        return hits[0]
    if hits:
        # shortest name is usually the main campus, not a branch
        return sorted(hits, key=lambda s: len(s.name))[0]

    raise ValueError(
        f"school not found: {needle!r}. Try: doi-fetch schools <keyword>"
    )

#!/usr/bin/env python3
"""Query exact members or actual font codepoints in a generated SDK catalog."""

import argparse
import json
from pathlib import Path
import re
import sys


SCHEMA = "hdesign-sdk-symbol-catalog-v1"
DEFAULT_MAP = Path(__file__).resolve().parent.parent / "resources" / "symbol-catalog.json"


class QueryError(ValueError):
    """Invalid query or unsupported SDK catalog."""


def parse_codepoint(value):
    if not isinstance(value, str) or not re.fullmatch(r"(?:U\+|0x)?[0-9a-f]+", value, re.I):
        raise QueryError("codepoint must be hexadecimal, optionally prefixed by U+ or 0x")
    number = int(re.sub(r"^(?:U\+|0x)", "", value, flags=re.I), 16)
    if number > 0x10FFFF or 0xD800 <= number <= 0xDFFF:
        raise QueryError("codepoint must be a Unicode scalar, not a surrogate")
    return number


def normalize_query(kind, value):
    if kind == "text":
        if len(value) != 1 or 0xD800 <= ord(value) <= 0xDFFF:
            raise QueryError("--text requires exactly one Unicode scalar, not empty, multiple characters, or a surrogate")
        codepoint = ord(value)
    elif kind == "codepoint":
        codepoint = parse_codepoint(value)
    elif kind == "name":
        if not value or any(0xD800 <= ord(char) <= 0xDFFF for char in value):
            raise QueryError("--name requires a nonempty exact name without surrogates")
        return {"kind": kind, "input": value}, None
    else:
        raise QueryError("unknown query kind")
    return {"kind": kind, "input": value, "codepoint": f"U+{codepoint:04X}"}, codepoint


def load_map(path):
    document = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    if not isinstance(document, dict) or document.get("schema") != SCHEMA or document.get("source") != "local-harmonyos-sdk":
        raise QueryError("map must be an SDK catalog produced by build-symbol-catalog.py")
    if not isinstance(document.get("provenance"), dict) or not isinstance(document.get("metadata"), dict):
        raise QueryError("SDK catalog must retain provenance and metadata")
    data = document.get("data")
    entries = data.get("symbols") if isinstance(data, dict) else None
    if not isinstance(entries, list):
        raise QueryError("SDK catalog data.symbols must be an array")
    seen = set()
    for item in entries:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str) or not item["name"]:
            raise QueryError("each SDK entry requires a nonempty name")
        if item["name"] in seen:
            raise QueryError("SDK catalog must contain one entry per exact SDK name")
        seen.add(item["name"])
        if type(item.get("resource_id")) is not int or item["resource_id"] < 0:
            raise QueryError("each SDK entry requires a nonnegative integer resource ID")
        if not isinstance(item.get("codepoints"), list):
            raise QueryError("each SDK entry requires a codepoints array, possibly empty")
        for value in item["codepoints"]:
            parse_codepoint(value)
        sources = item.get("source_ids")
        if not isinstance(sources, list) or "sdk-sysresource" not in sources or any(source not in ("sdk-sysresource", "sdk-font-cmap") for source in sources):
            raise QueryError("each entry must originate from the SDK symbol member list")
        if item["codepoints"] and "sdk-font-cmap" not in sources:
            raise QueryError("codepoints must identify the SDK font cmap as their source")
        if item.get("support_version") is not None or item.get("mirror_unicode") is not None:
            raise QueryError("this SDK catalog schema does not establish per-symbol support versions or mirror relations")
    return document, entries


def lookup(kind, value, map_path=DEFAULT_MAP):
    query, codepoint = normalize_query(kind, value)
    document, entries = load_map(map_path)
    candidates = []
    for item in entries:
        actual = sorted({parse_codepoint(cp) for cp in item["codepoints"]})
        if (kind == "name" and item["name"] != value) or (kind != "name" and codepoint not in actual):
            continue
        candidates.append({
            "name": item["name"],
            "proposed_resource": "sys.symbol." + item["name"],
            "resource_id": item["resource_id"],
            "unicode": f"{codepoint:04X}" if kind != "name" else (f"{actual[0]:04X}" if len(actual) == 1 else None),
            "codepoints": [f"{cp:04X}" for cp in actual],
            "match_kind": "name" if kind == "name" else "cmap",
            "support_version": None,
            "support_version_known": False,
            "source_ids": sorted(set(item["source_ids"])),
            "sdk_name_present": True,
        })
    return {
        "source": document["source"],
        "source_version": document["metadata"].get("sdk_version"),
        "catalog_version": document.get("version"),
        "provenance": document["provenance"],
        "query": query,
        "candidates": sorted(candidates, key=lambda item: item["name"]),
        "verification": {
            "sdk_name_membership": "in_source_sdk_symbol_list",
            "binding": "not_performed",
            "design_font_identity": "not_checked",
            "sdk_runtime_support": "not_checked",
        },
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    inputs = parser.add_mutually_exclusive_group(required=True)
    inputs.add_argument("--text", help="exactly one Unicode scalar")
    inputs.add_argument("--codepoint", help="U+F01D5, 0xF01D5, or F01D5")
    inputs.add_argument("--name", help="exact SDK name, case-sensitive")
    parser.add_argument("--map", dest="map_path", type=Path, default=DEFAULT_MAP, help="generated SDK catalog JSON")
    args = parser.parse_args(argv)
    kind = next(key for key in ("text", "codepoint", "name") if getattr(args, key) is not None)
    try:
        result = lookup(kind, getattr(args, kind), args.map_path)
    except (QueryError, OSError, UnicodeError, json.JSONDecodeError) as error:
        parser.error(str(error))
    print(json.dumps(result, ensure_ascii=True, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())

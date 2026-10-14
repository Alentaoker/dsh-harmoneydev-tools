#!/usr/bin/env python3
"""Build a catalog from local SDK symbol members and the SDK font's best cmap."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys


SCHEMA = "hdesign-sdk-symbol-catalog-v1"
DEFAULT_OUTPUT = Path(__file__).resolve().parent.parent / "resources" / "symbol-catalog.json"


class CatalogError(ValueError):
    """Input cannot be interpreted without guessing or executing code."""


def parse_sdk_symbols(text):
    """Parse the SDK's unquoted-key numeric object literal; never execute JS."""
    match = re.fullmatch(r"\s*module\.exports\.sys\s*=\s*(\{[\s\S]*\})\s*;?\s*", text)
    if match is None or re.search(r"[^{}\s,:A-Za-z0-9_$]", match.group(1)):
        raise CatalogError("unsupported sysResource.js format; expected module.exports.sys = a numeric object literal")
    literal = re.sub(r"([A-Za-z_$][A-Za-z0-9_$]*)\s*:", r'"\1":', match.group(1))
    literal = re.sub(r",(\s*})", r"\1", literal)

    def reject_duplicate_keys(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise CatalogError(f"duplicate SDK key: {key}")
            result[key] = value
        return result

    try:
        data = json.loads(literal, object_pairs_hook=reject_duplicate_keys)
    except json.JSONDecodeError as error:
        raise CatalogError("sysResource.js contains an unsupported expression or object format") from error
    symbols = data.get("symbol") if isinstance(data, dict) else None
    if not isinstance(symbols, dict) or not symbols:
        raise CatalogError("sysResource.js must contain a nonempty symbol object")
    if any(not re.fullmatch(r"[A-Za-z_$][A-Za-z0-9_$]*", name) or type(value) is not int or value < 0
           for name, value in symbols.items()):
        raise CatalogError("SDK symbol members must map exact names to nonnegative integer resource IDs")
    return symbols


def read_font(path):
    try:
        from fontTools.ttLib import TTFont, TTLibError
    except ImportError as error:
        raise CatalogError("building requires fontTools; use a Python environment that already provides it") from error
    try:
        with Path(path).open("rb") as font_stream, TTFont(font_stream, lazy=True) as font:
            cmap = font.getBestCmap()
            if not cmap:
                raise CatalogError("font has no usable best cmap")
            if any(not isinstance(cp, int) or cp < 0 or cp > 0x10FFFF or 0xD800 <= cp <= 0xDFFF
                   or not isinstance(name, str) or not name for cp, name in cmap.items()):
                raise CatalogError("font cmap must contain Unicode scalars and nonempty glyph names")
            names = font["name"].names if "name" in font else []
            info = {label: sorted({record.toUnicode() for record in names if record.nameID == name_id})
                    for label, name_id in (("family_names", 1), ("version_strings", 5), ("postscript_names", 6))}
            return dict(cmap), info
    except TTLibError as error:
        raise CatalogError(f"cannot read the supplied font: {error}") from error


def file_provenance(path):
    path = Path(path).resolve()
    return {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def build_catalog(sdk_resource, font_path, sdk_metadata=None):
    sdk_resource, font_path = Path(sdk_resource), Path(font_path)
    symbols = parse_sdk_symbols(sdk_resource.read_text(encoding="utf-8-sig"))
    cmap, font_info = read_font(font_path)
    sdk_info, metadata_source = {}, None
    if sdk_metadata is not None:
        document = json.loads(Path(sdk_metadata).read_text(encoding="utf-8-sig"))
        if not isinstance(document, dict):
            raise CatalogError("SDK metadata must be a JSON object")
        sdk_info = {key: document[key] for key in ("version", "apiVersion", "platformVersion", "displayName", "releaseType") if key in document}
        metadata_source = dict(file_provenance(sdk_metadata), fields=sdk_info)

    by_name = {}
    for cp, name in cmap.items():
        if name in symbols:
            by_name.setdefault(name, []).append(cp)
    entries = []
    for name, resource_id in sorted(symbols.items()):
        codepoints = [f"{cp:04X}" for cp in sorted(by_name.get(name, []))]
        entries.append({
            "name": name,
            "resource_id": resource_id,
            "unicode": codepoints[0] if len(codepoints) == 1 else None,
            "codepoints": codepoints,
            "mirror_unicode": None,
            "support_version": None,
            "source_ids": ["sdk-sysresource"] + (["sdk-font-cmap"] if codepoints else []),
        })
    font_only_names = sorted(set(cmap.values()) - set(symbols))
    stats = {
        "sdk_symbol_count": len(symbols),
        "catalog_entries": len(entries),
        "font_cmap_entry_count": len(cmap),
        "sdk_symbols_with_codepoint": len(by_name),
        "sdk_symbols_without_codepoint": len(symbols) - len(by_name),
        "font_only_glyph_names_excluded": len(font_only_names),
        "font_only_cmap_entries_excluded": sum(name not in symbols for name in cmap.values()),
    }
    return {
        "schema": SCHEMA,
        "version": "sdk-catalog-1",
        "source": "local-harmonyos-sdk",
        "provenance": {
            "sdk_resource": dict(file_provenance(sdk_resource), member="module.exports.sys.symbol"),
            "font": dict(file_provenance(font_path), cmap="getBestCmap", **font_info),
            "sdk_metadata": metadata_source,
        },
        "metadata": {"sdk_version": sdk_info.get("version"), "api_version": sdk_info.get("apiVersion"), "stats": stats},
        "data": {"symbols": entries},
    }


def serialize(catalog):
    return json.dumps(catalog, ensure_ascii=False, indent=2) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk-resource", required=True, type=Path, help="local sysResource.js; parsed without execution")
    parser.add_argument("--font", required=True, type=Path, help="local SDK HMSymbolVF.ttf")
    parser.add_argument("--sdk-metadata", type=Path, help="optional SDK package JSON; not a per-symbol minimum-version source")
    parser.add_argument("--portable-provenance", action="store_true", help="record filenames and hashes instead of machine-specific absolute paths")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--source-output", type=Path, help="provenance manifest; defaults to symbol-source.json beside the catalog")
    args = parser.parse_args(argv)
    source_output = args.source_output or args.output.with_name("symbol-source.json")
    try:
        if args.output.resolve() == source_output.resolve():
            raise CatalogError("catalog and provenance manifest must use different output paths")
        catalog = build_catalog(args.sdk_resource, args.font, args.sdk_metadata)
        if args.portable_provenance:
            for source in catalog["provenance"].values():
                if source is not None:
                    source["path"] = Path(source["path"]).name
        payload = serialize(catalog)
        manifest = {"schema": SCHEMA, "source": catalog["source"], "version": catalog["version"],
                    "catalog": {"path": args.output.name if args.portable_provenance else str(args.output.resolve()), "sha256": hashlib.sha256(payload.encode("utf-8")).hexdigest()},
                    "provenance": catalog["provenance"], "metadata": catalog["metadata"]}
        args.output.write_text(payload, encoding="utf-8", newline="\n")
        source_output.write_text(serialize(manifest), encoding="utf-8", newline="\n")
    except (CatalogError, OSError, UnicodeError, json.JSONDecodeError) as error:
        parser.error(str(error))
    print(json.dumps({"output": str(args.output), "source_output": str(source_output), "stats": catalog["metadata"]["stats"]}, ensure_ascii=True, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())

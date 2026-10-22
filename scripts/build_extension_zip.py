"""Build the extension zip with forward-slash paths (portable across platforms)."""

import json
import zipfile
from pathlib import Path

ROOT = Path("extension")
BUILD = Path("_build")
BUILD.mkdir(exist_ok=True)

version = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))["version"]
out = BUILD / f"doi-fetch-extension-v{version}.zip"

with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for path in sorted(ROOT.rglob("*")):
        if path.is_file():
            archive.write(path, f"doi-fetch-extension/{path.relative_to(ROOT).as_posix()}")

print(f"wrote {out}  ({out.stat().st_size / 1024:.1f} KB)  version {version}")

with zipfile.ZipFile(out) as archive:
    names = archive.namelist()
    print("\nentries:")
    for name in names:
        print(f"  {name:44} {archive.getinfo(name).file_size:>8}")
    bad = [n for n in names if "\\" in n]
    print(f"\nbackslash entries: {bad or 'none'}")
    print(f"manifest at root : {'doi-fetch-extension/manifest.json' in names}")
    print(f"corrupt          : {archive.testzip() or 'no'}")

#!/usr/bin/env python3
"""Package an allowlisted extension, without tests, tooling, or browser data."""
import argparse
import hashlib
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parent


def main():
    version = json.loads((ROOT / "manifest.json").read_text())["version"]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path,
        default=ROOT.parents[1] / "build/release" / f"helium-glass-{version}.zip")
    args = parser.parse_args()
    files = ["manifest.json", "background.js", "shared.js", "palette.js", "content.js",
             "popup.html", "popup.css", "popup.js", "demo.html", "demo.css", "demo.js",
             "README.md", "LICENSE", *(f"icons/{size}.png" for size in (16, 32, 48, 128))]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(args.output, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for name in sorted(files):
            entry = ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.compress_type = ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, (ROOT / name).read_bytes())
    print(args.output.resolve())
    print(f"SHA256 {hashlib.sha256(args.output.read_bytes()).hexdigest()}")


if __name__ == "__main__":
    main()

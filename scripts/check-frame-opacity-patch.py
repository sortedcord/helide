#!/usr/bin/env python3
"""Check the experimental patch against pinned sources without compiling."""

import argparse
import concurrent.futures
import pathlib
import re
import subprocess
import tempfile
import urllib.request


ROOT = pathlib.Path(__file__).resolve().parents[1]
EXPERIMENT = "helium/linux/wayland-frame-opacity.patch"


def sections(text):
    for section in re.split(r"(?m)(?=^--- (?:a/|/dev/null))", text):
        match = re.search(r"^\+\+\+ b/(.+)$", section, re.MULTILINE)
        if match:
            yield match[1], section


def apply(work, text, reverse=False):
    command = ["patch", "-p1", "--batch", "--fuzz=0"]
    command.append("--reverse" if reverse else "--forward")
    result = subprocess.run(
        command, input=text, text=True, cwd=work, capture_output=True
    )
    if result.returncode:
        raise RuntimeError(result.stdout + result.stderr)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--patch",
        default=EXPERIMENT,
        choices=[
            EXPERIMENT,
            "helium/linux/wayland-frame-blur.patch",
            "helium/linux/wayland-web-content-transparency.patch",
            "helium/linux/wayland-web-content-lifecycle.patch",
        ],
    )
    selected = parser.parse_args().patch
    experiment = (ROOT / "patches" / selected).read_text()
    targets = {path for path, _ in sections(experiment)}
    previous = []
    found = False
    for folder in (ROOT / "helium-chromium/patches", ROOT / "patches"):
        for line in (folder / "series").read_text().splitlines():
            name = line.strip()
            if not name or name.startswith("#"):
                continue
            if folder == ROOT / "patches" and name == selected:
                found = True
                break
            previous.extend(
                (path, section)
                for path, section in sections((folder / name).read_text())
                if path in targets
            )
    if not found:
        raise RuntimeError("Experimental patch is missing from patches/series")

    created = {path for path, text in previous if text.startswith("--- /dev/null")}
    version = (ROOT / "helium-chromium/chromium_version.txt").read_text().strip()
    with tempfile.TemporaryDirectory(prefix="helium-frame-opacity-") as tmp:
        work = pathlib.Path(tmp)

        def fetch(path):
            url = f"https://raw.githubusercontent.com/chromium/chromium/{version}/{path}"
            with urllib.request.urlopen(url, timeout=60) as response:
                data = response.read()
            target = work / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)

        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(fetch, sorted(targets - created)))
        for path in created:
            (work / path).parent.mkdir(parents=True, exist_ok=True)
        for _, text in previous:
            apply(work, text)
        baseline = {path: (work / path).read_bytes() for path in targets}
        apply(work, experiment)
        apply(work, experiment, reverse=True)
        for path, original in baseline.items():
            if (work / path).read_bytes() != original:
                raise RuntimeError(f"Patch round trip changed {path}")
    print(
        f"PASS: {selected}, Chromium {version}, {len(targets)} files, "
        f"{len(previous)} existing patch sections; zero-fuzz apply/reverse. "
        "No build performed."
    )


if __name__ == "__main__":
    main()

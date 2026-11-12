#!/usr/bin/env python3
"""Write a patch from edits made in build/src.

The baseline for each file is the pinned upstream Chromium file plus every
patch that comes before it in the series, so the new patch applies on top of
them. build/src has domain substitution applied (fake hosts such as
cs.8n6r01d.qjz9zk). Lines that differ from upstream only by such a host are
not edits, and the upstream line is kept.

  scripts/generate-patch-from-build.py NAME.patch FILE... [--new FILE...]

NAME.patch is written to patches/helium/linux/. Add it to patches/series, then
run scripts/check-frame-opacity-patch.py --patch helium/linux/NAME.patch.
"""

import argparse
import concurrent.futures
import difflib
import pathlib
import re
import subprocess
import tempfile
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "build/src"
URL = re.compile(r"https?://\S+")
FAKE_HOST = re.compile(r"\S*(?:qjz9zk|8n6r01d|ch40m1um|9oo91e)\S*")


def sections(text):
    for section in re.split(r"(?m)(?=^--- (?:a/|/dev/null))", text):
        match = re.search(r"^\+\+\+ b/(.+)$", section, re.MULTILINE)
        if match:
            yield match[1], section


def apply(work, text):
    result = subprocess.run(
        ["patch", "-p1", "--batch", "--fuzz=0", "--forward"],
        input=text, text=True, cwd=work, capture_output=True,
    )
    if result.returncode:
        raise RuntimeError(result.stdout + result.stderr)


# Resource files hold many bare domains that substitution rewrote
# (pay.9oo91e.qjz9zk). Only for these, ignore any dotted word when matching.
LOOSE = re.compile(r"\S*\.\S*")


def diff_lines(a, b, path):
    norm = (lambda x: LOOSE.sub("@", x)) if path.endswith((".grd", ".grdp")) else (lambda x: URL.sub("@", x))
    ka = [norm(x) for x in a]
    kb = [norm(x) for x in b]
    merged = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, ka, kb, autojunk=False).get_opcodes():
        if tag == "equal":
            merged += [a[i1 + k] if FAKE_HOST.search(b[j1 + k]) else b[j1 + k] for k in range(j2 - j1)]
        elif tag == "replace" and i2 - i1 == j2 - j1:
            # A bare domain in a comment or string that substitution rewrote.
            merged += [
                a[i1 + k] if FAKE_HOST.search(b[j1 + k]) and LOOSE.sub("@", a[i1 + k]) == LOOSE.sub("@", b[j1 + k])
                else b[j1 + k]
                for k in range(j2 - j1)
            ]
        else:
            merged += b[j1:j2]
    return list(difflib.unified_diff(a, merged, f"a/{path}", f"b/{path}", n=3))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("name")
    parser.add_argument("files", nargs="*")
    parser.add_argument("--new", nargs="*", default=[])
    parser.add_argument(
        "--added-messages", nargs="*", default=[], metavar="IDS_NAME",
        help="grit messages this patch adds to a .grdp file. That file was also "
        "changed by name substitution, so its baseline is the current file "
        "without these messages.",
    )
    args = parser.parse_args()
    targets = set(args.files)
    version = (ROOT / "helium-chromium/chromium_version.txt").read_text().strip()

    previous = []
    for folder in (ROOT / "helium-chromium/patches", ROOT / "patches"):
        for line in (folder / "series").read_text().splitlines():
            name = line.strip()
            if not name or name.startswith("#"):
                continue
            if folder == ROOT / "patches" and name == f"helium/linux/{args.name}":
                break
            previous.extend(
                (path, section)
                for path, section in sections((folder / name).read_text())
                if path in targets
            )
    created = {path for path, text in previous if text.startswith("--- /dev/null")}

    out = []
    with tempfile.TemporaryDirectory(prefix="helium-genpatch-") as tmp:
        work = pathlib.Path(tmp)

        def fetch(path):
            url = f"https://raw.githubusercontent.com/chromium/chromium/{version}/{path}"
            with urllib.request.urlopen(url, timeout=60) as response:
                data = response.read()
            (work / path).parent.mkdir(parents=True, exist_ok=True)
            (work / path).write_bytes(data)

        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(fetch, sorted(targets - created)))
        for path in created:
            (work / path).parent.mkdir(parents=True, exist_ok=True)
        for _, text in previous:
            apply(work, text)

        for path in sorted(targets):
            a = (work / path).read_text().splitlines(keepends=True)
            b = (SRC / path).read_text().splitlines(keepends=True)
            if path.endswith(".grdp") and args.added_messages:
                text = (SRC / path).read_text()
                for name in args.added_messages:
                    text, n = re.subn(
                        r'(?ms)^ *<message name="%s".*?</message>\n' % re.escape(name), "", text)
                    if n != 1:
                        raise RuntimeError(f"{name} not found once in {path}")
                a = text.splitlines(keepends=True)
            d = diff_lines(a, b, path)
            if not d:
                print(f"warning: no change in {path}")
            out.append("".join(d))
        for path in sorted(args.new):
            b = (SRC / path).read_text().splitlines(keepends=True)
            out.append("".join(difflib.unified_diff([], b, "/dev/null", f"b/{path}", n=3)))

    text = ""
    for chunk in out:
        if chunk:
            text += chunk if chunk.endswith("\n") else chunk + "\n\\ No newline at end of file\n"
    dest = ROOT / "patches/helium/linux" / args.name
    dest.write_text(text)
    print(f"wrote {args.name}: {len(text.splitlines())} lines, {len(out)} files")


if __name__ == "__main__":
    main()

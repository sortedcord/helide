#!/usr/bin/env python3
"""Check page alpha through tab switches and navigation on native Wayland.

Requires Pillow, a built Helium and matching ChromeDriver. Uses a temporary
browser profile and local data pages; no existing browser profile is touched.
"""

import argparse
import base64
import io
import json
import pathlib
import socket
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request

from PIL import Image


ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "build/src/out/Default"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=pathlib.Path, default=OUT / "helium")
    parser.add_argument("--driver", type=pathlib.Path, default=OUT / "chromedriver")
    parser.add_argument("--opaque", action="store_true", help="check disabled mode")
    parser.add_argument("--pause", type=float, default=5, help="seconds in other tab")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="helium-alpha-check-") as tmp:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        with open(pathlib.Path(tmp) / "driver.log", "w+") as log:
            driver = subprocess.Popen(
                [str(args.driver.resolve()), f"--port={port}"],
                stdout=log, stderr=log,
            )
            session = None

            def request(method, path, data=None):
                body = None if data is None else json.dumps(data).encode()
                req = urllib.request.Request(
                    f"http://127.0.0.1:{port}{path}", data=body, method=method,
                    headers={"Content-Type": "application/json"},
                )
                with urllib.request.urlopen(req, timeout=90) as response:
                    return json.load(response)["value"]

            try:
                for _ in range(100):
                    try:
                        request("GET", "/status")
                        break
                    except OSError:
                        if driver.poll() is not None:
                            raise RuntimeError("ChromeDriver exited during startup")
                        time.sleep(0.1)
                options = {
                    "binary": str(args.binary.resolve()),
                    "args": [
                        "--ozone-platform=wayland",
                        f"--helium-transparent-web-content={0 if args.opaque else 1}",
                        "--no-first-run", "--no-default-browser-check",
                        "--window-size=1000,800", f"--user-data-dir={tmp}/profile",
                    ],
                }
                session = request("POST", "/session", {"capabilities": {
                    "alwaysMatch": {"browserName": "chrome", "goog:chromeOptions": options}
                }})["sessionId"]
                prefix = "/session/" + session

                def command(path, data):
                    return request("POST", prefix + path, data)

                def data_page(html):
                    return "data:text/html," + urllib.parse.quote(html)

                clear_page = data_page(
                    "<style>html,body{margin:0;background:transparent}"
                    "#solid{position:absolute;left:100px;top:100px;width:100px;"
                    "height:100px;background:rgb(23,101,201)}</style>"
                    '<div id="solid"></div>'
                )
                opaque_page = data_page("<style>body{background:white}</style>Opaque")

                def check(label):
                    time.sleep(0.5)
                    result = command("/goog/cdp/execute", {
                        "cmd": "Page.captureScreenshot", "params": {
                            "format": "png", "fromSurface": True,
                            "clip": {"x": 0, "y": 0, "width": 240, "height": 240, "scale": 1},
                        },
                    })
                    image = Image.open(io.BytesIO(base64.b64decode(result["data"]))).convert("RGBA")
                    scale = image.width / 240
                    clear = image.getpixel((round(10 * scale), round(10 * scale)))
                    solid = image.getpixel((round(150 * scale), round(150 * scale)))
                    expected_alpha = 255 if args.opaque else 0
                    assert clear[3] == expected_alpha, (label, "page backing", clear)
                    assert solid == (23, 101, 201, 255), (label, "opaque CSS", solid)
                    print(f"PASS {label}: background alpha={clear[3]}, opaque CSS={solid}", flush=True)

                command("/url", {"url": clear_page})
                check("initial")
                first = request("GET", prefix + "/window")
                other = command("/window/new", {"type": "tab"})["handle"]
                command("/window", {"handle": other})
                command("/url", {"url": opaque_page})
                time.sleep(args.pause)
                command("/window", {"handle": first})
                check("return from other tab")
                command("/refresh", {})
                check("reload after tab switch")
                command("/url", {"url": opaque_page})
                command("/url", {"url": clear_page})
                check("navigation back to transparent content")
            finally:
                if session:
                    try:
                        request("DELETE", "/session/" + session)
                    except OSError:
                        pass
                driver.terminate()
                try:
                    driver.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    driver.kill()
                    driver.wait()


if __name__ == "__main__":
    main()

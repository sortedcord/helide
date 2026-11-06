#!/usr/bin/env python3
"""Exercise the unpacked extension in native Wayland Helium, with an isolated profile.

Requires Pillow and a matching Helium/ChromeDriver build. All fixtures are local.
"""
import argparse
import base64
import io
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request

from PIL import Image

EXTENSION = Path(__file__).resolve().parents[1]
OUT = EXTENSION.parents[1] / "build/src/out/Default"
FIXTURE = """<!doctype html><meta charset=utf-8><title>Glass test</title>
<style nonce=fixture>
html,body{margin:0;min-height:100%;background:rgb(245,246,248);color:rgb(24,26,31)}
body{min-height:900px;padding:40px;box-sizing:border-box}
.card{background:rgb(255,255,255);width:230px;padding:20px;margin:10px}
.accent{background:rgb(0,95,230);color:white;width:160px;padding:20px}
button{background:rgb(255,255,255);color:black;padding:12px}
.gradient{background:linear-gradient(rgb(240,242,246),rgb(226,229,234));width:230px;height:60px}
.image{background:rgb(255,255,255) url('data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E');width:200px;height:50px}
html.dark,html.dark body{background:rgb(24,26,31);color:rgb(242,244,248)}
html.dark .card{background:rgb(38,40,46);color:rgb(242,244,248)}
iframe{width:220px;height:100px;border:0}
</style><div class=card id=card>Readable card</div>
<div class=card id=important style="background-color:rgb(255,255,255)!important">Inline important</div>
<div class=accent id=accent>Brand color</div><button id=button>Unchanged control</button>
<div class=gradient id=gradient></div><div class=image id=image></div>
<iframe id=frame src="http://localhost:PORT/frame"></iframe>
"""


class FixtureHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        page = ("<!doctype html><style>html,body{background:rgb(240,240,240);color:black}</style>Embedded surface"
                if self.path == "/frame" else FIXTURE.replace("PORT", str(self.server.server_port)))
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        if self.path == "/csp":
            self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'nonce-fixture'; style-src-attr 'unsafe-inline'; img-src data:; frame-src http://localhost:*")
        self.end_headers()
        self.wfile.write(page.encode())

    def log_message(self, *_args):
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=OUT / "helium")
    parser.add_argument("--driver", type=Path, default=OUT / "chromedriver")
    parser.add_argument("--artifacts", type=Path, help="optional directory for a popup screenshot")
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory(prefix="helium-glass-test-") as temp:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        with open(Path(temp) / "driver.log", "w+") as log:
            driver = subprocess.Popen([str(args.driver.resolve()), f"--port={port}"], stdout=log, stderr=log)
            session = None

            def request(method, path, data=None):
                req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method=method,
                    data=None if data is None else json.dumps(data).encode(), headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(req, timeout=60) as response:
                    value = json.load(response)["value"]
                    if isinstance(value, dict) and "error" in value:
                        raise RuntimeError(value)
                    return value

            try:
                for _ in range(100):
                    try:
                        request("GET", "/status")
                        break
                    except OSError:
                        if driver.poll() is not None:
                            raise RuntimeError("ChromeDriver exited during startup")
                        time.sleep(.1)
                session = request("POST", "/session", {"capabilities": {"alwaysMatch": {
                    "browserName": "chrome", "goog:chromeOptions": {
                        "binary": str(args.binary.resolve()), "args": [
                            "--ozone-platform=wayland", "--helium-transparent-web-content=1",
                            "--no-first-run", "--no-default-browser-check", "--window-size=1000,1000",
                            f"--user-data-dir={temp}/profile", f"--load-extension={EXTENSION}",
                            f"--disable-extensions-except={EXTENSION}",
                        ],
                    },
                }}})["sessionId"]
                prefix = "/session/" + session

                def command(path, data):
                    return request("POST", prefix + path, data)

                def js(script, *values):
                    return command("/execute/sync", {"script": script, "args": list(values)})

                def wait(script, label, *values):
                    end = time.monotonic() + 15
                    while time.monotonic() < end:
                        if js(script, *values):
                            print("PASS " + label, flush=True)
                            return
                        time.sleep(.15)
                    state = js("return [...document.querySelectorAll('html,body,[id]')].map(e=>[e.id||e.tagName,getComputedStyle(e).backgroundColor,e.getAttribute('data-helium-glass-surface')])")
                    raise AssertionError((label, state))

                style = "const c=getComputedStyle(document.querySelector(arguments[0])).backgroundColor;return c;"
                alpha = "const c=getComputedStyle(document.querySelector(arguments[0])).backgroundColor;const v=c.match(/[\\d.]+/g).map(Number);return v.length===4?v[3]:1;"
                url = f"http://127.0.0.1:{server.server_port}/csp"
                command("/url", {"url": url})
                wait("return document.body.hasAttribute('data-helium-glass-surface') && getComputedStyle(document.body).backgroundColor.startsWith('rgba(')", "page backgrounds styled under strict CSP")
                wait("return getComputedStyle(document.querySelector('#card')).backgroundColor.startsWith('rgba(')", "cards get translucent fills")
                assert js(alpha, "body") < .1
                assert 0 < js(alpha, "#card") < 1
                assert 0 < js(alpha, "#important") < 1, "USER CSS must override inline !important"
                assert js(style, "#accent") == "rgb(0, 95, 230)"
                assert js(style, "#button") == "rgb(255, 255, 255)"
                assert js("return getComputedStyle(document.querySelector('#gradient')).backgroundImage.includes('rgba(')")
                assert js("return getComputedStyle(document.querySelector('#image')).backgroundImage.includes('url(')")
                assert js("return getComputedStyle(document.querySelector('#card')).color") == "rgb(24, 26, 31)"
                print("PASS surfaces, gradients, inline !important; accents, controls, images and text preserved", flush=True)

                shot = command("/goog/cdp/execute", {"cmd": "Page.captureScreenshot", "params": {
                    "format": "png", "fromSurface": True,
                    "clip": {"x": 0, "y": 0, "width": 240, "height": 240, "scale": 1},
                }})
                image = Image.open(io.BytesIO(base64.b64decode(shot["data"]))).convert("RGBA")
                pixel = image.getpixel((round(10 * image.width / 240), round(10 * image.height / 240)))
                assert pixel[3] < 60, pixel
                print(f"PASS actual rendered page alpha={pixel[3]}/255", flush=True)
                initial_background = js(style, "body")
                for index in range(3):
                    js("document.documentElement.dataset.theme=arguments[0]", str(index))
                    time.sleep(.5)
                    assert js(style, "body") == initial_background, "rescanning must not compound alpha"
                print("PASS repeated scans retain the same background alpha", flush=True)
                js("const e=document.createElement('div');e.id='dynamic';e.className='card';e.textContent='New card';document.body.append(e)")
                wait("return document.querySelector('#dynamic').hasAttribute('data-helium-glass-surface')", "dynamic surfaces detected")
                js("document.documentElement.classList.add('dark')")
                wait("return getComputedStyle(document.body).backgroundColor.startsWith('rgba(24, 26, 31,')", "theme change uses original dark palette")
                wait("return getComputedStyle(document.querySelector('#card')).backgroundColor.startsWith('rgba(38, 40, 46,')", "cards follow the new theme")

                first = request("GET", prefix + "/window")
                targets = command("/goog/cdp/execute", {"cmd": "Target.getTargets", "params": {}})["targetInfos"]
                worker = next(t for t in targets if t["type"] == "service_worker" and t["url"].endswith("/background.js"))
                extension_url = worker["url"].rsplit("/", 1)[0]
                second = command("/window/new", {"type": "tab"})["handle"]
                command("/window", {"handle": second})
                command("/url", {"url": extension_url + "/popup.html"})
                wait("return document.querySelector('#globalToggle').checked", "popup loads with persisted defaults")
                if args.artifacts:
                    args.artifacts.mkdir(parents=True, exist_ok=True)
                    height = js("return document.body.scrollHeight")
                    shot = command("/goog/cdp/execute", {"cmd": "Page.captureScreenshot", "params": {
                        "format": "png", "fromSurface": True,
                        "clip": {"x": 0, "y": 0, "width": 340, "height": height, "scale": 1},
                    }})
                    (args.artifacts / "popup.png").write_bytes(base64.b64decode(shot["data"]))

                def settings(value):
                    command("/window", {"handle": second})
                    result = command("/execute/async", {"script": "const done=arguments[arguments.length-1];chrome.storage.local.set({settings:arguments[0]}).then(()=>done('ok'),e=>done(e.message));", "args": [value]})
                    assert result == "ok", result
                    command("/window", {"handle": first})

                settings({"sites": {f"127.0.0.1:{server.server_port}": False}})
                wait("return !document.querySelector('[data-helium-glass-surface]') && getComputedStyle(document.body).backgroundColor==='rgb(24, 26, 31)'", "site opt-out restores original page styles")
                frame = js("return document.querySelector('#frame')")
                command("/frame", {"id": frame})
                wait("return !document.querySelector('[data-helium-glass-surface]')", "site opt-out includes cross-origin embedded frames")
                command("/frame", {"id": None})
                settings({"enabled": True, "transparency": 80})
                wait("return document.body.hasAttribute('data-helium-glass-surface') && getComputedStyle(document.body).backgroundColor.startsWith('rgba(')", "re-enable restores transparency")
                frame = js("return document.querySelector('#frame')")
                command("/frame", {"id": frame})
                wait("return document.body.hasAttribute('data-helium-glass-surface')", "cross-origin embedded surfaces are styled")
                command("/frame", {"id": None})
                settings({"enabled": False})
                wait("return !document.querySelector('[data-helium-glass-surface]') && getComputedStyle(document.body).backgroundColor==='rgb(24, 26, 31)'", "global disable restores original styles")
                settings({"transparency": 0})
                wait("return !document.querySelector('[data-helium-glass-surface]')", "zero transparency keeps original styles")
                settings({"transparency": 65})
                command("/refresh", {})
                wait("return document.body.hasAttribute('data-helium-glass-surface')", "settings survive reload")
                print("All Helium Glass browser checks passed.", flush=True)
            except Exception:
                log.flush(); log.seek(0)
                print(log.read()[-5000:], flush=True)
                raise
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
                    driver.kill(); driver.wait()
                server.shutdown()


if __name__ == "__main__":
    main()

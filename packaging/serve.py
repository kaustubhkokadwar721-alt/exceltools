#!/usr/bin/env python3
"""Serve the ExcelTools offline build from this folder.

Everything runs on this machine — no file ever leaves the device. A tiny local
web server is used because browsers need an http:// origin (not a bare file://)
to run Web Workers, WebAssembly and the offline service worker.

Usage:
    python serve.py         (or: python3 serve.py)

Then open the printed address if your browser does not open automatically.
Set a different port with:  PORT=9000 python serve.py
"""
import http.server
import os
import socketserver
import sys
import webbrowser

BASE_PORT = int(os.environ.get("PORT", "8000"))
os.chdir(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".wasm": "application/wasm",
        ".json": "application/json",
        ".webmanifest": "application/manifest+json",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
    }

    # Security headers. The app already carries a Content-Security-Policy in its
    # own <meta> tag, but a few protections can only be set as real headers —
    # notably frame-ancestors, which a meta tag cannot express. Serving the
    # offline copy through this launcher is therefore slightly stronger than
    # serving it from a static host that sets no headers at all.
    SECURITY_HEADERS = {
        # Nothing may frame this page: no clickjacking a click onto a control
        # that exports or clears a user's data.
        "Content-Security-Policy": "frame-ancestors 'none'",
        "X-Frame-Options": "DENY",  # for anything that predates frame-ancestors
        # Never let the browser second-guess a declared type into something
        # executable.
        "X-Content-Type-Options": "nosniff",
        # This app has no outbound requests at all; make the intent explicit.
        "Referrer-Policy": "no-referrer",
        # It needs none of these. Denying them is a statement an IT reviewer can
        # verify in one look.
        "Permissions-Policy": (
            "camera=(), microphone=(), geolocation=(), usb=(), serial=(), "
            "bluetooth=(), payment=(), interest-cohort=()"
        ),
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        for name, value in self.SECURITY_HEADERS.items():
            self.send_header(name, value)
        super().end_headers()

    def log_message(self, *args):
        pass  # keep the console quiet


def main():
    port = BASE_PORT
    httpd = None
    for _ in range(25):
        try:
            httpd = socketserver.TCPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            port += 1
    if httpd is None:
        print("Could not find a free port. Close other servers and try again.")
        sys.exit(1)

    url = "http://127.0.0.1:%d/" % port
    print("ExcelTools is running at %s" % url)
    print("Leave this window open while you use it. Press Ctrl+C to stop.")
    try:
        webbrowser.open(url)
    except Exception:
        pass
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()

"""Static server for local dev that never lets the browser cache.

    python dev_server.py          # serves this folder on http://localhost:8777

Use this instead of `python -m http.server` so edits show on a plain reload.
Threaded, reuses the address, and exits cleanly so a restart never hits a
"port already in use" from a lingering socket.
"""
import contextlib
import http.server
import pathlib
import socketserver
import sys

PORT = 8777
ROOT = pathlib.Path(__file__).resolve().parent


class NoCache(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Expires", "0")
        super().end_headers()

    def send_header(self, key, value):
        if key.lower() in ("last-modified", "etag"):
            return
        super().send_header(key, value)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    with Server(("127.0.0.1", PORT), NoCache) as httpd:
        print(f"serving {ROOT} on http://localhost:{PORT} (no cache)", flush=True)
        with contextlib.suppress(KeyboardInterrupt):
            httpd.serve_forever()


if __name__ == "__main__":
    main()

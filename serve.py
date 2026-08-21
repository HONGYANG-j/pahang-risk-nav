"""Dev server for the prototype, with caching disabled.

`python -m http.server` sends Last-Modified, and browsers cache ES modules
aggressively -- so editing a module and reloading can silently keep running the
OLD file (you get phantom "export not found" errors against code you just
fixed). This serves everything with no-store, so a plain reload always picks up
fresh code.

    python serve.py [port]        # defaults to 8080
"""
import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    root = os.path.dirname(os.path.abspath(__file__))
    handler = partial(NoCacheHandler, directory=root)
    print(f"Serving {root} at http://localhost:{port} (caching disabled)")
    ThreadingHTTPServer(("", port), handler).serve_forever()

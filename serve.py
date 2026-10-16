#!/usr/bin/env python3
"""Serve Cairn locally with browser caching turned off, so a plain reload always runs the latest code.

    python3 serve.py [port]    (default 8080)
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class NoCache(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
handler = partial(NoCache, directory=Path(__file__).resolve().parent)
print(f'Cairn on http://localhost:{port}')
ThreadingHTTPServer(('', port), handler).serve_forever()

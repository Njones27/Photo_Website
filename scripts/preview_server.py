"""Serve site/ locally, wrapping each .html page in the same skeleton the Artifact host adds."""
import http.server, os, sys
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "site")
HEAD = (b'<!doctype html><html><head><meta charset="utf-8">'
        b'<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
        b'<style>:root{padding:env(safe-area-inset-top,0) 0 env(safe-area-inset-bottom,0)}body{margin:0;font:14px system-ui}'
        b'img{max-width:100%}[hidden]{display:none!important}</style></head><body>')
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def do_GET(self):
        path = self.translate_path(self.path.split("?")[0])
        if path.endswith(".html") and os.path.isfile(path):
            body = HEAD + open(path, "rb").read() + b"</body></html>"
            self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
        else: super().do_GET()
http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 8765), H).serve_forever()

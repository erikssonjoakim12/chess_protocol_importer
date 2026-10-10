"""Open the app on this computer:  python run.py
                                  python run.py --lan   (also from your phone on the same Wi-Fi)

The app is just the files in web/ and runs entirely in the browser; this only
serves those files locally (browsers don't run apps straight from a folder).
"""
import argparse
import functools
import http.server
import mimetypes
import os
import socket
import threading
import webbrowser

WEB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")

# Windows sometimes maps .js to text/plain, which browsers refuse for modules.
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("application/json", ".json")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("application/manifest+json", ".webmanifest")


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".json": "application/json",
                      ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json"}

    def end_headers(self):
        # Always the latest files while developing.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *args):
        pass


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))  # no traffic is sent; this just picks the right interface
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def main():
    parser = argparse.ArgumentParser(description="Serve the app locally")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--lan", action="store_true", help="listen on the local network too")
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    host = "0.0.0.0" if args.lan else "127.0.0.1"
    try:
        server = http.server.ThreadingHTTPServer((host, args.port), functools.partial(Handler, directory=WEB))
    except OSError:
        print("\n  Port %d is already in use, probably by the app itself in another window"
              "\n  (or an old copy still running). Just open http://127.0.0.1:%d, or close"
              "\n  the other window and start again.\n" % (args.port, args.port))
        return
    url = "http://127.0.0.1:%d" % args.port
    print("\n  Open %s" % url)
    if args.lan:
        print("  From your phone (same Wi-Fi): http://%s:%d" % (lan_ip(), args.port))
        print("  (Some phone features, like installing the app, need the published https version.)")
    print("  Close this window or press Ctrl+C to stop.\n")
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

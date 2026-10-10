"""Start the app:  python run.py            (this computer only)
                  python run.py --lan      (also reachable from your phone on the same Wi-Fi)
                  python run.py --mock     (no API key needed: returns a saved example game)
"""
import argparse
import os
import socket
import threading
import webbrowser

import uvicorn
from dotenv import load_dotenv


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
    parser = argparse.ArgumentParser(description="Scoresheet photo to PGN")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--lan", action="store_true", help="listen on the local network too")
    parser.add_argument("--mock", action="store_true", help="use the mock reader (no API calls)")
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    load_dotenv()
    if args.mock:
        os.environ["READER"] = "mock"
    host = "0.0.0.0" if args.lan else "127.0.0.1"
    url = "http://127.0.0.1:%d" % args.port
    print("\n  Open %s" % url)
    if args.lan:
        print("  From your phone (same Wi-Fi): http://%s:%d" % (lan_ip(), args.port))
    print("  Reader: %s   (Ctrl+C to stop)\n" % os.environ.get("READER", "gemini"))
    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    uvicorn.run("app.main:app", host=host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()

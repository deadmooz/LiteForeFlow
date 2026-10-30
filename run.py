#!/usr/bin/env python3
"""Start LiteForeFlow with Python.  Usage:  python run.py [--no-open] [--port 3000]

Only the Python standard library is used. It checks that Node.js is installed, installs the app the first time,
starts the server and opens your browser. (LiteForeFlow itself runs on Node.js; this is just a friendly launcher.)
"""
import argparse
import os
import shutil
import subprocess
import sys
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
WINDOWS = os.name == "nt"


def main():
    parser = argparse.ArgumentParser(description="Start LiteForeFlow")
    parser.add_argument("--no-open", action="store_true", help="do not open the browser")
    parser.add_argument("--port", type=int, help="port to listen on (default 3000, or the next free one)")
    args = parser.parse_args()

    # A private Node.js copy downloaded by start.bat / start.sh lives in ./runtime/node
    local = os.path.join(HERE, "runtime", "node") if WINDOWS else os.path.join(HERE, "runtime", "node", "bin")
    if os.path.isdir(local):
        os.environ["PATH"] = local + os.pathsep + os.environ.get("PATH", "")
    node = shutil.which("node")
    npm = shutil.which("npm")
    if not node or not npm:
        print("\n  LiteForeFlow needs Node.js, which is not installed yet.")
        print("  Easiest: double-click start.bat (Windows) or run ./start.sh (Mac/Linux) - it can download Node.js for you.")
        print("  Otherwise:")
        print("  1. A download page is opening - install the LTS version (keep clicking Next).")
        print("  2. Then run:  python run.py   again.\n")
        webbrowser.open("https://nodejs.org/en/download")
        return 1

    if subprocess.call([node, os.path.join("scripts", "preflight.cjs")], cwd=HERE) != 0:
        return 1

    if subprocess.call([node, os.path.join("scripts", "preflight.cjs"), "--deps"], cwd=HERE) != 0:
        print("\n  First start: installing LiteForeFlow (about a minute, needs internet, only once)...\n")
        code = subprocess.call([npm, "install", "--no-audit", "--no-fund", "--loglevel=error"], cwd=HERE, shell=WINDOWS)
        if code != 0:
            print("\n  The install did not finish. Check your internet connection and run it again.")
            return 1

    env = dict(os.environ)
    env["LITEFOREFLOW_OPEN"] = "0" if args.no_open else env.get("LITEFOREFLOW_OPEN", "1")
    if args.port:
        env["PORT"] = str(args.port)
    cmd = [node, "--max-semi-space-size=2", "--max-old-space-size=192", os.path.join("server", "src", "index.js")]
    try:
        return subprocess.call(cmd, cwd=HERE, env=env)
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())

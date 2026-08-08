#!/usr/bin/env python3
"""
Regenerates worker.js from calc-engine.js + worker-src.js.

Heath deploys by hand-pasting a single file into the Cloudflare dashboard editor —
there's no wrangler/bundler in this project — so worker.js is a generated artifact,
not something to hand-edit directly. Edit calc-engine.js (shared pricing math) or
worker-src.js (Worker-only request handling: auth, job sync, routing), then run:

    python build-worker.py

and paste the resulting worker.js into Cloudflare.
"""
import pathlib

ROOT = pathlib.Path(__file__).parent
CALC_ENGINE = ROOT / "calc-engine.js"
WORKER_SRC = ROOT / "worker-src.js"
OUT = ROOT / "worker.js"

HEADER = """\
// ============================================================================
// GENERATED FILE — do not hand-edit. Edit calc-engine.js and/or worker-src.js,
// then run `python build-worker.py` to regenerate this file before deploying.
// ============================================================================

"""

def main():
    calc_engine = CALC_ENGINE.read_text(encoding="utf-8")
    worker_src = WORKER_SRC.read_text(encoding="utf-8")
    OUT.write_text(HEADER + calc_engine.rstrip() + "\n\n" + worker_src, encoding="utf-8")
    print(f"Wrote {OUT}")

if __name__ == "__main__":
    main()

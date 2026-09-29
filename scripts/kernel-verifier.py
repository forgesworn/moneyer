#!/usr/bin/env python3
"""moneyer's tapscript verifier: Bitcoin Core's own script interpreter,
through lnurlcash-kernel (pip install lnurlcash-kernel), the same verifier
the reference mint uses.

moneyer evaluates a bearer note's hashlock leaf itself and hands every other
script-path spend here. One JSON request per line on stdin, one reply per
line on stdout, matched by id:

  -> {"id": 1, "q": "<hex Q>", "domain": "mint.example", "cw1": "cw1...",
      "now": 1790000000, "locked_at": 1789990000}
  <- {"id": 1, "ok": true}
  <- {"id": 1, "reason": "bitcoin core rejected the spend"}

`now` and `locked_at` are moneyer's clock, in Unix seconds: the kernel never
reads one. A reply carrying "error" is a broken install or a bug, never a
verdict, and moneyer refuses the spend.
"""

import json
import sys

import lnurlcashkernel as kernel


def answer(request: dict) -> dict:
    spend = kernel.decode_spend(request["cw1"])
    if spend is None or spend.key_path:
        return {"reason": "malformed cw1"}
    try:
        kernel.verify_spend(
            output_key=bytes.fromhex(request["q"]),
            domain=request["domain"],
            spend=spend,
            now=int(request["now"]),
            locked_at=int(request["locked_at"]),
        )
    except kernel.SpendRejected as exc:
        return {"reason": exc.reason}
    return {"ok": True}


def main() -> None:
    for line in sys.stdin:
        try:
            request = json.loads(line)
            request_id = request["id"]
        except (ValueError, KeyError, TypeError):
            continue
        try:
            reply = answer(request)
        except Exception as exc:  # noqa: BLE001 - reported, never a verdict
            reply = {"error": type(exc).__name__}
        sys.stdout.write(json.dumps({"id": request_id, **reply}) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()

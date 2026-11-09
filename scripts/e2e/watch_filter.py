#!/usr/bin/env python3
"""Reads a project's runs/events.jsonl on stdin and prints one line per event worth watching:
a task done, failed or fallback; an open question; a gate opening, passing or getting changes; a status line
that waits on the person; each whole dollar of project spend; a crew report or question in the channel;
a warn or error log. Anything else (and any line that is not JSON) is skipped."""
import json
import math
import sys


def one(text, n=240):
    s = " ".join(str(text or "").split())
    return s if len(s) <= n else s[: n - 1] + "…"


def main(inp=sys.stdin, out=sys.stdout):
    dollars = 0
    for raw in inp:
        try:
            e = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(e, dict) or not isinstance(e.get("data"), dict):
            continue
        ev, d = e.get("event"), e["data"]
        t = str(e.get("ts") or "")[11:19] or "--:--:--"
        lines = []
        if ev == "task":
            st = "fallback" if d.get("outcome") == "fallback" else d.get("status")
            if st in ("done", "failed", "fallback"):
                lines.append(f"task {st}: {d.get('kind')} \"{one(d.get('title'))}\" ${float(d.get('usd') or 0):.2f}")
        elif ev == "question" and d.get("status") == "open":
            lines.append(f"question {d.get('id')}: {one(d.get('question'))}")
        elif ev == "gate" and d.get("status") in ("open", "passed", "changes"):
            lines.append(f"gate {d.get('id')} {d.get('status')}")
        elif ev == "status" and d.get("waiting"):
            lines.append(f"waiting ({d.get('waiting')}): {one(d.get('line'))}")
        elif ev == "ledger" and isinstance(d.get("spentUsd"), (int, float)):
            whole = math.floor(d["spentUsd"])
            while dollars < whole:
                dollars += 1
                lines.append(f"spend passed ${dollars} (now ${d['spentUsd']:.2f})")
        elif ev == "channel" and d.get("kind") in ("report", "question"):
            lines.append(f"{d.get('kind')} from {d.get('from')}: {one(d.get('text'))}")
        elif ev == "log" and d.get("level") in ("warn", "error"):
            lines.append(f"{d.get('level')}: {one(d.get('text'))}")
        for line in lines:
            out.write(f"{t} {line}\n")
        if lines:
            out.flush()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass

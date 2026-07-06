#!/usr/bin/env python3
"""Live memory watch for a murmur process tree (stdlib-only).

murmur's memory lives in THREE processes — the main asyncio loop, the warm TTS
sidecar (the multi-GB model), and the per-track ffmpeg decoder — so watching
one pid tells you little. This samples `ps`, finds the murmur tree (or the
tree under --pid), and prints one line per tick: total RSS, session peak, and
a per-process breakdown.

Usage:
    python scripts/memwatch.py                # auto-find the murmur tree
    python scripts/memwatch.py --pid 12345    # watch an explicit root
    python scripts/memwatch.py --interval 5   # sample every 5 s (default 2)
    python scripts/memwatch.py --once         # one snapshot, then exit

Note: summing RSS over-counts memory shared between the processes (framework
pages, forked pages) — read totals as an upper bound and watch the TREND.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from dataclasses import dataclass


@dataclass(frozen=True)
class Proc:
    pid: int
    ppid: int
    rss_kb: int
    command: str


def parse_ps(text: str) -> list[Proc]:
    """Parse `ps -axo pid=,ppid=,rss=,command=` output (macOS and Linux)."""
    procs: list[Proc] = []
    for line in text.splitlines():
        parts = line.split(None, 3)
        if len(parts) < 4:
            continue
        try:
            pid, ppid, rss = int(parts[0]), int(parts[1]), int(parts[2])
        except ValueError:
            continue
        procs.append(Proc(pid=pid, ppid=ppid, rss_kb=rss, command=parts[3]))
    return procs


def snapshot() -> list[Proc]:
    out = subprocess.run(
        ["ps", "-axo", "pid=,ppid=,rss=,command="],
        capture_output=True,
        text=True,
        check=True,
    )
    return parse_ps(out.stdout)


def _runs_program(command: str, needle: str) -> bool:
    """True when the process IS the program (its executable is ``needle`` or
    it runs ``python -m needle[.sub]``) — not merely mentions it in an
    argument (an editor open on murmur-notes.txt is not murmur)."""
    tokens = command.split()
    for i, token in enumerate(tokens):
        if os.path.basename(token) == needle:
            return True
        if i > 0 and tokens[i - 1] == "-m" and token.split(".")[0] == needle:
            return True
    return False


def find_roots(procs: list[Proc], *, needle: str = "murmur") -> list[Proc]:
    """Top-of-tree murmur processes: the program matches, its parent doesn't
    (the sidecar matches too but rides under main)."""
    matching = {
        p.pid: p
        for p in procs
        if _runs_program(p.command, needle) and p.pid != os.getpid()
    }
    return [p for p in matching.values() if p.ppid not in matching]


def subtree(procs: list[Proc], *, root_pid: int) -> list[Proc]:
    """The root and all its descendants (ffmpeg, sidecar, their helpers)."""
    children: dict[int, list[Proc]] = {}
    for p in procs:
        children.setdefault(p.ppid, []).append(p)
    members: list[Proc] = []
    queue = [root_pid]
    by_pid = {p.pid: p for p in procs}
    while queue:
        pid = queue.pop()
        if pid in by_pid:
            members.append(by_pid[pid])
        queue.extend(c.pid for c in children.get(pid, []))
    return members


def label(proc: Proc) -> str:
    if "voice.sidecar" in proc.command:
        return "sidecar"
    if proc.command.split(None, 1)[0].endswith("ffmpeg"):
        return "ffmpeg"
    if "murmur" in proc.command:
        return "main"
    return "child"


def _mb(kb: int) -> str:
    return f"{kb / 1024:.1f}"


def format_tick(members: list[Proc], *, peak_kb: int) -> str:
    total = sum(p.rss_kb for p in members)
    parts = ", ".join(
        f"{label(p)} {_mb(p.rss_kb)}" for p in sorted(members, key=lambda p: -p.rss_kb)
    )
    stamp = time.strftime("%H:%M:%S")
    return (
        f"{stamp}  total {_mb(total)} MB  (peak {_mb(max(peak_kb, total))} MB)"
        f"  [{parts}]"
    )


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="live RSS of a murmur process tree")
    ap.add_argument("--pid", type=int, default=None, help="explicit tree root")
    ap.add_argument("--interval", type=float, default=2.0, metavar="SECONDS")
    ap.add_argument("--once", action="store_true", help="one snapshot, then exit")
    args = ap.parse_args(argv)

    peak_kb = 0
    while True:
        procs = snapshot()
        if args.pid is not None:
            roots = [p for p in procs if p.pid == args.pid]
        else:
            roots = find_roots(procs)
        if not roots:
            print("(no murmur process found)", flush=True)
        for root in roots:
            members = subtree(procs, root_pid=root.pid)
            total = sum(p.rss_kb for p in members)
            print(format_tick(members, peak_kb=peak_kb), flush=True)
            peak_kb = max(peak_kb, total)
        if args.once:
            return 0
        try:
            time.sleep(args.interval)
        except KeyboardInterrupt:
            return 0


if __name__ == "__main__":
    sys.exit(main())

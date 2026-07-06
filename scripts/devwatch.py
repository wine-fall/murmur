#!/usr/bin/env python3
"""Dev log + memory view for a running murmur (`make logs`), stdlib-only.

One window for debugging a `make dev` session: it follows the diagnostics
logfile the app streams to (`.dev/dev.log` — harness steps, and the failures the
UI keeps terse, with full tracebacks) like `tail -f`, and every few seconds
injects one line of the murmur process tree's RSS — reusing memwatch's sampling
so memory and log sit in the same scrollback.

Usage:
    python scripts/devwatch.py                       # .dev/dev.log, mem every 2s
    python scripts/devwatch.py --log path/to.log
    python scripts/devwatch.py --interval 5          # memory line cadence
    python scripts/devwatch.py --no-mem              # log tail only

Run it in a second terminal after `make dev`. It tolerates the logfile not
existing yet (waits for it) and being truncated at the next `make dev` start.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import memwatch  # same scripts/ dir — stdlib-only, reused for the memory line

_DEFAULT_LOG = ".dev/dev.log"
_POLL_S = 0.5  # how often we check the file for new lines (log responsiveness)


class LogFollower:
    """Yield lines appended to a file, `tail -f` style. Tolerates the file not
    existing yet (returns nothing until it appears) and truncation/rotation —
    when the file shrinks below our read position (a new `make dev` truncated
    it) we reset to its start so we don't miss the fresh session."""

    def __init__(self, path: str | Path) -> None:
        self._path = Path(path)
        self._pos = 0
        self._buf = ""

    def read_new(self) -> list[str]:
        """Return complete lines appended since the last call (no trailing
        partial line — it is buffered until its newline arrives)."""
        try:
            size = self._path.stat().st_size
        except OSError:
            return []  # not created yet
        if size < self._pos:  # truncated / rotated -> restart from the top
            self._pos = 0
            self._buf = ""
        if size == self._pos:
            return []
        with self._path.open("r", encoding="utf-8", errors="replace") as fh:
            fh.seek(self._pos)
            chunk = fh.read()
            self._pos = fh.tell()
        self._buf += chunk
        *lines, self._buf = self._buf.split("\n")
        return lines


def memory_line(*, peak_kb: int) -> tuple[str | None, int]:
    """One process-tree RSS summary via memwatch, plus the updated peak. Returns
    (None, peak) when no murmur process is running."""
    procs = memwatch.snapshot()
    roots = memwatch.find_roots(procs)
    if not roots:
        return None, peak_kb
    members: list[memwatch.Proc] = []
    for root in roots:
        members.extend(memwatch.subtree(procs, root_pid=root.pid))
    total = sum(p.rss_kb for p in members)
    line = memwatch.format_tick(members, peak_kb=peak_kb)
    return f"  • mem  {line}", max(peak_kb, total)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="tail the murmur dev log + memory")
    ap.add_argument("--log", default=_DEFAULT_LOG, metavar="PATH")
    ap.add_argument("--interval", type=float, default=2.0, metavar="SECONDS")
    ap.add_argument("--no-mem", action="store_true", help="log tail only")
    args = ap.parse_args(argv)

    follower = LogFollower(args.log)
    print(f"watching {args.log}  (Ctrl-C to stop)", flush=True)
    if not Path(args.log).exists():
        print("(log not created yet — run `make dev` in another terminal)", flush=True)

    peak_kb = 0
    last_mem = 0.0
    try:
        while True:
            for line in follower.read_new():
                print(line, flush=True)
            now = time.monotonic()
            if not args.no_mem and now - last_mem >= args.interval:
                line, peak_kb = memory_line(peak_kb=peak_kb)
                if line is not None:
                    print(line, flush=True)
                last_mem = now
            time.sleep(_POLL_S)
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())

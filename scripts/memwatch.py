#!/usr/bin/env python3
"""Live memory watch for a murmur process tree (stdlib-only).

murmur's memory lives in THREE processes — the main asyncio loop, the warm TTS
sidecar (the multi-GB model), and the per-track ffmpeg decoder — so watching
one pid tells you little. This samples `ps` for the tree structure, `top` for
each process's real size, finds the murmur tree (or the tree under --pid), and
prints one line per tick: total size, session peak, and a per-process breakdown.

Usage:
    python scripts/memwatch.py                # auto-find the murmur tree
    python scripts/memwatch.py --pid 12345    # watch an explicit root
    python scripts/memwatch.py --interval 5   # sample every 5 s (default 2)
    python scripts/memwatch.py --once         # one snapshot, then exit

Each process's size is its phys_footprint (macOS `top`'s MEM column — the same
number Activity Monitor shows), which counts the Metal/GPU/compressed pages
that `ps` RSS silently misses (an MLX model resident-reads far larger than its
RSS). Off macOS, or if `top` is unavailable, it falls back to `ps` RSS.

Note: summing across processes still over-counts pages shared between them
(framework, forked) — read totals as an upper bound and watch the TREND.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from dataclasses import dataclass, replace


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


# -- real per-process size: phys_footprint via `top` ----------------------- #
#
# `ps` RSS reports resident_size, which excludes the Metal/GPU-mapped and
# compressed pages an MLX model actually holds — the sidecar reads ~40 MB by RSS
# while truly costing ~1 GB. `top`'s MEM column is phys_footprint (Activity
# Monitor's "Memory"), which counts them. One `top -l1` sample gives it for every
# pid at once, so it is cheaper than per-pid `footprint`.

_MEM_UNITS = {"B": 1 / 1024, "K": 1.0, "M": 1024.0, "G": 1024.0 * 1024, "T": 1024.0**3}


def _mem_token_kb(token: str) -> int | None:
    """Parse one `top` MEM token to KB: ``227M`` ``8722K`` ``1G`` ``5M+`` (top
    marks a grown value with a trailing ``+``). None if it isn't a size."""
    token = token.strip().rstrip("+*-")
    if not token:
        return None
    if token[-1] in _MEM_UNITS:
        try:
            return round(float(token[:-1]) * _MEM_UNITS[token[-1]])
        except ValueError:
            return None
    try:  # a bare number is bytes
        return round(int(token) / 1024)
    except ValueError:
        return None


def parse_top_mem(text: str) -> dict[int, int]:
    """Map pid -> phys_footprint (KB) from `top -l1 -stats pid,mem` output.
    Skips the preamble/header; keeps only ``<int-pid> <mem-token>`` rows."""
    sizes: dict[int, int] = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) < 2:
            continue
        try:
            pid = int(parts[0])
        except ValueError:
            continue
        kb = _mem_token_kb(parts[1])
        if kb is not None:
            sizes[pid] = kb
    return sizes


def top_footprints() -> dict[int, int]:
    """pid -> phys_footprint (KB) for every process from one `top` sample.
    macOS only; empty dict off-darwin or if `top` fails — callers fall back to
    `ps` RSS (accurate enough on Linux, which has no unified-memory blind spot)."""
    if sys.platform != "darwin":
        return {}
    try:
        out = subprocess.run(
            ["top", "-l", "1", "-stats", "pid,mem"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        return {}
    return parse_top_mem(out)


def apply_footprints(procs: list[Proc], footprints_kb: dict[int, int]) -> list[Proc]:
    """Replace each proc's `ps` RSS with its `top` phys_footprint where known.
    RSS is a floor (misses Metal/GPU/compressed); phys_footprint is honest. A pid
    absent from the `top` sample (a race) keeps its RSS."""
    if not footprints_kb:
        return procs
    return [replace(p, rss_kb=footprints_kb.get(p.pid, p.rss_kb)) for p in procs]


_SHELLS = frozenset({"sh", "bash", "zsh", "dash", "fish", "ksh"})


def _runs_program(command: str, needle: str) -> bool:
    """True when the process IS the program (its executable is ``needle`` or
    it runs ``python -m needle[.sub]``) — not merely mentions it in an
    argument (an editor open on murmur-notes.txt is not murmur)."""
    tokens = command.split()
    if not tokens:
        return False
    # A shell running `-c <script>` is not the program even when the script
    # names it: e.g. `make dev`'s `/bin/sh -c '... memwatch & uv run murmur'`
    # backgrounds the recorder AND launches murmur from one shell, so its
    # command line carries a bare `murmur` token. Matching it would root the
    # tree at the wrapper and pull the recorder itself into the measured tree.
    # Skip it; the real murmur procs it spawns (uv/python) match on their own.
    if os.path.basename(tokens[0]) in _SHELLS and "-c" in tokens:
        return False
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
    executable = os.path.basename(proc.command.split(None, 1)[0])
    if executable in ("uv", "uvx"):
        return "launcher"  # the `uv run murmur` shell, not murmur itself
    if "voice.sidecar" in proc.command:
        return "sidecar"
    if executable.endswith("ffmpeg"):
        return "ffmpeg"
    if "murmur" in proc.command:
        return "main"
    return "child"


def _mb(kb: int) -> str:
    return f"{kb / 1024:.1f}"


# -- system-wide memory (the whole machine, not just the murmur tree) ------- #


def parse_meminfo_available_mb(text: str) -> float | None:
    """``MemAvailable`` from Linux /proc/meminfo text, in MB (None if absent).
    MemAvailable is the kernel's own estimate of reclaimable memory — the right
    'how much headroom' number."""
    for line in text.splitlines():
        if line.startswith("MemAvailable:"):
            try:
                return int(line.split()[1]) / 1024  # kB -> MB
            except (IndexError, ValueError):
                return None
    return None


def parse_vm_stat_available_mb(text: str) -> float | None:
    """Approx available RAM from macOS ``vm_stat`` text, in MB: the reclaimable
    page buckets (free + inactive + speculative + purgeable) x page size. A
    coarse pressure gauge — watch the trend, not the exact byte."""
    page = 4096
    buckets = {"free": 0, "inactive": 0, "speculative": 0, "purgeable": 0}
    for raw in text.splitlines():
        line = raw.strip()
        if "page size of" in line:
            try:
                page = int(line.split("page size of")[1].split("bytes")[0].strip())
            except (IndexError, ValueError):
                pass
            continue
        for key in buckets:
            if line.startswith(f"Pages {key}:"):
                try:
                    buckets[key] = int(line.split(":")[1].strip().rstrip("."))
                except (IndexError, ValueError):
                    pass
    return sum(buckets.values()) * page / 1024 / 1024


def system_memory() -> tuple[float, float] | None:
    """(total_mb, available_mb) for the whole machine, or None if unreadable.
    Total is exact (sysconf); available is the OS reclaimable estimate."""
    try:
        total = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1024 / 1024
    except (ValueError, OSError):
        return None
    avail: float | None = None
    if sys.platform == "linux":
        try:
            from pathlib import Path

            avail = parse_meminfo_available_mb(Path("/proc/meminfo").read_text())
        except OSError:
            avail = None
    elif sys.platform == "darwin":
        try:
            out = subprocess.run(
                ["vm_stat"], capture_output=True, text=True, check=True
            ).stdout
            avail = parse_vm_stat_available_mb(out)
        except (OSError, subprocess.CalledProcessError):
            avail = None
    return (total, avail) if avail is not None else (total, total)


def _sys_suffix(sys_mem: tuple[float, float] | None) -> str:
    """The `  |  sys used U / total T MB (avail A)` tail — the whole-machine
    memory, shared by the tick line and the no-murmur line so both carry it."""
    if sys_mem is None:
        return ""
    sys_total, sys_avail = sys_mem
    return (
        f"  |  sys used {sys_total - sys_avail:.0f} / {sys_total:.0f} MB"
        f" (avail {sys_avail:.0f})"
    )


def format_tick(
    members: list[Proc],
    *,
    peak_kb: int,
    sys_mem: tuple[float, float] | None = None,
) -> str:
    total = sum(p.rss_kb for p in members)
    parts = ", ".join(
        f"{label(p)} {_mb(p.rss_kb)}" for p in sorted(members, key=lambda p: -p.rss_kb)
    )
    stamp = time.strftime("%H:%M:%S")
    return (
        f"{stamp}  total {_mb(total)} MB  (peak {_mb(max(peak_kb, total))} MB)"
        f"  [{parts}]{_sys_suffix(sys_mem)}"
    )


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="live RSS of a murmur process tree")
    ap.add_argument("--pid", type=int, default=None, help="explicit tree root")
    ap.add_argument("--interval", type=float, default=2.0, metavar="SECONDS")
    ap.add_argument("--once", action="store_true", help="one snapshot, then exit")
    ap.add_argument(
        "--out",
        default=None,
        metavar="PATH",
        help="also append each tick to this file (the recorder `make dev` runs)",
    )
    args = ap.parse_args(argv)

    out_fh = open(args.out, "a", encoding="utf-8") if args.out else None

    def emit(text: str) -> None:
        print(text, flush=True)
        if out_fh is not None:
            out_fh.write(text + "\n")
            out_fh.flush()

    peak_kb = 0
    try:
        while True:
            # A recorder must survive its own errors: a bad `ps`/`top` sample or
            # a parse bug logs one line and the loop goes on, never dying silently
            # mid-run (and never — it is a separate process — touching murmur).
            try:
                procs = apply_footprints(snapshot(), top_footprints())
                if args.pid is not None:
                    roots = [p for p in procs if p.pid == args.pid]
                else:
                    roots = find_roots(procs)
                if not roots:
                    # Still report the machine's memory — just flag that murmur
                    # isn't up yet (e.g. the recorder started before the app).
                    stamp = time.strftime("%H:%M:%S")
                    emit(f"{stamp}  (no murmur running){_sys_suffix(system_memory())}")
                for root in roots:
                    members = subtree(procs, root_pid=root.pid)
                    total = sum(p.rss_kb for p in members)
                    emit(format_tick(members, peak_kb=peak_kb, sys_mem=system_memory()))
                    peak_kb = max(peak_kb, total)
            except Exception as exc:
                emit(f"{time.strftime('%H:%M:%S')}  ERROR sampling: {type(exc).__name__}: {exc}")
            if args.once:
                return 0
            try:
                time.sleep(args.interval)
            except KeyboardInterrupt:
                return 0
    finally:
        if out_fh is not None:
            out_fh.close()


if __name__ == "__main__":
    sys.exit(main())

"""memwatch script logic (deterministic parts only): ps parsing, murmur-tree
discovery, labeling, and formatting — canned `ps` output, no live processes.
The live sampling loop is a thin shell over these.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location(
    "memwatch", Path(__file__).resolve().parents[1] / "scripts" / "memwatch.py"
)
assert _SPEC is not None and _SPEC.loader is not None
memwatch = importlib.util.module_from_spec(_SPEC)
# Registered before exec: dataclasses' lazy annotation resolution (3.14)
# looks the module up in sys.modules.
sys.modules["memwatch"] = memwatch
_SPEC.loader.exec_module(memwatch)

_PS = """\
    1     0   1200 /sbin/launchd
   99     1  20000 /opt/homebrew/bin/uv run murmur --voice spark
  100    99  52000 /repo/.venv/bin/python /repo/.venv/bin/murmur --voice spark
  101   100 3200000 /repo/.venv/bin/python -m murmur.voice.sidecar --backend spark
  102   100  48000 ffmpeg -nostdin -loglevel error -i http://x -f f32le pipe:1
  103   101   9000 some-helper-of-the-sidecar
  200     1   8000 vim notes-about-murmur.txt
  201     1   4000 python scripts/memwatch.py
"""


def test_parse_ps_extracts_pid_ppid_rss_command():
    procs = memwatch.parse_ps(_PS)
    by_pid = {p.pid: p for p in procs}
    assert by_pid[100].ppid == 99
    assert by_pid[100].rss_kb == 52000
    assert by_pid[102].command.startswith("ffmpeg")
    assert 1 in by_pid  # header-less lines all parse


def test_find_roots_picks_the_top_of_the_murmur_tree_only():
    procs = memwatch.parse_ps(_PS)
    roots = memwatch.find_roots(procs, needle="murmur")
    # The `uv run murmur` wrapper is the top of the tree; the sidecar and the
    # real murmur process match too but ride under it; the vim session and
    # memwatch itself are not murmur processes.
    assert [r.pid for r in roots] == [99]


def test_subtree_collects_all_descendants():
    procs = memwatch.parse_ps(_PS)
    members = memwatch.subtree(procs, root_pid=99)
    assert sorted(p.pid for p in members) == [99, 100, 101, 102, 103]


def test_labels_name_the_interesting_processes():
    procs = memwatch.parse_ps(_PS)
    by_pid = {p.pid: p for p in procs}
    assert memwatch.label(by_pid[99]) == "launcher"  # the uv shell, not murmur
    assert memwatch.label(by_pid[100]) == "main"
    assert memwatch.label(by_pid[101]) == "sidecar"
    assert memwatch.label(by_pid[102]) == "ffmpeg"
    assert memwatch.label(by_pid[103]) == "child"


def test_format_tick_totals_and_breaks_down():
    procs = memwatch.parse_ps(_PS)
    members = memwatch.subtree(procs, root_pid=100)
    line = memwatch.format_tick(members, peak_kb=3400000)
    # Total = 52000+3200000+48000+9000 kB ~= 3231.4 MB; peak ~= 3320.3 MB.
    assert "3231.4 MB" in line
    assert "peak 3320.3 MB" in line
    assert "sidecar 3125.0" in line
    assert "ffmpeg 46.9" in line
    assert "main 50.8" in line


# --- system-wide memory (the machine, not just murmur) -------------------- #


def test_parse_meminfo_available_mb():
    text = "MemTotal:       16384000 kB\nMemAvailable:    8000000 kB\n"
    assert memwatch.parse_meminfo_available_mb(text) == 8000000 / 1024


def test_parse_meminfo_available_absent_is_none():
    assert memwatch.parse_meminfo_available_mb("MemFree: 100 kB\n") is None


def test_parse_vm_stat_available_mb():
    text = (
        "Mach Virtual Memory Statistics: (page size of 16384 bytes)\n"
        "Pages free:                                4307.\n"
        "Pages active:                            155060.\n"
        "Pages inactive:                          151304.\n"
        "Pages speculative:                         2341.\n"
        "Pages purgeable:                              0.\n"
    )
    # available ~= (free 4307 + inactive 151304 + speculative 2341 + purgeable 0)
    # pages * 16384 B = 2468.0 MB
    assert round(memwatch.parse_vm_stat_available_mb(text), 1) == 2468.0


def test_format_tick_appends_system_memory_when_given():
    procs = memwatch.parse_ps(_PS)
    members = memwatch.subtree(procs, root_pid=100)
    line = memwatch.format_tick(members, peak_kb=0, sys_mem=(19792.0, 2468.0))
    # used = total - avail = 17324; whole machine, distinct from murmur's total.
    assert "sys used 17324 / 19792 MB (avail 2468)" in line


def test_format_tick_omits_system_memory_when_none():
    procs = memwatch.parse_ps(_PS)
    line = memwatch.format_tick(memwatch.subtree(procs, root_pid=100), peak_kb=0)
    assert "sys used" not in line  # back-compatible with the live-view caller

"""CliHost stdin reader (spec 01 §3.1)."""

from __future__ import annotations

import asyncio
import io

import pytest

from murmur.cli_host import CliHost


def test_reads_piped_lines(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr("sys.stdin", io.StringIO("alpha\nbravo\n"))

    async def go():
        cli = CliHost()
        cli.start()
        first = await asyncio.wait_for(cli.next_line(), timeout=2)
        second = await asyncio.wait_for(cli.next_line(), timeout=2)
        return first, second

    assert asyncio.run(go()) == ("alpha", "bravo")

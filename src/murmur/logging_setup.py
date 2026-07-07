"""Opt-in file logging for local development (``make dev`` / ``MURMUR_DEV_LOG``).

Shipped runs stay silent: with no ``MURMUR_DEV_LOG`` set no handler is added and
murmur logs nowhere — the interactive CLI owns the terminal and nothing else may
write to it. When a dev sets ``MURMUR_DEV_LOG=<path>`` (``make dev`` does),
murmur's diagnostics — harness steps, and the failures the UI deliberately keeps
terse (with full tracebacks) — stream to that file for the ``make logs`` view to
tail. The console is never touched, so the UI is unaffected either way.

All murmur modules log under the ``murmur`` logger namespace
(``logging.getLogger("murmur.<area>")``); this attaches the one file handler to
that root and stops propagation so records never leak to stderr.
"""

from __future__ import annotations

import logging
import os
import time
from collections.abc import Generator, MutableMapping
from contextlib import contextmanager
from pathlib import Path

ENV_VAR = "MURMUR_DEV_LOG"
_LOGGER_NAME = "murmur"
_configured: set[str] = set()


def _fmt_fields(fields: MutableMapping[str, object]) -> str:
    """Render structured fields as ``  k=v k=v`` (leading double-space separates
    them from the message). Floats to 2 decimals so timings read cleanly; other
    types via str(). Empty -> "" (no dangling separator)."""
    if not fields:
        return ""
    parts = [
        f"{k}={v:.2f}" if isinstance(v, float) else f"{k}={v}"
        for k, v in fields.items()
    ]
    return "  " + " ".join(parts)


class DevLog:
    """The single diagnostics entry every module uses (via ``get_log(area)``).

    A thin facade over stdlib logging bound to ``murmur.<area>`` so the one dev
    file handler (``configure_dev_logging``) catches it. Levels carry intent:
    ``event`` = the INFO "what happened" timeline (with light k=v fields),
    ``debug`` = the DEBUG firehose (harness message dumps), ``warn`` = a WARNING
    degradation with traceback. ``timed`` is the timing primitive: it wraps a
    block and emits one event with the measured ``elapsed_s`` plus any fields the
    block fills in. UI output is NOT here — that stays in the CliHost (a future
    TUI swaps the CliHost, reads this same log sink for its program-log pane).
    """

    def __init__(self, area: str) -> None:
        self._log = logging.getLogger(f"{_LOGGER_NAME}.{area}")

    @property
    def debug_enabled(self) -> bool:
        """Guard for a firehose caller to skip building an expensive message
        (a big repr) when DEBUG is off."""
        return self._log.isEnabledFor(logging.DEBUG)

    def event(self, msg: str, **fields: object) -> None:
        self._log.info("%s%s", msg, _fmt_fields(fields))

    def debug(self, msg: str, **fields: object) -> None:
        # Guard: skip field formatting entirely when DEBUG is off (the firehose
        # callers pass big reprs — don't build the string just to drop it).
        if self._log.isEnabledFor(logging.DEBUG):
            self._log.debug("%s%s", msg, _fmt_fields(fields))

    def warn(self, msg: str, *, exc: BaseException | None = None) -> None:
        self._log.warning(msg, exc_info=exc)

    @contextmanager
    def timed(
        self, label: str, **fields: object
    ) -> Generator[dict[str, object], None, None]:
        """Time the ``with`` block; emit an event on exit with ``elapsed_s`` plus
        ``fields`` and anything the block adds to the yielded dict. Fires even if
        the block raises, so a failure still leaves its latency on the record."""
        extra: dict[str, object] = {}
        start = time.monotonic()
        try:
            yield extra
        finally:
            # Merge into one dict (extra wins over fields, elapsed_s wins over
            # both) so a caller reusing a key never triggers a duplicate-kwarg
            # TypeError on the event() call.
            merged = {**fields, **extra, "elapsed_s": time.monotonic() - start}
            self.event(label, **merged)


def get_log(area: str) -> DevLog:
    """Return the diagnostics facade bound to ``murmur.<area>``. The single entry
    point every module uses instead of ``logging.getLogger``."""
    return DevLog(area)


def configure_dev_logging(
    path: str | None = None, *, level: int = logging.DEBUG
) -> Path | None:
    """Attach a file handler to the ``murmur`` logger when a dev log path is set.

    ``path`` defaults to ``$MURMUR_DEV_LOG``. Returns the resolved log path when
    file logging was configured, or ``None`` when no path was set (the shipping
    default — no handler, no file). Idempotent: repeat calls for the same
    resolved path do not stack handlers.
    """
    target = path if path is not None else os.environ.get(ENV_VAR)
    if not target:
        return None
    log_path = Path(target).expanduser()
    log_path.parent.mkdir(parents=True, exist_ok=True)

    logger = logging.getLogger(_LOGGER_NAME)
    logger.setLevel(level)
    logger.propagate = False  # the file is the only sink; never touch stderr/UI

    resolved = str(log_path.resolve())
    if resolved in _configured:
        return log_path

    handler = logging.FileHandler(log_path, mode="a", encoding="utf-8")
    handler.setFormatter(
        logging.Formatter(
            "%(asctime)s %(levelname)-7s %(name)s: %(message)s", datefmt="%H:%M:%S"
        )
    )
    logger.addHandler(handler)
    _configured.add(resolved)
    return log_path

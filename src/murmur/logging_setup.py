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
from pathlib import Path

ENV_VAR = "MURMUR_DEV_LOG"
_LOGGER_NAME = "murmur"
_configured: set[str] = set()


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

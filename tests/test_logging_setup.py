"""Opt-in dev file logging (make dev / MURMUR_DEV_LOG)."""

from __future__ import annotations

import logging

import pytest

import murmur.logging_setup as ls
from murmur.logging_setup import ENV_VAR, configure_dev_logging


@pytest.fixture(autouse=True)
def _isolate_murmur_logger():
    """Snapshot/restore the shared ``murmur`` logger and module state so each
    test starts from the shipping default (no handler)."""
    logger = logging.getLogger("murmur")
    saved_handlers = list(logger.handlers)
    saved_level, saved_propagate = logger.level, logger.propagate
    saved_configured = set(ls._configured)
    logger.handlers.clear()
    ls._configured.clear()
    yield
    for h in list(logger.handlers):
        h.close()
    logger.handlers[:] = saved_handlers
    logger.setLevel(saved_level)
    logger.propagate = saved_propagate
    ls._configured.clear()
    ls._configured.update(saved_configured)


def test_no_path_adds_no_handler(monkeypatch):
    monkeypatch.delenv(ENV_VAR, raising=False)
    assert configure_dev_logging() is None
    assert logging.getLogger("murmur").handlers == []


def test_env_var_is_the_default_source(tmp_path, monkeypatch):
    logpath = tmp_path / "dev.log"
    monkeypatch.setenv(ENV_VAR, str(logpath))
    assert configure_dev_logging() == logpath


def test_configures_file_handler_and_diagnostics_land_in_the_file(tmp_path):
    logpath = tmp_path / "dev.log"
    assert configure_dev_logging(str(logpath)) == logpath

    logging.getLogger("murmur.harness").debug("task started %d", 7)
    logging.getLogger("murmur.director").warning("music fell back")
    for h in logging.getLogger("murmur").handlers:
        h.flush()

    text = logpath.read_text(encoding="utf-8")
    assert "task started 7" in text
    assert "music fell back" in text


def test_does_not_leak_to_the_console(tmp_path):
    # propagate is off so records never reach the root logger / stderr (the UI).
    configure_dev_logging(str(tmp_path / "dev.log"))
    assert logging.getLogger("murmur").propagate is False


def test_idempotent_no_duplicate_handlers(tmp_path):
    logpath = str(tmp_path / "dev.log")
    configure_dev_logging(logpath)
    configure_dev_logging(logpath)
    file_handlers = [
        h
        for h in logging.getLogger("murmur").handlers
        if isinstance(h, logging.FileHandler)
    ]
    assert len(file_handlers) == 1

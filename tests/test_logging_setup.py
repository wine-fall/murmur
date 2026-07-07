"""Opt-in dev file logging (make dev / MURMUR_DEV_LOG)."""

from __future__ import annotations

import logging

import pytest

import murmur.logging_setup as ls
from murmur.logging_setup import ENV_VAR, configure_dev_logging, get_log


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


# --- DevLog facade -------------------------------------------------------- #


def test_get_log_binds_to_the_murmur_area_namespace():
    log = get_log("voice")
    assert log._log.name == "murmur.voice"  # so the one file handler catches it


def test_event_is_info_with_fields_appended_and_floats_2dp(tmp_path):
    configure_dev_logging(str(tmp_path / "dev.log"))
    get_log("voice").event("synth", chars=42, rtf=1.5512, audio_s=3.1)
    for h in logging.getLogger("murmur").handlers:
        h.flush()
    text = (tmp_path / "dev.log").read_text(encoding="utf-8")
    assert "INFO" in text
    # message then k=v pairs; floats rounded to 2 decimals, ints left alone.
    assert "synth  chars=42 rtf=1.55 audio_s=3.10" in text


def test_event_without_fields_has_no_trailing_space(tmp_path):
    configure_dev_logging(str(tmp_path / "dev.log"))
    get_log("director").event("started")
    for h in logging.getLogger("murmur").handlers:
        h.flush()
    line = (tmp_path / "dev.log").read_text(encoding="utf-8").rstrip("\n")
    assert line.endswith("started")  # no dangling "  "


def test_timed_emits_an_event_with_elapsed_and_merged_extras(tmp_path):
    configure_dev_logging(str(tmp_path / "dev.log"))
    with get_log("director").timed("talk", model="haiku") as extra:
        extra["chars"] = 7
    for h in logging.getLogger("murmur").handlers:
        h.flush()
    text = (tmp_path / "dev.log").read_text(encoding="utf-8")
    assert "talk  " in text
    assert "model=haiku" in text
    assert "chars=7" in text
    assert "elapsed_s=" in text  # the measured wall time


def test_timed_extra_overrides_a_seeded_field_without_crashing(tmp_path):
    # Regression: merging fields+extra must not raise a duplicate-kwarg TypeError
    # when the block reuses a seeded key; the block's value wins.
    configure_dev_logging(str(tmp_path / "dev.log"))
    with get_log("director").timed("music.pick", found=False) as extra:
        extra["found"] = True
    for h in logging.getLogger("murmur").handlers:
        h.flush()
    text = (tmp_path / "dev.log").read_text(encoding="utf-8")
    assert "found=True" in text and "found=False" not in text


def test_warn_records_at_warning_with_traceback(tmp_path):
    configure_dev_logging(str(tmp_path / "dev.log"))
    try:
        raise ValueError("boom")
    except ValueError as exc:
        get_log("director").warn("music fell back", exc=exc)
    for h in logging.getLogger("murmur").handlers:
        h.flush()
    text = (tmp_path / "dev.log").read_text(encoding="utf-8")
    assert "WARNING" in text and "music fell back" in text
    assert "Traceback" in text and "ValueError: boom" in text

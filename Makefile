# murmur dev workflow — one command to install, preflight, and run.
#
#   make dev      # terminal 1: set up, check deps, launch the app (interactive)
#   make logs     # terminal 2: tail the dev log + memory while it runs
#
# Knobs:  VOICE=spark|stub|qwen3|...   (real TTS by default)
#         STUB=1                       (full offline: canned brain, silent voice,
#                                        no music — needs no network/model/binaries)

.DEFAULT_GOAL := help

VOICE  ?= spark
DEV_LOG := .dev/dev.log

ifdef STUB
  SYNC_ARGS      := --extra dev
  RUN_ARGS       := --brain stub --voice stub --no-music
  PREFLIGHT_ARGS := --no-music --voice stub
else
  SYNC_ARGS      := --all-extras
  RUN_ARGS       := --voice $(VOICE)
  PREFLIGHT_ARGS := --voice $(VOICE)
endif

.PHONY: help dev logs preflight setup-music install

help:
	@echo "murmur dev:"
	@echo "  make dev          install deps, preflight, then launch the app"
	@echo "                    (diagnostics -> $(DEV_LOG))"
	@echo "  make logs         tail the dev log + memory (run in a 2nd terminal)"
	@echo "  make preflight    check music/voice deps without launching"
	@echo "  make setup-music  run the guided binary (yt-dlp/ffmpeg) repair"
	@echo ""
	@echo "  knobs:  VOICE=spark|stub|...   STUB=1 (full offline)"

install:
	uv sync $(SYNC_ARGS)
	@uv run pre-commit install >/dev/null 2>&1 || true

preflight:
	@uv run python scripts/dev_preflight.py $(PREFLIGHT_ARGS)

dev: install
	@uv run python scripts/dev_preflight.py $(PREFLIGHT_ARGS) || { \
	  echo ""; \
	  echo "make dev stopped — fix the blockers above (or: STUB=1 make dev)."; \
	  exit 1; \
	}
	@mkdir -p .dev && : > $(DEV_LOG)
	@echo ""
	@echo "▶ logs: open another terminal in this repo and run:  make logs"
	@echo "  (diagnostics stream to $(DEV_LOG))"
	@echo ""
	@MURMUR_DEV_LOG=$(DEV_LOG) uv run murmur $(RUN_ARGS)

logs:
	@uv run python scripts/devwatch.py --log $(DEV_LOG)

setup-music:
	uv run murmur --setup-music

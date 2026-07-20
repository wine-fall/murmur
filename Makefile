# murmur dev workflow — one command to install, preflight, and run.
#
#   make dev            # terminal 1: set up, check deps, launch the app (local voice)
#   make dev-fishaudio  # remote voice via fish.audio (.env.fishaudio -> .env)
#   make dev-opuslab    # remote voice via self-hosted opuslab (.env.opuslab; WARP on)
#   make logs           # terminal 2: tail the dev log + memory while it runs
#
# Knobs:  VOICE=spark|stub|qwen3|...   (real TTS by default)
#         STUB=1                       (full offline: canned brain, silent voice,
#                                        no music — needs no network/model/binaries)

.DEFAULT_GOAL := help

VOICE  ?= spark
DEV_LOG := .dev/dev.log
MEM_LOG := .dev/mem.log

ifdef STUB
  SYNC_ARGS      := --extra dev
  RUN_ARGS       := --brain stub --voice stub --no-music --no-bed
  PREFLIGHT_ARGS := --no-music --voice stub
else
  SYNC_ARGS      := --all-extras
  RUN_ARGS       := --voice $(VOICE)
  PREFLIGHT_ARGS := --voice $(VOICE)
endif

.PHONY: help dev dev-remote dev-fishaudio dev-opuslab logs preflight setup-music install bed-refresh

help:
	@echo "murmur dev:"
	@echo "  make dev          install deps, preflight, then launch the app (local voice)"
	@echo "                    (diagnostics -> $(DEV_LOG))"
	@echo "  make dev-fishaudio  remote voice via fish.audio (.env.fishaudio -> .env)"
	@echo "  make dev-opuslab    remote voice via self-hosted opuslab (.env.opuslab; WARP on)"
	@echo "  make dev-remote   remote voice from whatever .env currently holds"
	@echo "  make logs         tail the dev log + memory (run in a 2nd terminal)"
	@echo "                    INFO timeline by default; DEBUG=1 unmutes the firehose"
	@echo "                    (memory is also recorded to $(MEM_LOG) while dev runs)"
	@echo "  make preflight    check music/voice deps without launching"
	@echo "  make setup-music  run the guided binary (yt-dlp/ffmpeg) repair"
	@echo "  make bed-refresh  (re-)pull the background-bed manifest into the cache"
	@echo ""
	@echo "  knobs:  VOICE=spark|stub|...   STUB=1 (full offline)"

install:
	uv sync $(SYNC_ARGS)
	@uv run pre-commit install >/dev/null 2>&1 || true

preflight:
	@uv run python scripts/dev_preflight.py $(PREFLIGHT_ARGS)

dev-fishaudio:
	@# Select the fish.audio backend: copy its config to .env, then run remote.
	@test -f .env.fishaudio || { echo "missing .env.fishaudio (fish.audio config)"; exit 1; }
	@cp .env.fishaudio .env
	@$(MAKE) dev-remote

dev-opuslab:
	@# Select the self-hosted opuslab backend (keep WARP connected).
	@test -f .env.opuslab || { echo "missing .env.opuslab (opuslab config)"; exit 1; }
	@cp .env.opuslab .env
	@$(MAKE) dev-remote

dev-remote:
	@# Load the gitignored .env (MURMUR_TTS_URL / _SEED / …) into the environment,
	@# then run the normal dev flow forcing the off-machine HTTP backend. Keep WARP
	@# connected — auth to the endpoint is via Cloudflare Access (spec 02 §3.6).
	@if [ -f .env ]; then set -a; . ./.env; set +a; fi; \
	  if [ -z "$$MURMUR_TTS_URL" ]; then \
	    echo "make dev-remote: no TTS endpoint configured."; \
	    echo "Create a gitignored .env in this dir with, e.g.:"; \
	    echo "    MURMUR_TTS_URL=https://fish-speech.example.com"; \
	    echo "    MURMUR_TTS_SEED=42            # optional: pin the voice"; \
	    echo "then re-run 'make dev-remote' (keep WARP connected for Access)."; \
	    exit 1; \
	  fi; \
	  $(MAKE) dev VOICE=remote

dev: install
	@uv run python scripts/dev_preflight.py $(PREFLIGHT_ARGS) || { \
	  echo ""; \
	  echo "make dev stopped — fix the blockers above (or: STUB=1 make dev)."; \
	  exit 1; \
	}
	@mkdir -p .dev && : > $(DEV_LOG) && : > $(MEM_LOG)
	@echo ""
	@echo "▶ logs: open another terminal in this repo and run:  make logs"
	@echo "  (diagnostics -> $(DEV_LOG); memory -> $(MEM_LOG))"
	@echo ""
	@# Side-car memory recorder (external, app-agnostic): sample the process
	@# tree into mem.log for the whole run, torn down when the app exits. It is a
	@# separate process — its crash can never take murmur down; stderr lands in
	@# mem.log (not /dev/null) so a fatal crash is recorded, not swallowed.
	@.venv/bin/python scripts/memwatch.py --out $(MEM_LOG) >/dev/null 2>>$(MEM_LOG) & \
	  MEMPID=$$!; \
	  trap 'kill $$MEMPID 2>/dev/null || true' EXIT INT TERM; \
	  MURMUR_DEV_LOG=$(DEV_LOG) uv run murmur $(RUN_ARGS)

LOG_LEVEL ?= INFO
ifdef DEBUG
  LOG_LEVEL := DEBUG
endif

logs:
	@uv run python scripts/devwatch.py --log $(DEV_LOG) --level $(LOG_LEVEL)

setup-music:
	uv run murmur --setup-music

bed-refresh:
	@# (Re-)pull the curated background-bed manifest into the local cache after
	@# editing assets/bed_sources.txt (spec 03-04). Warm entries are skipped.
	uv run python -m murmur.bed

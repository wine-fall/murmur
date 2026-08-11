# murmur dev workflow — one command to install, preflight, and run.
#
#   make dev            # terminal 1: set up, check deps, launch the app
#   make dev-fishaudio  # remote voice via fish.audio (.env.fishaudio -> .env)
#   make dev-opuslab    # remote voice via self-hosted opuslab (.env.opuslab; WARP on)
#   make logs           # terminal 2: tail the dev log + memory while it runs
#
# Knobs:  VOICE=hosted|stub            (hosted TTS by default)
#         STUB=1                       (full offline: canned brain, silent voice,
#                                        no music — needs no network/binaries)
#         TUI=0                        (plain stdout instead of the spec 10
#                                        front-end, which is the default; without
#                                        bun it falls back to plain on its own)
#         MURMUR_TUI_PET=0             (hide the pixel pet; the spectrum takes
#                                       the whole alive band — spec 10 §3.3)
#         MURMUR_SCENE=morning|afternoon|evening|late-night
#                                      (force the time-of-day scene for by-ear
#                                       testing; unset = derive from the clock)

.DEFAULT_GOAL := help

VOICE  ?= hosted
DEV_LOG := .dev/dev.log
MEM_LOG := .dev/mem.log

ifdef STUB
  RUN_ARGS       := --brain stub --voice stub --no-music --no-bed
  PREFLIGHT_ARGS := --no-music --voice stub
else
  RUN_ARGS       := --voice $(VOICE)
  PREFLIGHT_ARGS := --voice $(VOICE)
endif

# The TUI is the default front-end (spec 10 §6); TUI=0 is the explicit escape.
ifeq ($(TUI),0)
  RUN_ARGS       += --plain
  PREFLIGHT_ARGS += --plain
endif

.PHONY: help dev dev-fishaudio dev-opuslab logs preflight setup setup-music install sync-env

help:
	@echo "murmur dev:"
	@echo "  make dev          install deps, preflight, then launch the app"
	@echo "                    (loads .env; diagnostics -> $(DEV_LOG))"
	@echo "  make dev-fishaudio  select the fish.audio voice (.env.fishaudio -> .env)"
	@echo "  make dev-opuslab    select the self-hosted opuslab voice (keep WARP on)"
	@echo "  make logs         tail the dev log + memory (run in a 2nd terminal)"
	@echo "                    INFO timeline by default; DEBUG=1 unmutes everything"
	@echo "                    (memory is also recorded to $(MEM_LOG) while dev runs)"
	@echo "  make preflight    report music/voice/front-end deps without launching"
	@echo "  make setup        talk murmur through everything that is missing"
	@echo "  make setup-music  just the music binaries (yt-dlp/ffmpeg)"
	@echo ""
	@echo "  knobs:  VOICE=hosted|stub   STUB=1 (full offline)   TUI=0 (plain stdout)"

install: sync-env
	pnpm install
	@# The TUI client (spec 10) is its own Bun package, deliberately outside
	@# package.json. No bun, no TUI — and the plain front-end needs neither. A
	@# bun that IS present and whose install fails is a real blocker: do not
	@# swallow it, or `TUI=1 make dev` launches a client with no packages.
	@if command -v bun >/dev/null 2>&1; then (cd tui && bun install --silent); fi
	@# pre-commit is the gate runner (.pre-commit-config.yaml); installed as a
	@# uv-managed global tool since the repo itself carries no Python packaging.
	@command -v pre-commit >/dev/null 2>&1 || uv tool install --quiet pre-commit
	@pre-commit install >/dev/null 2>&1 || true

sync-env:
	@# A fresh linked git worktree does not inherit the gitignored .env* config
	@# (remote-voice creds: .env.fishaudio / .env.opuslab / .env) that lives in the
	@# main worktree. Copy any that are missing here so `make dev*` works out of the
	@# box. Read-only from main (never written back); a no-op in the main worktree;
	@# copy-if-absent, so a local override is never clobbered (rm to re-sync).
	@main=$$(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $$2; exit}'); \
	  here=$$(git rev-parse --show-toplevel 2>/dev/null); \
	  [ -n "$$main" ] && [ -n "$$here" ] && [ "$$main" != "$$here" ] || exit 0; \
	  for f in "$$main"/.env*; do \
	    [ -e "$$f" ] || continue; \
	    dst="$$here/$$(basename "$$f")"; \
	    [ -e "$$dst" ] || { cp "$$f" "$$dst" && echo "sync-env: copied $$(basename "$$f") from main worktree"; }; \
	  done

preflight:
	@if [ -f .env ]; then set -a; . ./.env; set +a; fi; \
	  node scripts/dev-preflight.ts $(PREFLIGHT_ARGS)

dev-fishaudio: sync-env
	@# Select the fish.audio backend: copy its config to .env, then run.
	@test -f .env.fishaudio || { echo "missing .env.fishaudio (fish.audio config)"; exit 1; }
	@cp .env.fishaudio .env
	@$(MAKE) dev

dev-opuslab: sync-env
	@# Select the self-hosted opuslab backend (keep WARP connected — auth to the
	@# endpoint is via Cloudflare Access, spec 02 §3.6).
	@test -f .env.opuslab || { echo "missing .env.opuslab (opuslab config)"; exit 1; }
	@cp .env.opuslab .env
	@$(MAKE) dev

dev: install
	@# Load the gitignored .env (MURMUR_TTS_URL / _SEED / …) and launch the app
	@# IMMEDIATELY — the front-end comes up first, and the app owns the whole
	@# onboarding surface in-session (spec 03-03 §7.1): probes, report, loading
	@# notice, and the repair conversation. The shell's only gate is a node that
	@# cannot run at all (§7.3 criterion 8); `make preflight` remains the
	@# no-launch reporter. Then launch with a side-car memory recorder (external,
	@# app-agnostic): it samples the process tree into mem.log for the whole run,
	@# torn down when the app exits. Its crash can never take murmur down;
	@# stderr lands in mem.log so a fatal crash is recorded, not swallowed.
	@if [ -f .env ]; then set -a; . ./.env; set +a; fi; \
	  node -e "" || { \
	    echo ""; \
	    echo "make dev stopped — node is not runnable here."; \
	    echo "install Node >= 24 and try again; everything else murmur fixes by talking."; \
	    exit 1; \
	  }; \
	  mkdir -p .dev && : > $(DEV_LOG) && : > $(MEM_LOG); \
	  echo ""; \
	  echo "▶ logs: open another terminal in this repo and run:  make logs"; \
	  echo "  (diagnostics -> $(DEV_LOG); memory -> $(MEM_LOG))"; \
	  echo ""; \
	  node scripts/memwatch.ts --out $(MEM_LOG) >/dev/null 2>>$(MEM_LOG) & \
	  MEMPID=$$!; \
	  trap 'kill $$MEMPID 2>/dev/null || true' EXIT INT TERM; \
	  MURMUR_DEV_LOG=$(DEV_LOG) node src/main.ts $(RUN_ARGS)

LOG_LEVEL ?= INFO
ifdef DEBUG
  LOG_LEVEL := DEBUG
endif

logs:
	@node scripts/devwatch.ts --log $(DEV_LOG) --level $(LOG_LEVEL)

setup: sync-env
	@# The whole onboarding surface as one conversation: music binaries, bun,
	@# and the voice endpoint (spec 03-03 §7.1). Loads .env so an endpoint you
	@# already have is seen as configured rather than asked about again.
	@# --voice carries the run's own voice choice through; the endpoint is
	@# considered either way (issue #93), so this only picks what plays after.
	@if [ -f .env ]; then set -a; . ./.env; set +a; fi; \
	  node src/main.ts --setup --voice $(VOICE)

setup-music:
	node src/main.ts --setup-music

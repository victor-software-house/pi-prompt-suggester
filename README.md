# pi-prompt-suggester

A pi extension that suggests the user's likely next prompt after each assistant completion.

## Core idea

Instead of naive autocomplete, `pi-prompt-suggester` uses a two-stage approach:

1. **Seeding pass (meta-meta prompt, infrequent):**
   - Explore repository intent from vision/docs/code signals
   - Produce a compact, reusable `intent seed`
   - Recompute when important files or seed policy versions change

2. **Suggestion pass (meta prompt, frequent):**
   - Use recent conversation trajectory + latest assistant completion + `intent seed`
   - Generate a high-quality next-prompt suggestion
   - Render as ghost text when editor state is compatible (no widget fallback)

## Current implementation

Implemented end-to-end:
- async, non-blocking seed generation and reseeding
- seed persistence in `.pi/suggester/seed.json`
- session/branch-aware suggester state in extension-owned files under `.pi/suggester/sessions/` (not Pi session JSONL)
- one-time legacy migration from old `suggester-state` / `suggester-usage` Pi custom entries, then ignore-old-entries behavior
- `agent_end`-driven prompt suggestion generation
- fast-path `continue` for non-success completions (`error` and `aborted`) when enabled
- ghost-only suggestion display with guarded editor compatibility checks
- steering capture from the next real user input
- persistent observability log in `.pi/suggester/logs/events.ndjson`
- separate usage accounting for suggester + seeder model calls (with combined totals in `/suggester status`)
- session-persistent usage ledger so totals survive reload/resume
- `/suggester status`, `/suggester reseed`
- `/suggester model ...`, `/suggester thinking ...`, `/suggester seed-trace [limit]`
- `/hint-suggest` and `/quote-suggest` for reject+hint regeneration

## Key files

- [`vision.md`](./vision.md)
- [`docs/architecture.md`](./docs/architecture.md)
- [`docs/meta-prompts.md`](./docs/meta-prompts.md)
- [`docs/architecture-decisions.md`](./docs/architecture-decisions.md)
- [`docs/roadmap.md`](./docs/roadmap.md)
- [`config/prompt-suggester.config.json`](./config/prompt-suggester.config.json) ← single source of truth for the base config

## Install

### Install from npm (recommended)

Global install (all projects):

```bash
pi install npm:@guwidoe/pi-prompt-suggester
```

Project-local install (current repo only):

```bash
pi install -l npm:@guwidoe/pi-prompt-suggester
```

Pin a specific version if needed:

```bash
pi install npm:@guwidoe/pi-prompt-suggester@0.1.14
```

After install, restart `pi` or run `/reload`.

### Manual settings.json entry

Add to `packages` in `~/.pi/agent/settings.json` (global) or `.pi/settings.json` (project):

```json
{
  "packages": [
    "npm:@guwidoe/pi-prompt-suggester"
  ]
}
```

## Usage

### Local development usage
- direct load for testing: `pi -e ./src/index.ts`
- project-local extension file in `.pi/extensions/` that re-exports `src/index.ts`

### Main command
All controls are under `/suggester`.

- `/suggester` or `/suggester status` — current seed/status, model/thinking overrides, and usage breakdown (suggester/seeder/combined)
- `/suggester reseed` — trigger async reseed
- `/suggester model [show|set|clear] <seeder|suggester> [provider/model|session-default]`
- `/suggester thinking [show|set|clear] <seeder|suggester> [minimal|low|medium|high|xhigh|session-default]`
- `/suggester config [show|set [project|user] <path> <value>|reset [project|user|all]]` — inspect, set, or reset overrides
- `/suggesterSettings` — interactive TUI settings menu for common suggester options
- `/suggester seed-trace [limit]` — show latest seeder run trace from persistent logs

### Reject + hint commands
- `/hint-suggest` — reject current suggestion, provide hint, regenerate
- `/quote-suggest` — same, but also inject rejected suggestion text

### Config
Base config:
- `config/prompt-suggester.config.json`

Optional overrides:
- user: `~/.pi/suggester/config.json`
- project: `.pi/suggester/config.json`

Merge order:
1. base config (repo file)
2. user override
3. project override

Notes:
- config now has `schemaVersion`; override files are only rewritten when a schema migration is needed.
- `inference.* = session-default` means “use current pi session model/thinking”.
- `feedback.*` controls reject+hint memory and hinted suggestion length.
- `/suggester model ...` and `/suggester thinking ...` edit project override (`.pi/suggester/config.json`) and apply immediately (no extension reload).
- `/suggester config set [project|user] <path> <value>` writes to the selected override file and applies immediately.
- `/suggester config set suggestion.maxSuggestionChars 200` updates prompt length in project override.
- `/suggesterSettings` provides an interactive top-level TUI menu so users do not need to remember the config commands.
- `/suggester config reset [project|user|all]` deletes override files so behavior returns to defaults.

### Runtime artifacts
- seed: `.pi/suggester/seed.json`
- per-session state: `.pi/suggester/sessions/<session-id>/`
- logs: `.pi/suggester/logs/events.ndjson`

Legacy note:
- older versions wrote `suggester-state` / `suggester-usage` custom entries into Pi session JSONL
- current versions import those legacy entries once into extension-owned storage and ignore the old Pi session entries afterwards

### Behavior summary
- Suggestion generation runs on `agent_end`
- Non-success turns (`error`, `aborted`) can fast-path to `continue` (configurable)
- Suggestions are ghosted in editor when safe (including multiline only when editor is empty)
- Press `Space` on an empty editor to accept the full ghost suggestion
- If editor state is incompatible, ghost suggestion is hidden (no below-editor fallback widget)
- `/suggester status` reports separate suggester usage, seeder usage, and combined totals (session-persistent across reload/resume)
- Footer now wraps extension statuses (including suggester usage/tokens) across multiple lines instead of truncating to one line

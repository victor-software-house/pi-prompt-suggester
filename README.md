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
   - Safely prefill the editor when possible, otherwise show the suggestion as a widget

## Current implementation

Implemented end-to-end:
- async, non-blocking seed generation and reseeding
- seed persistence in `.pi/suggester/seed.json`
- session/branch-aware steering history via pi custom session entries
- `agent_end`-driven prompt suggestion generation
- fast-path `continue` for error completions; aborted turns use model-based suggestion with abort context
- suggestion display with guarded editor prefill
- steering capture from the next real user input
- persistent observability log in `.pi/suggester/logs/events.ndjson`
- `/suggester status`, `/suggester reseed`
- `/suggester model ...`, `/suggester thinking ...`, `/suggester seed-trace [limit]`

## Key files

- [`vision.md`](./vision.md)
- [`docs/architecture.md`](./docs/architecture.md)
- [`docs/meta-prompts.md`](./docs/meta-prompts.md)
- [`docs/architecture-decisions.md`](./docs/architecture-decisions.md)
- [`docs/roadmap.md`](./docs/roadmap.md)
- [`config/prompt-suggester.config.json`](./config/prompt-suggester.config.json) ← single source of truth for the base config

## Usage

### Load the extension
Use one of:
- project-local extension file in `.pi/extensions/` that re-exports `src/index.ts`
- direct load for testing: `pi -e ./src/index.ts`

### Main command
All controls are under `/suggester`.

- `/suggester` or `/suggester status` — current seed/status, model/thinking overrides, usage summary
- `/suggester reseed` — trigger async reseed
- `/suggester model [show|set|clear] <seeder|suggester> [provider/model|session-default]`
- `/suggester thinking [show|set|clear] <seeder|suggester> [minimal|low|medium|high|xhigh|session-default]`
- `/suggester seed-trace [limit]` — show latest seeder run trace from persistent logs

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
- `inference.* = session-default` means “use current pi session model/thinking”.
- `/suggester model ...` and `/suggester thinking ...` edit `.pi/suggester/config.json` then reload.

### Runtime artifacts
- seed: `.pi/suggester/seed.json`
- logs: `.pi/suggester/logs/events.ndjson`

### Behavior summary
- Suggestion generation runs on `agent_end`
- Error turns can fast-path to `continue` (configurable)
- Aborted turns are model-suggested with abort context
- Suggestions are ghosted in editor when safe; otherwise shown below editor

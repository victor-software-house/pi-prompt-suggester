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
- session/branch-aware steering + model/thinking overrides via pi custom session entries
- `agent_end`-driven prompt suggestion generation
- fast-path `continue` for error completions; aborted turns use model-based suggestion with abort context
- suggestion display with guarded editor prefill
- steering capture from the next real user input
- persistent observability log in `.pi/suggester/logs/events.ndjson`
- `/suggester status`, `/suggester reseed`, `/suggester clear`
- `/suggester model ...`, `/suggester thinking ...`, `/suggester seed-trace [limit]`

## Key files

- [`vision.md`](./vision.md)
- [`docs/architecture.md`](./docs/architecture.md)
- [`docs/meta-prompts.md`](./docs/meta-prompts.md)
- [`docs/architecture-decisions.md`](./docs/architecture-decisions.md)
- [`docs/roadmap.md`](./docs/roadmap.md)
- [`config/prompt-suggester.config.json`](./config/prompt-suggester.config.json) ← single source of truth for the base config

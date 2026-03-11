# Architecture Decisions (Current)

## 1) Seed is project-global; runtime behavior is session/branch-local
- **Decision:** store seed in `.pi/suggester/seed.json`, store interaction/runtime state in `prompt-suggester-state` custom session entries.
- **Why:** project intent is repo-wide, while suggestions/steering/overrides are branch-specific.

## 2) Suggestion generation runs on `agent_end`
- **Decision:** trigger suggestions after the full completion, not each internal tool turn.
- **Why:** avoids premature suggestions during multi-turn tool execution.

## 3) Reseeding is asynchronous with trigger coalescing
- **Decision:** run one reseed at a time; merge pending triggers while busy.
- **Why:** keeps UX responsive and avoids duplicate reseeds.

## 4) Seeder is agentic and read-only by protocol
- **Decision:** seeder performs iterative exploration via `ls/find/grep/read` before finalizing.
- **Why:** better repository understanding than static context packing.

## 5) Required categories must be explicitly reported, including not-found
- **Decision:** require `categoryFindings` for `vision`, `architecture`, `principles_guidelines` with `found`, `rationale`, `files`.
- **Why:** prevents silent omissions while allowing honest “not found” outcomes.

## 6) Seed contains both structured lists and concise summaries
- **Decision:** keep `topObjectives[]` and `constraints[]`, plus summaries for intent/objectives/constraints/principles/status.
- **Why:** prompt generation needs both compact narrative context and list-style anchors.

## 7) Aborted turns go through model path; error turns may fast-path
- **Decision:** preserve configurable fast-path `continue` for `error`; include abort context for `aborted` and run normal suggestion generation.
- **Why:** aborted turns are often intentional pivots and benefit from contextual suggestions.

## 8) Suggestion UX uses ghost editor + guarded fallback
- **Decision:** render ghost suggestion when safe; otherwise show below-editor widget.
- **Why:** maximize low-friction acceptance without clobbering user input.

## 9) Per-role model and thinking overrides are persisted
- **Decision:** `seeder` and `suggester` each support override for model and thinking level via commands.
- **Why:** quality/cost tuning differs between deep seeding and fast next-prompt suggestion.

## 10) Observability is persisted to bounded NDJSON logs
- **Decision:** log seeder and suggestion events to `.pi/suggester/logs/events.ndjson` with truncation/rotation.
- **Why:** enables post-run debugging/tuning without noisy stdout.

## 11) Operational command surface remains unified under `/suggester`
- **Decision:** status/reseed/clear/model/thinking/seed-trace are subcommands.
- **Why:** one discoverable command namespace keeps UX coherent.

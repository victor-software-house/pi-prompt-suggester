# Architecture Decisions (Current)

## 1) Seed is project-global; runtime behavior is session/branch-local
- **Decision:** store seed in `.pi/suggester/seed.json`, and store interaction/runtime state in extension-owned files under `.pi/suggester/sessions/<session-id>/`, not in Pi session JSONL.
- **Why:** project intent is repo-wide, while per-branch suggestion/steering traces should stay with the active conversation branch without contaminating or coupling to Pi’s official session storage.

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

## 7) Non-success turns may fast-path to `continue`
- **Decision:** preserve configurable fast-path `continue` for both `error` and `aborted` turns.
- **Why:** keeps recovery/pivot behavior immediate and predictable after unsuccessful completions.

## 8) Suggestion UX is ghost-only with guarded rendering
- **Decision:** render ghost suggestion only when editor state is compatible; otherwise hide it.
- **Why:** keep the UX minimal and avoid a separate below-editor fallback surface.

## 9) Per-role model and thinking overrides are persisted in project config
- **Decision:** `seeder` and `suggester` each support override for model and thinking level via commands, written to `.pi/suggester/config.json`.
- **Why:** quality/cost tuning differs between deep seeding and fast next-prompt suggestion, and file-backed config survives restarts.

## 10) Observability is persisted to bounded NDJSON logs
- **Decision:** log seeder and suggestion events to `.pi/suggester/logs/events.ndjson` with truncation/rotation.
- **Why:** enables post-run debugging/tuning without noisy stdout.

## 11) Usage accounting is tracked per pipeline and persisted per session
- **Decision:** persist separate usage counters for suggestion generation and seeding in extension-owned per-session files, and expose combined totals in `/suggester status`.
- **Why:** seeding can be expensive and should be visible independently from turn-time suggestion cost, and totals must survive extension reload/session resume without writing extension-private data into Pi session JSONL.

## 12) Operational command surface remains unified under `/suggester`
- **Decision:** status/reseed/model/thinking/config/seed-trace are subcommands.
- **Why:** one discoverable command namespace keeps UX coherent.

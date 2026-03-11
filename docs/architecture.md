# Architecture (Current)

## Overview

`pi-prompt-suggester` has five runtime pieces:

1. **Suggestion pipeline** (runs on `agent_end`)
2. **Agentic reseed runner** (background, non-blocking)
3. **Steering tracker** (session/branch-aware)
4. **UI sink** (ghost suggestion + fallback widget + usage line)
5. **Persistent observability log** (`.pi/suggester/logs/events.ndjson`)

---

## 1) State model

### Project-global (file)
`./.pi/suggester/seed.json`

Contains:
- seed summaries (intent/objectives/constraints/principles/status)
- key files (+ hashes + category)
- required-category findings (`vision`, `architecture`, `principles_guidelines`) with `found/not_found` rationale
- generator/prompt/config fingerprints

### Session/branch-local (pi custom entries)
`prompt-suggester-state`

Contains:
- last shown suggestion
- steering history (`accepted_exact | accepted_edited | changed_course`)
- suggester usage/cost counters
- per-role overrides: `seeder` and `suggester` model + thinking level

---

## 2) Agentic seeding

Reseeding is queued async and never blocks interaction.

Trigger points:
- session lifecycle events (`session_start/tree/fork/switch`)
- `agent_end` stale check
- manual `/suggester reseed`

Seeder implementation:
- iterative model loop with read-only tools: `ls`, `find`, `grep`, `read`
- explicit required-category coverage in final output
- accepts `found: false` when rationale is provided
- multiple files per category supported

Validation requires:
- all required `categoryFindings`
- non-empty rationale for each
- if `found=true`, at least one matching key file tagged with that category

---

## 3) Suggestion pipeline

Trigger:
- `agent_end` only

Inputs:
- assistant completion + status (`success | error | aborted`)
- recent user prompts
- tool signals + touched files + unresolved questions
- full intent seed summaries + categorized key files + category findings
- recent accepted/changed steering examples

Behavior:
- non-success turns (`error`, `aborted`) can fast-path to `continue` (configurable)
- output is one suggestion or `[no suggestion]`
- multi-line suggestions allowed; bounded by `maxSuggestionChars`

---

## 4) UI behavior

- Single-line suggestions can ghost in editor when safe (idle, no pending messages, editor-empty policy)
- Space-to-accept when editor is empty
- Multiline (and non-compatible) suggestions render below editor as wrapped content with keyboard scrolling
- Footer lines:
  - path/model/token/context lines
  - wrapped extension status lines (including suggester usage) when content exceeds width

---

## 5) Observability

Persistent log file:
- `.pi/suggester/logs/events.ndjson`

Logged events include:
- seeder run start/completion/exhaustion
- seeder tool requests/results and validation failures
- suggestion turn received, suggestion generated, no-suggestion
- steering classification events

Inspection:
- `/suggester seed-trace [limit]`
- `/suggester status` includes log path

---

## 6) Commands

- `/suggester status`
- `/suggester reseed`
- `/suggester model [show|set|clear] ...` (writes `.pi/suggester/config.json`)
- `/suggester thinking [show|set|clear] ...` (writes `.pi/suggester/config.json`)
- `/suggester seed-trace [limit]`
- `/hint-suggest` (reject + hint)
- `/quote-suggest` (reject + hint + rejected text)

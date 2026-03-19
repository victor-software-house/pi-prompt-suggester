# Empty-text failure analysis

Date: 2026-03-19

## What failed

Observed user-facing error:

`Extension ".../pi-prompt-suggester/dist/index.js" error: Model returned empty text`

The exception is raised in `src/infra/model/pi-model-client.ts`:

- it calls `extractText(response.content)`
- if the extracted text is empty after trimming, it throws `Model returned empty text`

That exception is then allowed to escape the compact suggestion path and becomes a Pi extension error.

## What can make the model look "empty"

This does not necessarily mean the upstream model literally produced nothing at the API boundary. In this codebase, "empty" means:

- no `type: "text"` blocks were present in `response.content`, or
- text blocks existed but were empty or whitespace only after trimming

So there are several plausible causes.

### 1. Provider returned a response with no final message text

Most likely with the active session model here:

- provider: `openai-codex`
- model: `gpt-5.4`

That provider goes through the experimental Codex Responses transport in Pi:

- `packages/ai/src/providers/openai-codex-responses.ts`
- it uses `OpenAI-Beta: responses=experimental`
- it maps `response.incomplete` into a normal completion event path

If upstream returns:

- a reasoning item only
- an incomplete response with no output text item
- a transport edge case where completion happens without `output_text` events

then `response.content` can end up with no usable text blocks.

### 2. The extension is treating "incomplete" as fatal because it ignores stop reason

Pi's shared OpenAI responses stream processor maps status like this:

- `completed` -> `stop`
- `incomplete` -> `length`

That means the provider layer already knows a response may finish without a proper full answer.

But the extension does not inspect `stopReason` before enforcing text presence. It only does:

- extract text
- throw if empty

So an incomplete-but-non-crashing provider response can be misclassified as a hard extension failure.

### 3. The parser is stricter than the provider contract edge cases

`extractText()` only accepts blocks with:

- `block.type === "text"`

It ignores everything else.

That is fine when the provider always materializes a final text block. It is brittle when the provider returns:

- only `thinking`
- an empty `text`
- a response shape where text deltas never made it into the final normalized message

For suggestions, this should usually degrade to "no suggestion", not a visible crash.

### 4. Two model calls are started almost simultaneously on session start

This repo currently does two things on session start:

1. `SessionStartOrchestrator.handle()` can trigger reseeding in the background
2. `src/index.ts` then bootstraps a historical turn and immediately runs suggestion generation for it

From the live event log, these started about 10 ms apart:

- `reseed.started`
- `suggestion.turn.received`

That means the extension can hit the same model/provider twice at startup.

This does not prove concurrency is the root cause, but it increases the chance of exposing:

- provider-side race conditions
- session/account throttling behavior
- experimental transport bugs
- empty/incomplete side responses

## Is input building OK?

Mostly yes.

### Compact suggestion input

For the normal compact path, the extension builds:

- one user text message containing the rendered prompt
- optional system prompt

That is a normal Pi/Responses request shape.

Relevant files:

- `src/app/services/prompt-context-builder.ts`
- `src/prompts/suggestion-template.ts`
- `src/infra/model/pi-model-client.ts`

I do not see malformed message construction there.

### Seeder input

Seeder calls also use standard text messages plus a system prompt. The tool-call protocol is JSON-in-text, but the request envelope itself is valid.

Relevant files:

- `src/prompts/seeder-template.ts`
- `src/infra/model/pi-model-client.ts`

### Input risks that are real, but probably not the primary root cause

There are still a few input-side risks:

- `maxAssistantTurnChars` is very high (`100000`)
- seeder prompts can become large after exploration history accumulates
- session-start bootstrap triggers extra suggestion generation automatically

Those can increase model stress or push incomplete responses, but they do not look like malformed input bugs.

## Is output processing OK?

Not really. It is acceptable for the happy path, but too brittle for production.

### What is OK

For standard successful responses, the pipeline is coherent:

- Pi provider normalizes responses into content blocks
- the extension extracts text blocks
- suggestion engine trims and normalizes the result

### What is not OK

#### A. Empty text is treated as an exception in all cases

That is too strict for suggestions.

A suggestion request is optional behavior. Empty output should usually become:

- `no_suggestion`
- cleared ghost text
- a debug log entry

It should not become a user-visible extension failure.

#### B. The compact path has no recovery boundary

Transcript-cache mode already has a fallback to compact mode if transcript generation fails.

The compact mode itself has no fallback.

If `modelClient.generateSuggestion()` throws, the error bubbles through:

- `SuggestionEngine`
- `TurnEndOrchestrator`
- `onAgentEnd`
- Pi extension runner

#### C. Seeder and suggestion paths share the same hard-empty behavior

That is the wrong abstraction.

These two flows have different requirements:

- seeder final synthesis needs structured non-empty output and can legitimately fail hard
- suggestion generation is optional and should fail closed

Right now both go through the same hard-empty check in `completePrompt()`.

## Most likely explanation for the real-world failure here

Most likely sequence:

1. active session model was `openai-codex/gpt-5.4`
2. the extension inherited that model because config was `session-default`
3. on session start, it kicked off reseeding and bootstrap suggestion generation almost at the same time
4. one or both provider calls completed without a usable final text block
5. `extractText(...).trim()` returned empty
6. the extension threw `Model returned empty text`
7. suggestion path leaked the exception to Pi; reseed path logged repeated failures and kept retrying later

## Strongest hypotheses, ranked

### Highest confidence

1. output handling is too strict for suggestion generation
2. empty/incomplete provider responses are not downgraded safely
3. startup concurrency increases the chance of hitting this edge case

### Medium confidence

4. the experimental `openai-codex` responses transport is occasionally producing completion events without usable text blocks
5. incomplete responses are being surfaced as empty text because the extension ignores response semantics and only checks extracted text

### Lower confidence

6. prompt size occasionally causes incomplete responses with no text
7. SSE/WebSocket event normalization in the provider stack is dropping an output-text path in a narrow edge case

## What should change

### For suggestions

Change empty output handling from hard failure to safe no-op.

Concrete rule:

- if suggestion output has no usable text, return `kind: "no_suggestion"`
- do not throw

### For seeding

Keep strictness, but add backoff.

Concrete rule:

- seeder can still fail hard on empty final output
- repeated automatic reseed failures should not retrigger immediately on every session start

### For observability

When this happens, log enough data to tell which category occurred:

- model ref
- stop reason
- response content block types
- whether output was truly empty, whitespace-only, or thinking-only
- whether the call happened during startup bootstrap, normal turn-end suggestion, or reseed

## Short answer

The input building looks structurally OK.

The output processing is not OK for a runtime extension that runs automatically.

The most probable failure is not "the model is broken". It is:

- upstream returned an incomplete or textless response
- the extension treated that as fatal
- the startup flow made the situation easier to trigger by firing multiple calls immediately

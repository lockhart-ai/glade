# OpenRouter integration

Implementation reference for #551, awaiting review. Glade keeps the Claude Agent SDK, its agent loop, Glade tools,
permissions, sandbox and event parser. A small Electron-main relay handles OpenRouter inference.

## Settings and task selections

Settings › Models connects an inference key while the Claude Code account stays active. Main encrypts the key with
Electron `safeStorage`; SQLite holds ciphertext and cached metadata. Snapshots never contain the saved key.
Replacement validates the catalog first. Removal retains saved routes and task histories.

Discovery uses authenticated `/models/user`, `/providers`, `/models/{author}/{slug}/endpoints` and
`/models?providers=…`. Models need text input/output and tools. Selected endpoint metadata supplies its prices,
parameters and context window. Provider filtering intersects API results with the key-visible catalog. Refresh is
explicit; cached choices survive relaunch.

Detected providers are hosting options, not configured BYOK credentials. Ordinary inference keys cannot enumerate
those credentials. Settings links to OpenRouter integrations rather than requesting a management key. Catalog
availability is not a paid connection test or a guarantee that every model runs the complete agent workflow.
[Filtered catalog](https://openrouter.ai/docs/api/api-reference/models/list-models-filtered-by-user-provider-preferences-privacy-settings-and-guardrails),
[model endpoints](https://openrouter.ai/docs/api/api-reference/endpoints/list-all-endpoints-for-a-model).

Choose one provider per model, then enable it. Only enabled choices join Claude models in task, retry and default
pickers. Providers are chosen in Settings. Changing provider creates a different route; existing tasks retain their
previous pair. Disabled routes or removed keys never cause an automatic replacement: enable the saved pair or
choose another model to continue. A task retains its saved model/provider name.

The durable selection ID is `openrouter:<model>@<provider>`. Claude selections retain existing IDs/aliases. Source
is derived from this ID, so old tasks need no source backfill. Optional `subagentModel` and Settings'
`defaultSubagentModel` are `null` for **Same as task**.

| Parent | Native SDK subagents |
| --- | --- |
| Claude account | Same task model or another Claude model |
| OpenRouter | Same route or another enabled OpenRouter route |
| Claude account with OpenRouter children | Not supported in this version |

Native SDK children inherit the parent's endpoint and credentials. Helper aliases stay within the session's
allowed OpenRouter choices. Independent Glade tasks can use different sources concurrently.

## Switching an existing task

A source change, OpenRouter model change or child-model change needs a stopped or waiting task, with no active
turn, question, permission or background work. Stop or finish that work first. Ordinary Claude model changes keep
the existing next-turn behavior.

For a task with a session, the runner prepares a provisional process with the same SDK session ID, persisted
transcript, workspace, tools and permissions. Queued input waits for SDK initialization and sandbox setup. Only
then does the runner commit the selection and close the previous session. Startup failure keeps the original
selection, history and pause. A task without a session simply saves its initial selection.

A limit-paused Claude task can switch to OpenRouter; **Resume now** or a new message continues it without waiting
for the Claude subscription reset. OpenRouter failures do not update Claude account usage, trigger Claude login
or enter the Anthropic plan-resume scheduler.

Once applied, a change adds one quiet, timestamped Tool calls entry: **Switched model to Sample Flash · Sample Host
(OpenRouter)**. An ordinary Claude change is recorded after SDK acknowledgement. Pending changes and immutable
previous/new IDs and labels persist; relaunch does not duplicate entries. Chat, calls/results, child histories,
artifacts and queued messages retain their content and order.

## SDK adapter and relay

`openrouter/runtime.ts` prepares environments; `relay.ts` adapts Messages requests. Opaque internal SDK aliases map
back to durable Glade routes. Each relay binds to loopback and accepts only authenticated Messages requests, with
a random session token. The SDK's `?beta=true` URL is accepted; query fields never alter the upstream route.

The relay inserts the real key only on requests to `https://openrouter.ai/api/v1/messages`. It maps its allowed
parent/child choices and pins `provider.only` with `allow_fallbacks: false`. Model fallbacks, presets and automatic
routing fields are removed. Caller credentials/headers and arbitrary URLs are never forwarded. Browser-origin
requests are refused. Streams use backpressure and cancellation; closing the session revokes the route.

OpenRouter processes have a separate configuration directory. Credential/cloud variables are explicitly cleared:
the SDK merges the parent process environment underneath its overrides, so omission is insufficient. Claude
processes retain their configuration/login while clearing inherited OpenRouter secrets. Project instructions,
tool permissions and Glade hooks continue through the existing backend.

Messages thinking/effort fields follow endpoint capabilities; other output configuration fields remain intact.
Text-only routes reject image-containing requests explicitly. The SDK's unknown-model 200K default is overridden
with the smallest actual context window of its allowed routes. Production probing confirmed the override.
SDK fallback Claude pricing is not an OpenRouter bill.
[Messages API](https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-messages?explorer=true).

## Durable history and usage

SDK 0.3.283's alpha `sessionStore` interface mirrors opaque entries into SQLite with eager flush. Main and child
transcripts retain UUIDs, tool results, thinking/signatures and metadata. `importSessionToStore` imports legacy
history before an OpenRouter handoff; missing history fails explicitly. Ordinary legacy Claude resumption can
still use SDK files if its alpha importer cannot mirror them.

Append writes only new or updated entries, retaining history order without rewriting a long transcript. Separate
task owners isolate sessions copied from the same SDK ID. Transcript, switch and generation records are task-owned and deleted with their task. Generation IDs are recorded
once, including child/helper requests. Actual provider and billed cost come from `/generation`; delayed metadata
remains pending and is reconciled after later requests and at launch. No billing dashboard is added.

SDK alpha APIs and non-Claude protocol compatibility need validation on SDK updates. A tool-capable catalog entry
is not evidence that every native command, compaction, custom agent or cross-source thinking signature works.
Provider errors remain explicit and archived history stays available.

## Validation evidence

Initial isolated probes established direct/SDK echo, native children, an MCP tool and persisted OpenRouter resume
on DeepSeek V4.1 Flash / Together. Seven routed requests cost approximately $0.00239.

One separately authorized minimal Claude subscription probe used tools-disabled Haiku (395 input / 4 output).
OpenRouter resumed the same session and recalled a random code absent from the new prompt. This established basic
Claude-to-OpenRouter text continuation. No further Anthropic inference was performed during implementation.

Production adapter probes verified the beta URL, credential clearing, internal alias, provider pin, real 1M
context override and SQLite store. Echo used 215 input / 19 output tokens and billed $0.0000873 on Together. A real
SDK MCP tool turn followed by a fresh OpenRouter process recalled its random tool result, retaining the same session
and thinking/tool-result entries. The final store probe made three requests, all billed by Together, totaling
$0.000290244. Handcrafted transcript injection was insufficient evidence because SDK replay
checkpoints can exclude artificial appended entries. Cross-source signed thinking and reverse paid Claude
inference were not separately live-probed.

Automated tests mock catalog/inference traffic and use the existing fake agent. They cover credential/source
isolation, discovery, key races, route failures, opaque history, deletion, switch entries, sandbox readiness,
queue holding, rollback, limit recovery and same-source children. Hidden Electron tests cover connection errors,
curation, provider filtering, continuation, relaunch and switching back. Capture/e2e mode uses an offline catalog,
even if supplied a real key.

Approved UI references are [screens 56–59](design/openrouter-mockups.md). Migration 65 and typed bridge commands
extend existing repositories and Settings/picker surfaces without a general backend refactor.

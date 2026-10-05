# OpenRouter integration

Implementation reference for #551, following the user-approved scope and UI. The PR is under review. Glade keeps the Claude Agent SDK, its agent loop, Glade tools,
permissions, sandbox and event parser. A small Electron-main relay handles OpenRouter inference.

## Settings and task selections

Settings › Models connects an inference key while the Claude Code account stays active. Main encrypts the key with
Electron `safeStorage`; SQLite holds ciphertext and cached metadata. Snapshots never contain the saved key.
Replacement validates the catalog first. Removal retains saved routes and task histories. Removing/disabling a default route restores Claude defaults, without changing existing tasks.

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
previous pair. Existing tasks on disabled routes or removed keys never receive an automatic replacement: enable the saved pair or
choose another model to continue. A task retains its saved model/provider name.

The durable selection ID is `openrouter:<model>@<provider>`. Claude selections retain existing IDs/aliases. Source
is derived from this ID, so old tasks need no source backfill. There is no saved blanket subagent model or second
input-bar picker. The parent chooses a model for each dispatch. Claude retains native Agent model selection.
OpenRouter registers a named SDK agent definition for each enabled route, using its full opaque model ID.
Descriptions give the selected provider, context window and indicative input/output prices; the parent selects
`subagent_type` and omits `model`, whose native schema accepts only Claude aliases.

| Parent | Native SDK subagents |
| --- | --- |
| Claude account | The parent chooses a Claude model for each dispatch |
| OpenRouter | The parent chooses an enabled OpenRouter route for each dispatch |
| Claude account with OpenRouter children | Not supported in this version |

Definitions and route metadata are captured when the SDK process starts; a later catalog change applies when a
process next starts. Existing native children retain their prepared routes and context limit.

Native SDK children inherit the parent's endpoint and credentials. Helpers and built-in subagent types use the
parent's OpenRouter route; named subagents use their own enabled routes. Independent Glade tasks can use different sources concurrently.

## Switching an existing task

A source change or OpenRouter model change needs a stopped or waiting task, with no active
turn, question, permission or background work, including scheduled wakeups and cron jobs. Stop or finish that work first. Ordinary Claude model changes keep
the existing next-turn behavior.

For a task with a session, the runner prepares a provisional process with the same SDK session ID, persisted
transcript, workspace, tools and permissions. Queued input waits for SDK initialization and sandbox setup. Only
then does the runner commit the selection and close the previous session. Startup failure or a 30-second initialization timeout closes the candidate and keeps the original
selection, history and pause. A task without a session simply saves its initial selection.

Switching a limit-paused Claude task to OpenRouter resumes its held turn immediately, without waiting for the
Claude subscription reset. The picker displays **Switching…** and holds sending until preparation completes.
The banner switches paused tasks sequentially, avoiding simultaneous transcript imports. OpenRouter failures do not update Claude account usage, trigger Claude login
or enter the Anthropic plan-resume scheduler.

Once applied, a change adds one quiet, timestamped Agents › Main log entry: **Switched model to Sample Flash · Sample Host
(OpenRouter)**. An ordinary Claude change is recorded after SDK acknowledgement. Pending changes and immutable
previous/new IDs and labels persist; relaunch does not duplicate entries. Chat, calls/results, child histories,
artifacts and queued messages retain their content and order.

## SDK adapter and relay

`openrouter/runtime.ts` prepares environments; `relay.ts` adapts Messages requests. Opaque internal SDK aliases map
back to durable Glade routes. Each relay binds to loopback and accepts only authenticated Messages requests, with
a random session token. The SDK's `?beta=true` URL is accepted; query fields never alter the upstream route.

The relay inserts the real key only on requests to `https://openrouter.ai/api/v1/messages`. It maps its allowed
enabled choices and pins `provider.only` with `allow_fallbacks: false`. The request schema allowlists Messages fields, stripping model fallbacks, presets, plugins, transforms and other
routing fields. Provider error messages are bounded/redacted and preserved for SDK recovery; 402 gets an explicit
insufficient-credit fallback. HTTP status and message are logged in the task’s agent scope. No catalog request gates
session startup: a withdrawn provider fails honestly on the first inference request. Caller credentials/headers and arbitrary URLs are never forwarded. Browser-origin
requests are refused. Malformed requests fail locally with 400; a removed key receives a Settings-specific message. Transport failures
close the connection so SDK retries and Glade’s Offline pause can work; logs retain a bounded, redacted reason.
Streams use backpressure and cancellation; closing the session revokes the route.

OpenRouter processes have a separate configuration directory. Credential/cloud variables are explicitly cleared:
the SDK merges the parent process environment underneath its overrides, so omission is insufficient. Claude
processes retain their configuration/login while clearing inherited OpenRouter secrets. Project instructions,
tool permissions and Glade hooks continue through the existing backend. Claude user instructions, skills, agents,
commands, hooks, plugins, user MCP servers and existing auto-memory do not transfer to the isolated OpenRouter
configuration. The task picker names the separate user settings/memory; the guide lists what is omitted.
The private SDK cache is inside the denied Glade data folder, so sandboxed file tools cannot read large tool results
or auto-memory saved there. This limitation needs a manual sandboxed workflow check before release.
Sandbox credentials deny `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`. Unsandboxed commands, session hooks and
stdio MCP servers can inherit the short-lived relay token; it grants inference on the session’s routes until close.

Messages thinking/effort fields follow endpoint capabilities; other output configuration fields remain intact.
Text-only routes reject image-containing requests explicitly. The SDK's unknown-model 200K default is overridden
with the smallest actual context window of its enabled routes. Production probing confirmed the override.
The context meter uses that prepared limit, including after catalog changes during a session. Helper calls and
built-in subagent types use the parent route. Glade does not set a blanket native child model; explicit named
definitions select each child's route. SDK fallback Claude pricing is not an OpenRouter bill.
[Messages API](https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-messages?explorer=true).

## Durable history and usage

Ordinary Claude tasks retain SDK transcript files, without an import or a mirror. Only tasks that use OpenRouter
opt into SDK 0.3.283’s alpha `sessionStore` with eager flush. Main/child entries retain UUIDs, tool results,
thinking/signatures and metadata. `importSessionToStore` imports legacy history at the first OpenRouter handoff;
missing history fails explicitly. A provisional import is adopted in the same database transaction as the
selection; failure or cancellation discards it. An uncommitted copy after a crash is never treated as the task’s
active history. A retry reimports the latest Claude files. Returning to Claude uses the adopted mirror for that task.
An inherited login-shell `CLAUDE_CONFIG_DIR` is honored when importing local JSONL history, including child entries
and metadata sidecars. Ordinary Claude tasks preserve the user’s own inherited subagent-model setting.

Append writes only incoming entries, preserving order. Separate owners isolate copied SDK IDs. Mirrored entries
and switch records remain until task deletion, which cascades them. `mirror_error` stops the task and persists an
unreliable-history marker with the SDK config directory. The next start rebuilds the mirror from complete local SDK
files and clears the marker only on adoption. If recovery fails, the error explains how to restore the file or carry
the saved Glade chat into a new task; a shorter mirror is never loaded. There is no time-based
truncation. Closing before environment resolution never spawns a process: cancelled handoff candidates must not
start or deliver input after rollback. Saved chat/queued input remains available for retry.

The sidebar’s separate OpenRouter row reads `/key`: USD spend today/week/month/all time, key cap and remaining
allowance/reset, BYOK totals and optional free-request counts. It covers all activity on the key, including outside
Glade; periods are UTC. No SDK list-price estimate or unused per-generation reconciliation pipeline is retained.
SQLite caches the last reading and error for the connected key; replacement/removal clears it. Launch, connection,
request completion and popover opening refresh through one coalesced read at most per minute. Explicit Refresh
bypasses that cache. A failed read preserves the previous figures/age; unknown remains distinct from zero.
No figures or key labels reach logs or plugin feeds. Account credit balance needs a management key and is omitted.
[Current key](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key),
[account credits](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits).

SDK alpha APIs and non-Claude protocol compatibility need validation on SDK updates. A tool-capable catalog entry
is not evidence that every native command, compaction, custom agent or cross-source thinking signature works.
Provider errors remain explicit and archived history stays available.

## Validation evidence

Isolated probes on Oct 5 established direct/SDK echo, native children, an MCP tool, provider pinning, the real
context override and persisted OpenRouter resume on DeepSeek V4.1 Flash / Together. One separately authorized
minimal subscription probe established basic Claude-to-OpenRouter text recall on the same session ID. Private
probe logs retain the account figures; no real-account counts or billing totals are committed.

A no-inference SDK initialization check registered two named agents with distinct full opaque model IDs. It
submitted no prompt and used no live inference endpoint or account credentials. Mocked runtime and relay tests
verify per-dispatch selection and provider pinning; a live named-child dispatch remains a compatibility check
before release.

A fresh OpenRouter process recalled its genuine random tool result through the production SQLite store. Artificial
transcript injection was insufficient evidence because SDK replay checkpoints can exclude appended entries.
Cross-source signed thinking, reverse paid Claude inference and sandboxed SDK-cache reads were not live-probed;
they require manual validation before release. Provider context-overflow recovery and withdrawn-provider errors also need
a manual run. Native subagent progress summaries remain enabled and generate inference requests; their cost and
cache behavior should be checked in a provider generation log before recommending a route for cheap work.

Automated tests mock catalog/inference traffic and use the existing fake agent. They cover credential/source
isolation, discovery, key races, route failures, opaque history, deletion, switch entries, sandbox readiness,
queue holding, rollback, mirror recovery, deferred pause timers, scheduled-work refusal, mixed-source usage refresh,
limit recovery, per-dispatch model definitions and separate native child routes. Hidden Electron tests cover the UI’s connection errors, curation, provider filtering, usage monitor, persisted Glade
chat/log rows, relaunch and selections in both directions. Test mode uses the fake backend, so Playwright does not
prove SDK transcript handoff; mocked SDK/runtime integration tests and the private live probes provide that evidence. Capture/e2e mode uses an offline catalog,
even if supplied a real key.

Approved UI references are [screens 56–59](design/openrouter-mockups.md). Migration 65 and typed bridge commands
extend existing repositories and Settings/picker surfaces without a general backend refactor.

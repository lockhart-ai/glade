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

The durable selection ID is `openrouter:<model>@<provider>`. Claude selections retain existing IDs/aliases.
There is no blanket subagent model or second input-bar picker. The parent chooses the model for each job.

## Mixed-source subagent dispatch

`mcp__glade-agents__list_models` returns the current Claude models and enabled OpenRouter routes, including their
context windows and OpenRouter input/output prices in USD per token. `mcp__glade-agents__dispatch` takes `model`,
`prompt`, `description`, optional `run_in_background`, optional `resume` (a previously returned child ID), and
optional `isolation` (`"worktree"`: the child starts in its own git worktree, #558).
These tools are added only when an OpenRouter key is connected; a keyless Claude session's prompt and tools are
unchanged. Use native `Agent` for same-source children, preserving native agent types, worktree isolation and
`SendMessage`. `dispatch` starts the existing SDK backend in another session, in the same workspace, on the
**other source only**; same-source requests are rejected. It accepts only currently offered models; provider selection remains in Settings. Curation changes apply to the next dispatch.

| Parent | Claude child | OpenRouter child |
| --- | --- | --- |
| Claude account | Native `Agent` | Glade `dispatch` |
| OpenRouter | Glade `dispatch` | Native `Agent`, parent route only |

The adapter retains the full SDK coding prompt and agent loop, and adds delegation instructions. It creates fresh
MCP servers for each process, forwards the task's permissions and sandbox grants, and gives separate sessions a
subagent identity for main-only tool checks. A child cannot change Glade task metadata, ask the user, or control
other tasks. Its own permission/access requests still identify it in the task's cards.

SQLite records each dispatch's owning task, model/provider route, SDK session ID, result and state. Child text and
tool events appear under its dispatch in Agents, whose selected-child line shows the model. Child initialization,
context and completion never replace the parent task's session or model. Each process keeps its own context window.
Claude children report Claude account usage; OpenRouter children refresh the separate OpenRouter usage row.

Foreground dispatch waits for the result. Background dispatch returns the child ID and sends its completion or
failure back to the parent. Stop subagent works through the existing Agents controls, including nested children.
Stopping a foreground turn ends its foreground children. Closing a session ends all its children; finishing a
child ends its remaining descendants and watchers. The adapter does not leave independently billed work orphaned.

Resume a child with another dispatch using its returned ID and original model after Glade relaunches or the parent
changes model, provided its source still differs from the parent's. The same task owns the saved conversation; other tasks cannot resume it. Replaying a
persisted tool call returns its saved state instead of starting duplicate work. A process interrupted by relaunch
is marked stopped; resumption is explicit. `SendMessage` continues to address native SDK children only.

Native `Agent` is still available: Claude children share the Claude account; under OpenRouter every native model
alias and built-in type uses that process's selected route. Glade's dispatch selects the other source only; a
child on another OpenRouter route is deferred. Native child wakeups remain tied to their source process; the portable continuation path is managed
dispatch. SDK helpers such as compaction use the process's selected route too.

## Switching an existing task

A source change or OpenRouter model change needs a stopped or waiting task, with no active
turn, question or permission request. Ordinary waiting tasks must also finish or stop their background work. A task
paused on a usage limit may switch immediately: its old children, watchers and scheduled work end with a recorded
reason. The destination’s first prompt names those stopped children, watchers and wakeups by their Agents labels
and commands, says they will not report back and asks the agent to restart needed work. Its held turn resumes on OpenRouter. Ordinary Claude model changes keep
the existing next-turn behavior.

If known context usage exceeds the destination window, the switch is refused before preparation; choose a larger
model or compact first. Only the first cross-source session creates the shared SDK todo list, retaining identifiers
and high-water marks by seeding from the original list without overwriting it. Later sessions reuse that shared
list. Tasks that never use another source keep the original SDK list. Link setup failures are logged and the
session starts with its original SDK list; todo continuity is not guaranteed in that fallback. The shared-list
filesystem behavior is unit tested; the bundled binary's use of the links remains unverified.

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
or auto-memory saved there. A manual sandboxed workflow check remains a follow-up.
Sandbox credentials deny `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`. Unsandboxed commands, session hooks and
stdio MCP servers can inherit the short-lived relay token; it grants inference on the session’s routes until close.

Messages thinking/effort fields follow endpoint capabilities; other output configuration fields remain intact.
Text-only routes reject image-containing requests explicitly. The SDK's unknown-model 200K default is overridden
with that session's selected route's actual context window. Production probing confirmed the override.
The context meter uses that prepared limit, including after catalog changes during a session. Helper calls and
built-in subagent types use the parent route. Glade does not set a blanket child model; each managed dispatch selects its own route. SDK fallback Claude pricing is not an OpenRouter bill.
[Messages API](https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-messages?explorer=true).

## Durable history and usage

Ordinary Claude parent tasks retain SDK transcript files, without an import or a mirror. Tasks that use OpenRouter
and independently routed children use SDK 0.3.283’s alpha `sessionStore` with eager flush. Main/child entries retain UUIDs, tool results,
thinking/signatures and metadata. `importSessionToStore` imports legacy history at the first OpenRouter handoff;
missing history fails explicitly. A provisional import is adopted in the same database transaction as the
selection; failure or cancellation discards it. An uncommitted copy after a crash is never treated as the task’s
active history. A retry reimports the latest Claude files. Returning to Claude uses the adopted mirror for that task.
An inherited login-shell `CLAUDE_CONFIG_DIR` is honored when importing local JSONL history, including child entries
and metadata sidecars. Ordinary Claude tasks preserve the user’s own inherited subagent-model setting.

Append writes only incoming entries, preserving order. Separate owners isolate copied SDK IDs. Mirrored entries
and switch records remain until task deletion, which cascades them. `mirror_error` stops the task and persists an
unreliable-history marker with the SDK config directory. The next start rebuilds the mirror from complete local SDK
files and clears the marker only on adoption. A durable backup retains the prior mirror while a rebuild is pending or fails. The failed copy is never treated as
complete. If recovery fails, the error explains how to restore the file or carry
the saved Glade chat into a new task; a shorter mirror is never loaded. There is no time-based
truncation. Closing before environment resolution never spawns a process: cancelled handoff candidates must not
start or deliver input after rollback. Saved chat/queued input remains available for retry.

The sidebar’s separate OpenRouter row reads `/key`: USD spend today/week/month/all time, key cap and remaining
allowance/reset, BYOK totals and optional free-request counts. It covers all activity on the key, including outside
Glade; periods are UTC. No SDK list-price estimate or unused per-generation reconciliation pipeline is retained.
SQLite caches the last reading and error for the connected key; replacement/removal clears it. Launch, connection,
request completion and popover opening refresh through one coalesced read at most per minute, with a trailing read
to include the final request of a burst. A 402 marks the sidebar row blocked until inference succeeds; a successful
metadata read alone does not clear the credit failure. Decryption/read failures cannot crash app launch. Explicit Refresh
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

The mixed-source probe described above exercised an actual parent tool call, one provider-pinned child inference
request, the child result and a subsequent Claude parent reply. An initial parent prompt omitted the child task and
returned a clarification instead; the corrected prompt dispatched successfully. The private audit accepts the
parent's formatting around the returned marker. No additional inference was run just to enforce exact formatting.
Thinking and filesystem tools were disabled and output was capped. Production dispatch now has mocked integration
coverage for both cross-source directions, native same-source preservation, concurrency, nested stop, saved-child resume,
live route curation, account isolation and main-only tool guards. Hidden Electron tests exercise both kinds of
parent using native same-source and managed cross-source children, displaying both model labels. A subsequent bounded live probe ran the
production dispatch adapter, SDK backend, runtime and child persistence in both cross-source directions: Claude
Haiku → DeepSeek Flash / Together, and DeepSeek Flash / Together → Claude Haiku. Each parent received its child's
echo and each child was saved as completed. The probe reduced the system prompt, disabled thinking and filesystem
tools, and capped output at 256 tokens; it made three OpenRouter requests across both cases. The current-key response shape was
also checked with an authenticated metadata-only request, with no usage figures retained in the repo.

A fresh OpenRouter process recalled its genuine random tool result through the production SQLite store. Artificial
transcript injection was insufficient evidence because SDK replay checkpoints can exclude appended entries.
A production runtime round trip then ran Claude Haiku → DeepSeek Flash / Together → Claude Haiku on the same
SDK session. The first Claude turn emitted signed thinking and read a fresh random token from a tool. Both resumed
models recalled that token, and SQLite retained the thinking blocks. The SDK normalized the resumed outgoing
OpenRouter history to text/tool blocks; DeepSeek returned no thinking blocks on this trivial request. This proves
that tested round trip, not arbitrary providers' reasoning formats. The probe made one OpenRouter request and used
1,024-token thinking budgets with 1,280-token output caps; actual generated output was 241 tokens across the three
turns. OpenRouter-origin reasoning signatures, sandboxed SDK-cache reads, provider context-overflow recovery and
withdrawn-provider errors remain follow-up validation; none is claimed as proven by these probes. Native subagent progress summaries remain enabled and generate inference requests; their cost and
cache behavior should be checked in a provider generation log before recommending a route for cheap work.

Automated tests mock catalog/inference traffic and use the existing fake agent. They cover credential/source
isolation, discovery, key races, route failures, opaque history, deletion, switch entries, sandbox readiness,
queue holding, rollback, mirror recovery, deferred pause timers, scheduled-work handling, mixed-source usage refresh,
limit recovery, shared SDK todos, destination context checks, post-commit failure handling and independent child routes. Hidden Electron tests cover the UI’s connection errors, curation, provider filtering, usage monitor, persisted Glade
chat/log rows, relaunch and selections in both directions. Test mode uses the fake backend, so Playwright does not
prove SDK transcript handoff; mocked SDK/runtime integration tests and the private live probes provide that evidence. Capture/e2e mode uses an offline catalog,
even if supplied a real key.

Approved UI references are [screens 56–59](design/openrouter-mockups.md). Migrations 65–66 (including upgrades from earlier preview schemas) and typed bridge commands
extend existing repositories and Settings/picker surfaces without a general backend refactor.


## Landing limitations and follow-ups

The landing review deliberately defers the following work. These are limitations and validation gaps, not shipped
capabilities; the initial change keeps native same-source delegation and Claude-only todo storage intact.

- **Child effort:** a dispatched child takes its parent's effort at the time of the dispatch, or its model's default
  effort when the model doesn't offer that one (#556). A per-dispatch effort argument is not built.
- **Child prompt/tools:** dispatched children inherit the main Glade prompt and tools, with metadata/control calls
  refused by the main-only guard. A child-specific prompt/tool set and agent types are not implemented.
- **Child worktrees:** a dispatched child's worktree (`isolation: "worktree"`, #558) is kept when it ends, even
  unchanged: Glade's git only reads (#487), so removing it is left to the parent. Outside a git repository the child
  fails with Claude Code's own exit. Not yet run with a real model: a child working in one, and a child and its own
  child in one worktree at once.
- **Limit-switch survival:** all children stop, including children on the source unaffected by the limit. The resumed
  agent is told what stopped, but retaining those processes is deferred.
- **Busy switches:** a running turn, open question/permission card, or idle task with live background work prevents
  a source/route switch. Saving the choice until a safe boundary is not built.
- **Claude-to-Claude limit recovery:** changing Claude models from the picker leaves a usage-limit pause in place.
- **Cost attribution:** neither per-task nor per-child billed cost is available for either source.
- **Provider changes:** choosing another provider disables the previous pair for existing tasks and resets a default
  using that pair to Claude, rather than migrating those selections.
- **Usage gaps:** a one-request turn may precede OpenRouter's accounting update; a Claude child's final usage read
  races process shutdown; an uncapped empty key is only marked blocked after a failed request; remaining allowance
  can display a negative amount; and a malformed cached usage row can throw before the refresh promise starts.
  Refresh/accounting timing, child usage and cached-row validation need further coverage.
- **Preview schema cleanup:** earlier preview databases may retain unused `tasks.subagent_model` and
  `openrouter_generations`; removing them is deferred.
- **Workflow validation:** production-prompt dispatch in both directions with real tools, permission cards and the
  sandbox; upgraded SDK todos across a switch; completion while the parent is paused/busy/starting queued input;
  relaunch with a running child then resume; child wakeup/cron lifecycle; relaunch of an OpenRouter task with a
  saved usage pause; and full SDK runtime/UI integration remain follow-ups. Existing Electron dispatch tests use
  scripted models, and filesystem todo tests do not validate the bundled binary. The landing regression does cover
  a limit-switch with an actual managed child in the fake backend, a native child, monitor and scheduled wakeup.
- **Other OpenRouter child routes:** only the parent's route is supported by native `Agent`. Cross-route support and
  a live OpenRouter → OpenRouter run on distinct routes remain follow-ups. A thinking block written on an
  OpenRouter route returning to Claude is also not yet verified.

Before relying on this build, back up the data folder: migrations 65–66 are forward-only and v0.25.0 cannot safely
reopen the upgraded database. The remaining real smoke run should include an OpenRouter tool call with a permission
card, one production-prompt dispatch each way, a limit-switch with a watcher alive, and pre-existing todos surviving
a source switch. These are separate from the completed minimal echo/history probes above.

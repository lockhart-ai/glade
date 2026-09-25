# Claude Agent SDK notes (P1-01 spike)

What the rest of P1 needs to know about the Claude Agent SDK, with evidence.

- **Tested:** `@anthropic-ai/claude-agent-sdk` **0.3.281**, which bundles Claude Code **2.1.281** as a native binary.
  Node 25, macOS (arm64). September 2026.
- **How:** throwaway `tsx` scripts outside the repo, one long-lived `query()` per session in streaming-input mode,
  mostly on `haiku` to keep runs cheap. Auth came from the machine's existing Claude Code login, with no API key set.
- **Labels:** **[verified]** means we saw it in a real run. **[docs]** means it comes from the docs or the SDK's
  `sdk.d.ts` only.
- All payloads below are invented or sanitised. Ids, paths and text are made up. Irrelevant fields are left out.

Main references: [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview),
[TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript), and the package's own `sdk.d.ts`, which
is the most complete and current source.

---

## 1. Auth

**Technically: yes. Policy: not clearly addressed by the docs. Decided (Jared): Glade runs on the user's own Claude Code
login.** The policy risk is recorded below and under Open risks.

**[verified]** With no `ANTHROPIC_API_KEY` in the environment, the SDK ran on the user's Claude Code login (macOS
Keychain) and needed no configuration. `system/init` reported `apiKeySource: "none"`. A `rate_limit_event` arrived
carrying subscription windows (`five_hour`, `seven_day` utilisation).

How it works: the SDK spawns the bundled Claude Code binary, and that binary picks the credential using the CLI's usual
precedence [docs]:

1. cloud provider env vars (`CLAUDE_CODE_USE_BEDROCK`/`_VERTEX`/`_FOUNDRY`)
2. `ANTHROPIC_AUTH_TOKEN`
3. `ANTHROPIC_API_KEY`
4. `apiKeyHelper`
5. `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`)
6. Anthropic profiles
7. the `/login` subscription credential

([Authentication › precedence](https://code.claude.com/docs/en/authentication#authentication-precedence))

**What Anthropic says.** Two statements appear to pull in different directions.

The Agent SDK overview and quickstart say
([overview](https://code.claude.com/docs/en/agent-sdk/overview#get-started),
[quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart)):

> Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits
> for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described
> in the Quickstart instead.

The [Legal and compliance › Authentication and credential use](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)
page says:

> **OAuth authentication** is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise
> subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications.

> **Developers** building products or services that interact with Claude's capabilities, including those using the
> Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. Anthropic does
> not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through
> Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or
> intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's
> own flow.

> [...] Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude
> subscription [...]

The same page's usage policy also says: "Advertised usage limits for Pro and Max plans assume ordinary, individual usage
of Claude Code and the Agent SDK."

**Reading it plainly.** The docs are clear on three points:

- A product must not offer its own claude.ai login.
- A product must not route requests through users' plan credentials on their behalf.
- A product must not collect, store or intermediate claude.ai tokens.

They also say that developers of products built on the Agent SDK *should* use API keys. They do not directly address
the case of one person running an open-source tool on their own machine, where the unmodified bundled binary picks up
that person's own existing `claude` login and Glade never touches the token. That case is closer to "an end user
signing in to the unmodified Claude Code binary with their own Claude subscription". But the docs don't explicitly bless
it for a third-party app, and "Anthropic reserves the right to take measures to enforce these restrictions … without
prior notice." We can't call it clearly permitted. Jared has decided to go login-based anyway (see `decisions.md`), and
the risk stays listed under Open risks.

**API key fallback [docs].** Set `ANTHROPIC_API_KEY` in the SDK process's environment. The init message then reports
`apiKeySource: "ANTHROPIC_API_KEY"`. Watch out: the `env` option *replaces* the child's environment rather than merging
into it, so pass `env: { ...process.env, ANTHROPIC_API_KEY: key }`. Bedrock, Vertex and Foundry work through their env
vars. Not exercised in this spike, because no key was available.

**Implications for Glade**

- Glade never shows a claude.ai login, never reads the Keychain, and never stores or forwards OAuth tokens. It runs the
  unmodified bundled binary, which resolves credentials the way it always does.
- Glade runs on the user's existing `claude` login and adds no key setting. If `ANTHROPIC_API_KEY` happens to be set in
  the environment, the binary uses it instead, per the precedence above.
- Show which credential is in use (from `system/init.apiKeySource`, and from `accountInfo()` or
  `initializationResult().account`) so the user is never surprised about billing.

## 2. Event shapes

`query()` returns an async iterator of `SDKMessage`. The union has about 40 members. These are the ones Glade needs.

### Turn skeleton [verified]

This is what one turn with tools looked like:

```
system/init                         ← re-emitted at the start of EVERY turn
rate_limit_event                    ← subscription only
system/status {status:"requesting"}
system/thinking_tokens …            ← progress estimates while the model thinks
assistant [thinking]                ─┐ same message.id
assistant [text]      ← preamble     │ (one SDK message per content block)
assistant [tool_use]                ─┘
user      [tool_result]
assistant [tool_use]                ← same or next message.id
user      [tool_result]
assistant [thinking]                ─┐ new message.id
assistant [text]      ← final reply ─┘
result/success {result:"<final reply text>"}
```

### system/init [verified]

This message is emitted at the start of every turn, not only the first.

```json
{
  "type": "system", "subtype": "init",
  "session_id": "3f1c9a52-7d2e-4b8a-9c11-0e5f6a7b8c9d",
  "cwd": "/Users/me/code/acme-api",
  "model": "claude-haiku-4-5-20251001",
  "permissionMode": "bypassPermissions",
  "apiKeySource": "none",
  "claude_code_version": "2.1.281",
  "tools": ["Task", "Bash", "Edit", "Read", "Write", "ToolSearch", "…", "mcp__glade__set_title"],
  "mcp_servers": [{ "name": "glade", "status": "connected", "source": "sdk" }],
  "agents": ["general-purpose", "Explore", "Plan"],
  "capabilities": ["interrupt_receipt_v1", "interrupt_cancel_queued_v1", "msg_lifecycle_v1"],
  "uuid": "…"
}
```

### Assistant text: preamble vs final reply [verified]

- The CLI emits **one `assistant` message per content block**. Consecutive messages share `message.id`, and each has
  `stop_reason: null` and non-final `usage`. The real stop reason and totals arrive on `result`.
- **Preamble** is any top-level (`parent_tool_use_id === null`) text block that is followed by a `tool_use` later in
  the same turn. In our run the text "I'll check the workspace and set the status." came in the same `message.id` as the
  `tool_use` blocks that followed it.
- **Final reply** is the text that comes after the turn's last `tool_result` and before `result`. On success,
  `result.result` holds exactly that text.

```json
{ "type": "assistant", "parent_tool_use_id": null, "session_id": "…", "uuid": "…",
  "message": { "id": "msg_01AbC…", "model": "claude-haiku-4-5-20251001", "stop_reason": null,
    "content": [{ "type": "text", "text": "I'll check the test config first." }],
    "usage": { "input_tokens": 10, "cache_creation_input_tokens": 1272, "cache_read_input_tokens": 21564, "output_tokens": 1 } } }
```

**Implications for Glade (P1-07)**

- Buffer each top-level text block. When a `tool_use` arrives, flush the buffer to the tool log as preamble. When
  `result` arrives, whatever is left in the buffer is the final reply and goes to the chat. Cross-check it against
  `result.result`.
- Ignore `thinking` blocks for the chat. They could go to the tool log later.
- Some turns have no preamble at all. Haiku often called tools with no text in between.

### tool_use and tool_result [verified]

```json
{ "type": "assistant", "parent_tool_use_id": null,
  "message": { "id": "msg_01AbC…", "content": [
    { "type": "tool_use", "id": "toolu_01Xy…", "name": "Bash",
      "input": { "command": "npm test", "description": "Run the test suite" } } ] },
  "tool_use_meta": [{ "id": "toolu_01Xy…", "display_name": "Bash" }] }

{ "type": "user", "parent_tool_use_id": null,
  "message": { "role": "user", "content": [
    { "type": "tool_result", "tool_use_id": "toolu_01Xy…", "content": "12 passed", "is_error": false } ] },
  "tool_use_result": { "stdout": "12 passed", "stderr": "", "interrupted": false } }
```

- Pair calls and results by `tool_use_id`. `tool_use_result` holds the tool's structured output. Its shape depends on
  the tool, and it is better than parsing the text.
- MCP tool names arrive as `mcp__<server>__<tool>`. `tool_use_meta[].display_name` gives a pretty name ("Set Title").
- Long-running tools also emit `tool_progress` (`elapsed_time_seconds`) [docs].

### result [verified]

```json
{ "type": "result", "subtype": "success", "is_error": false,
  "result": "The failing test was a timezone bug; fixed in src/date.ts.",
  "session_id": "3f1c9a52-…", "num_turns": 4, "stop_reason": "end_turn", "terminal_reason": "completed",
  "duration_ms": 7620, "duration_api_ms": 8073, "ttft_ms": 2587,
  "total_cost_usd": 0.0285,
  "usage": { "input_tokens": 28, "cache_creation_input_tokens": 9443, "cache_read_input_tokens": 58094, "output_tokens": 553 },
  "modelUsage": { "claude-haiku-4-5-20251001": { "inputTokens": 953, "outputTokens": 566, "cacheReadInputTokens": 58094,
      "cacheCreationInputTokens": 9443, "costUSD": 0.0285, "contextWindow": 200000, "maxOutputTokens": 32000 } },
  "permission_denials": [], "queued_turn_count": 0,
  "user_message_uuids": ["a1b2…"] }
```

- **Exactly one `result` per turn**, and it is the turn-complete signal. Some system messages can still follow it.
- `num_turns` counts model round-trips inside the turn, not user turns.
- `usage` covers **this turn's main loop only**. `modelUsage` and `total_cost_usd` are **cumulative for the whole
  `query()`**, so read the latest value rather than summing across results [docs, matches observed].
- The cost is an estimate at list prices, and it is reported even on a subscription.
- Error subtypes: `error_during_execution`, `error_max_turns`, `error_max_budget_usd`,
  `error_max_structured_output_retries`. These carry `errors: string[]` and `terminal_reason`.

### Usage and context size ("76k / 200k") [verified]

- **Used:** take the latest top-level `assistant` message and add
  `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` from its `usage`. Those tokens are the prompt
  the model just saw. In our run this climbed 21.6k → 22.8k → 23.1k … and matched `compact_boundary.pre_tokens`.
- **Window:** `modelUsage[model].contextWindow` (200000 for Haiku). The default model reports a 1M window
  (`claude-opus-5-5[1m]`).
- **Or ask:** `q.getContextUsage({ detail: "summary" })` returns
  `{ totalTokens, maxTokens, percentage, autoCompactThreshold, isAutoCompactEnabled, memoryFiles, … }`. Its estimate ran
  higher than the per-message sum (29.0k vs 23.1k), and **right after a compaction it was stale** (31.4k, while the next
  request used 21.6k). Prefer the per-message usage, and use `getContextUsage()` for the threshold and the
  per-category breakdown.
- After compaction, `compact_boundary.compact_metadata.post_tokens` is the new baseline until the next assistant message
  arrives.

### Subagents (Task/Agent tool) [verified]

The tool is named `Agent` in `tool_use` (the init `tools` list shows `Task`). A foreground subagent produced:

```json
{ "type": "system", "subtype": "task_started", "task_id": "b7f3…", "tool_use_id": "toolu_01Par…",
  "task_type": "local_agent", "subagent_type": "general-purpose", "description": "Find flaky tests",
  "prompt": "…", "is_backgrounded": false, "spawn_depth": 1 }
{ "type": "user",      "parent_tool_use_id": "toolu_01Par…", "message": { "content": [{ "type": "text", "text": "<subagent prompt>" }] } }
{ "type": "system", "subtype": "task_progress", "task_id": "b7f3…", "tool_use_id": "toolu_01Par…",
  "usage": { "total_tokens": 12747, "tool_uses": 1, "duration_ms": 1600 }, "last_tool_name": "Bash" }
{ "type": "assistant", "parent_tool_use_id": "toolu_01Par…", "message": { "content": [{ "type": "tool_use", "name": "Bash", "…": "…" }] } }
{ "type": "user",      "parent_tool_use_id": "toolu_01Par…", "message": { "content": [{ "type": "tool_result", "…": "…" }] } }
{ "type": "system", "subtype": "task_updated", "task_id": "b7f3…", "patch": { "status": "completed", "end_time": 1790000000000 } }
{ "type": "system", "subtype": "task_notification", "task_id": "b7f3…", "tool_use_id": "toolu_01Par…", "status": "completed",
  "summary": "Found two flaky tests.", "usage": { "total_tokens": 14095, "tool_uses": 1, "duration_ms": 3222 } }
{ "type": "user", "parent_tool_use_id": null, "message": { "content": [{ "type": "tool_result", "tool_use_id": "toolu_01Par…", "…": "…" }] },
  "tool_use_result": { "status": "completed", "agentId": "b7f3…", "agentType": "general-purpose",
    "content": [{ "type": "text", "text": "Found two flaky tests." }],
    "totalDurationMs": 3224, "totalTokens": 14019, "totalToolUseCount": 1,
    "toolStats": { "bashCount": 1, "editFileCount": 0, "linesAdded": 0, "linesRemoved": 0 } } }
```

- Every message from inside a subagent has `parent_tool_use_id` set to the `Agent` tool_use id. Top-level messages
  have `null`.
- By default only the subagent's tool calls and results are forwarded. `forwardSubagentText: true` also forwards its
  text and thinking [verified, SDK 0.3.281 on Haiku]: each text block comes as an `assistant` message with
  `parent_tool_use_id` set and `content: [{ "type": "text", "text": "…" }]`, the same shape as a top-level one. Its
  prompt also arrives, as a `user` message with a text block and the parent id; its thinking blocks came with empty
  `thinking` text.
- `agentProgressSummaries: true` adds a one-line `summary` to `task_progress` about every 30s [docs].
- Background Bash commands use the same `task_*` events with `task_type: "local_bash"`, plus
  `system/background_tasks_changed` [verified].

**Implications for Glade (P5-05)**

- The Subagents tab derives each subagent from the tool log: an `Agent` (or `Task`) call, with the calls and notes
  tagged with its id under it. For a foreground subagent, the call's result is when it finished; a background one's
  is not (see "Background subagents" below), so the runner reads `task_started` and `task_notification` for those.
- The Tool calls tab shows only the task's own calls and notes (`parent_tool_use_id` null), and counts only those
  (P9-04). An `Agent` call is one row there; what its subagent did, nested subagents included, is under its entry in
  the Subagents tab.
- Glade sets `forwardSubagentText: true`, so the tab can show the last thing a subagent said. The runner logs a
  subagent's text as a note carrying its `Agent` call's id; it never goes to the chat.
- There is no "queued" subagent. In the verified run a subagent started (`task_started`) as soon as its call arrived;
  the SDK's types allow a `pending` status on `task_updated`, but it wasn't seen, and the tool log can't tell a call
  waiting for a slot from one just started. So a subagent is running, done or failed.

### Background subagents [verified]

Probed on SDK 0.3.281 with Haiku (P9-03), in a throwaway folder: one turn started two subagents with
`run_in_background: true`, one running `sleep 12` and one `sleep 40`, and replied "launched". After its `result`, a
second message was sent, and after that one's `result`, `stopTask` stopped the second subagent. Timings are seconds from
the start.

```
 7.9  assistant  tool_use Agent { description: "Slow A: …", prompt: "…", run_in_background: true }
 7.9  system/background_tasks_changed  { tasks: [{ task_id: "aa25…", task_type: "local_agent", description: "Slow A: …" }] }
 7.9  system/task_started  { task_id: "aa25…", tool_use_id: "toolu_01EW…", task_type: "local_agent",
                             subagent_type: "general-purpose", is_backgrounded: true, spawn_depth: 1, prompt: "…" }
 7.9  user  tool_result for toolu_01EW…: "Async agent launched successfully. … agentId: aa25… …"
            tool_use_result: { isAsync: true, status: "async_launched", agentId: "aa25…", … }
 8.5  (the same four for Slow B, task ac1f…)
 9.7  assistant [text] "launched"
 9.7  result/success  { user_message_uuids: [first message] }     ← the turn ends; neither subagent has done anything
 9.8  system/init                                                  ← the second message's turn, straight away
10.8  assistant [text] "4"
10.8  result/success  { user_message_uuids: [second message] }
10.8  stopTask("ac1f…")
10.8  system/background_tasks_changed  { tasks: [Slow A] }
10.8  system/task_updated       { task_id: "ac1f…", patch: { status: "killed", end_time: … } }
10.8  system/task_notification  { task_id: "ac1f…", tool_use_id: "toolu_01JE…", status: "stopped",
                                  summary: "Slow B: …", output_file: "…/tasks/ac1f….output" }   ← no usage
10.8  user  { parent_tool_use_id: "toolu_01JE…", content: [{ text: "[Request interrupted by user]" }] }
10.9  system/init … result/success { origin: { kind: "task-notification" } }   ← the agent's own turn about the stop
11.5  assistant  { parent_tool_use_id: "toolu_01EW…" } tool_use Bash "sleep 12 && echo alpha"
11.5  system/task_progress  { task_id: "aa25…", tool_use_id: "toolu_01EW…", description: "Running …",
                              usage: { total_tokens: 11334, tool_uses: 1, duration_ms: 3599 }, last_tool_name: "Bash" }
14.5  system/task_started  { task_id: "bf46…", tool_use_id: <the Bash call>, task_type: "local_bash",
                             is_backgrounded: false, owned_by_subagent: true }
23.6  system/task_notification  { task_id: "bf46…", tool_use_id: <the Bash call>, status: "completed", output_file: "" }
23.6  user  { parent_tool_use_id: "toolu_01EW…" } tool_result "alpha"
25.0  assistant  { parent_tool_use_id: "toolu_01EW…" } [text] "The command completed successfully. …"
25.0  system/background_tasks_changed  { tasks: [] }
25.0  system/task_updated       { task_id: "aa25…", patch: { status: "completed", end_time: … } }
25.0  system/task_notification  { task_id: "aa25…", tool_use_id: "toolu_01EW…", status: "completed",
                                  summary: <its final text>, usage: { total_tokens: 12688, tool_uses: 1, duration_ms: 17116 } }
25.0  system/init … assistant [text] "Subagent \"Slow A\" completed …" … result/success { origin: { kind: "task-notification" } }
```

- The `Agent` call's `tool_result` comes at once and only says the subagent was launched (`tool_use_result.status:
  "async_launched"`, `isAsync: true`). It isn't the subagent finishing.
- **The parent's turn doesn't wait for its background subagents.** Its `result` came before either subagent made a
  call, and a message sent then was answered straight away while both ran. The SDK itself never keeps the parent
  working.
- The subagent's own messages (`parent_tool_use_id` set to its `Agent` call) arrive whenever it works: between turns,
  and in the middle of the parent's later turns.
- It ends with `task_updated` (`completed`, `failed` or `killed`) then `task_notification`, with `tool_use_id` naming its
  `Agent` call and `status` `completed`, `failed` or `stopped`. A completed one's `summary` is its final reply. A
  stopped one's is just its description, with no `usage`, followed by an interrupt marker under its call.
- After each one ends, the agent starts a turn of its own about it ("Turns the agent starts itself").
- `task_progress` carries its running tool count and time. `background_tasks_changed` lists what's running.
- A subagent's own foreground Bash call gets a `task_started` of its own (`local_bash`, `owned_by_subagent`).
- The SDK's types say a foreground subagent can be moved to the background later, as `task_updated` with
  `patch.is_backgrounded: true`. We didn't see this happen.

**Implications for Glade (P9-03)**

- A background subagent is followed from its `task_started` (`task_type: "local_agent"`, `is_backgrounded: true`), or
  from its call's "launched" result, or from a later move to the background. Its `Agent` call's row keeps running
  until its `task_notification`. Then it's done, or failed with the summary. A stopped one fails with "You stopped the
  subagent.", as a stopped turn's calls do. The Subagents tab counts its calls and times it from the tool log, as for
  any subagent. Glade doesn't read `task_progress`.
- Its calls and notes are logged whenever they arrive, with the turn its `Agent` call was made in. They never open a
  turn, and the end of a turn doesn't fail them. Its calls still running when it ends fail with it.
- Stop subagent calls `stopTask` with its task id, as for a foreground one.
- A background subagent dies with its session. If the process fails, its row fails. If the app quits, its row is left
  running and is interrupted on the next launch, whatever state its task is in.
- In the dogfooding session behind P9-03, the parent that stayed "working" for ten minutes was running a *foreground*
  `Agent` call (`run_in_background: false`). That turn really does wait for its subagent. Background subagents never
  kept a turn open.

### Compaction [verified]

This is what a manual `/compact` produced:

```json
{ "type": "system", "subtype": "status", "status": "compacting" }
{ "type": "system", "subtype": "status", "status": null, "compact_result": "success" }
{ "type": "system", "subtype": "compact_boundary",
  "compact_metadata": { "trigger": "manual", "pre_tokens": 26439, "post_tokens": 2382, "duration_ms": 21483 } }
{ "type": "user", "message": { "content": "This session is being continued from a previous conversation … Summary: …" } }
{ "type": "result", "subtype": "success", "num_turns": 0, "result": "" }
```

`trigger` is `"auto"` for automatic compaction. The `PreCompact` and `PostCompact` hooks fired, and `PostCompact`
receives `compact_summary`. See §5.

### Errors and retries

- **[verified] API error (bad model):** the `assistant` message carries `error: "model_not_found"` and its text is the
  error message. The `result` has `subtype: "success"` **but** `is_error: true`, `terminal_reason: "api_error"` and
  `api_error_status: 404`.
  - Treat `result.is_error` as the error flag, not `subtype`.
  - Other `error` values: `authentication_failed`, `billing_error`, `rate_limit`, `overloaded`, `server_error`,
    `max_output_tokens`, and more (`SDKAssistantMessageError`).
- **[docs] Retries:** `{type:"system", subtype:"api_retry", attempt, max_retries, retry_delay_ms, error_status, error}`
  is emitted before each automatic retry. We didn't trigger this one.
  - The bundled Claude Code retries failed API requests itself (overloaded, 5xx, 429, connection errors), with backoff,
    up to `CLAUDE_CODE_MAX_RETRIES` times; the result's error only arrives once those are spent. So Glade never retries
    on top (P3-03): it shows each `api_retry` on the working line, and the error card once the turn fails.
    (From the SDK's types and the bundled binary's strings, not a live run.)
- **[docs] Usage limits:** the SDK exports `USAGE_LIMIT_ERROR_PREFIXES` ("You've hit your…") and
  `USAGE_WARNING_PREFIXES` for recognising limit messages.
- **[verified]** `rate_limit_event.rate_limit_info` gives `status`, `resetsAt` and per-window `utilization`. This is
  useful for the P3 usage-limit screen.
  - `resetsAt` is **Unix epoch seconds** (the `anthropic-ratelimit-unified-reset` header; the bundled binary's schema
    says so). `status: "rejected"` means the limit is refusing requests until then. Only subscription logins get the
    event; an API key gets none.
  - The usage-limit error itself (`error: "rate_limit"`, a 429) words the reset time for people ("You've hit your
    session limit · resets 3pm"), so Glade doesn't parse it.
  - P3-04: a turn that ends on a usage limit (the error prefixes above, `billing_error`, or a 429 after a rejected
    `rate_limit_event`) or on a connection error pauses its task instead of stopping it, and resumes it at `resetsAt`
    (15 minutes later without one), or once the network is back. See `src/main/agent/pauses.ts`. Not yet seen live.
- **[verified] Process failure:** if the binary can't start (e.g. a missing `cwd`), the iterator **throws** and no
  `result` arrives. Glade must catch it and mark the task errored.

### Interrupt [verified]

See §7 for timing.

```json
{ "type": "assistant", "aborted": true, "message": { "content": [{ "type": "text", "text": "# Juniper\n\nIn the heart of the…" }] } }
{ "type": "user", "message": { "content": [{ "type": "text", "text": "[Request interrupted by user]" }] } }
{ "type": "result", "subtype": "error_during_execution", "is_error": true, "terminal_reason": "aborted_streaming", "result": "" }
```

If the interrupt lands during a tool, the tool gets a "user doesn't want to proceed" `tool_result`, the marker text is
"[Request interrupted by user for tool use]", and `terminal_reason` is `"aborted_tools"`.

### Turns the agent starts itself [verified]

The SDK starts a turn with no user message when a background task finishes (and, per its types, for a timer, a
scheduled wakeup or a message from another session). Probed on SDK 0.3.281 with Haiku: a turn ran `sleep 5 && echo …`
with `run_in_background: true` and ended; about five seconds after its `result`, with nothing pushed, the session
streamed:

```
system/task_updated       { task_id: "b88t…", patch: { status: "completed", end_time: … } }
system/task_notification  { task_id: "b88t…", tool_use_id: "toolu_01…", status: "completed",
                            output_file: "…/tasks/b88t….output", summary: "Background command \"…\" completed (exit code 0)" }
system/init               ← a new turn, as for any other
system/thinking_tokens …
assistant [thinking]      ← no user_message_uuid on any of the turn's assistant messages
assistant [text]
result/success            { origin: { kind: "task-notification" }, … }  ← no user_message_uuid(s)
```

- The turn looks like any other but for what it answers: its `result` has no `user_message_uuid(s)`, and says why it
  ran in `origin` (`task-notification`). The user turn's `result` had no `origin`.
- Within a user turn, only its first assistant message carried `user_message_uuid`, so the assistant messages alone
  can't tell the two kinds of turn apart.
- The background command's own `task_started` (with `tool_use_id`, `task_type: "local_bash"`) came during the turn that
  started it, and its `tool_result` ("Command running in background with ID: …") ended that call straight away.

**Implication for Glade (P9-02):** the runner opens a turn when the agent's own top-level message (or an API error in
its place) arrives between turns, rather than only when the user sends one. System messages, a stray result and
anything from a subagent between turns still open nothing.

### Session id and resume

`session_id` appears on every message. Store it from the first `system/init`. See §8.

### Streaming input mode [verified]

Pass an `AsyncIterable<SDKUserMessage>` as `prompt`. The process stays alive between turns, and you push the next user
message whenever you like:

```ts
const q = query({ prompt: inputQueue(), options: { cwd, mcpServers: { glade }, /* … */ } });
push({ type: "user", uuid: crypto.randomUUID(), parent_tool_use_id: null,
       message: { role: "user", content: "Now fix the flaky test." } });
```

- Setting `uuid` on the pushed message gives lifecycle events
  (`{type:"command_lifecycle", command_uuid, state:"queued"|"started"|"completed"}`), and the reply carries it back in
  `user_message_uuid(s)` on assistant and result messages. This is the join key from a Glade chat row to its reply.
- **A message pushed while a turn is running is folded into that turn at the next tool round.** There is no separate
  turn and no separate result, and `result.user_message_uuids` lists both sends. The CLI already behaves like
  "delivered after its current step". But once a message is pushed, Glade can no longer edit or remove it: only
  `interrupt({cancel_queued})` and an internal cancel control exist.
- Control methods (`interrupt`, `setModel`, `applyFlagSettings`, `getContextUsage`, …) only work in this mode.

**Implications for Glade**

- Run one `query()` per open task, in streaming-input mode, and keep it alive between turns.
- Keep the P2 message queue in SQLite. Only push a message into the SDK when Glade decides to deliver it.
- To deliver "after the current step" while still allowing edits until then, P2 can push from a `PostToolBatch` hook,
  or simply on `result`. **Decided (P2-02):** the runner pushes the queue when the turn's top-level tool calls all have
  their results (the stream's `tool_result`s, no hook), and on `result`, where what's still queued starts the next
  turn. A result's `user_message_uuids` says which pushed messages it answered; see the runner's module comment.

## 3. Custom tools [verified]

```ts
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const glade = createSdkMcpServer({
  name: "glade",
  alwaysLoad: true,            // IMPORTANT, see below
  tools: [
    tool("set_title", "Name the task.", { title: z.string() }, async ({ title }) => {
      db.setTitle(taskId, title);
      return { content: [{ type: "text", text: "ok" }] };
    }),
    tool("ask", "Ask the user and wait.", { questions: z.array(QuestionSchema) }, async (args) => {
      const answer = await ui.waitForAnswer(taskId, args);   // blocks until the UI answers
      return { content: [{ type: "text", text: JSON.stringify(answer) }] };
    }),
  ],
});
query({ prompt, options: { mcpServers: { glade } } });
```

- The model sees the tools as `mcp__glade__set_title` and so on. Calls appear as ordinary `tool_use`/`tool_result`
  blocks, and the handler runs in our process (Electron main).
- **Without `alwaysLoad: true`, the tools are deferred behind tool search.** The model first called `ToolSearch`, got a
  `tool_reference` back, and only then called `mcp__glade__set_title`. With `alwaysLoad: true` it called the tool
  directly.
- **Blocking works.** The `ask` handler awaited a promise for 1.5s, and the turn simply waited. Types say calls are
  bounded only by `createSdkMcpServer({ timeout })` or the `MCP_TOOL_TIMEOUT` env var, and are "effectively unbounded
  by default" [docs].
- `tool()` accepts Zod 3 or Zod 4 shapes. We used zod 4.
- Source: [Custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools), `sdk.d.ts` (`createSdkMcpServer`,
  `tool`).

**Implications for Glade**

- Always set `alwaysLoad: true`. Hide `ToolSearch` calls from the tool log, or show them quietly, since the user's own
  MCP tools may still be deferred.
- `ask` is a plain awaiting handler. Keep the pending question in SQLite so it survives a crash. If the process dies
  while blocked, resume and re-ask (see risks).
- Tool handlers run in the main process, so they must never block the event loop synchronously.

## 4. Per-turn settings: model and effort [verified]

- **Model:** `await q.setModel("sonnet")` before pushing the next message. The next turn's `init.model` changed
  (haiku → `claude-sonnet-5`) and back again. `setModel` also emits a `user` message containing
  `<local-command-stdout>Set model to …</local-command-stdout>`, which Glade should filter out of the chat.
- **Effort:** set it at start with the `effort` option, and change it mid-session with
  `await q.applyFlagSettings({ effortLevel: "low" })` (`null` resets it). We verified this through the `PreToolUse`
  hook input `effort.level`, which went `medium` → `low` between turns. Haiku 4.5 reports no effort (the field was
  absent).
- **What the pickers offer:** `q.supportedModels()` / `initializationResult().models` list each model with
  `supportsEffort`, `supportedEffortLevels` (`low|medium|high|xhigh|max`), `supportsAdaptiveThinking` and
  `displayName`. Build the pickers from this list, not a hard-coded one.
- `thinking: {type:"adaptive"|"enabled"|"disabled"}` is session-level. `setMaxThinkingTokens` is deprecated.

**Implication:** both pickers can change mid-session. Apply the change just before delivering the next message, never
mid-turn.

## 5. Compaction

- **Auto-compact is on by default [verified].** For a 200k window, `getContextUsage()` reported
  `autoCompactThreshold: 167000` (83.5%).
- **Can it be set to 99%? No.** From the bundled CLI code (internal, undocumented, may change), the threshold is
  `min(window × PCT/100, window − 13000)`. So `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` can only **lower** it; the cap is about
  93.5% of 200k. A hard "blocked" limit also sits near `window − 3000`.
- **Turning it off:** set `autoCompactEnabled: false` in settings, or `DISABLE_AUTO_COMPACT=1`.
  `autoCompactWindow` / `CLAUDE_CODE_AUTO_COMPACT_WINDOW` change the window size [docs/types].
- **Manual compaction [verified]:** push a user message whose text is `/compact` (optionally
  `/compact <instructions>`). It emitted the `status: compacting` → `compact_boundary` → `result` sequence (§2). On
  Haiku it took **21s** for 26k tokens.
- **Hooks [verified]:** `PreCompact` (`{trigger, custom_instructions}`) and `PostCompact` (`{trigger, compact_summary}`)
  both fired. The model still knew CLAUDE.md facts after compaction. The types list `compact` as a CLAUDE.md
  `load_reason`, which suggests CLAUDE.md is reloaded after compaction.

**Decided (Jared):** Glade uses the SDK's default auto-compact threshold. Manual compaction (`/compact`) is triggered
from the context meter or ⌘⇧K. A custom threshold is deferred to Later. If it is revisited: the setting can only lower
the threshold, and disabling SDK auto-compaction so Glade compacts at a higher level risks the summarising request
itself hitting prompt-too-long.

The context meter should show `autoCompactThreshold` from `getContextUsage()`.

## 6. CLAUDE.md loading [verified + docs]

- **`settingSources` must include `"project"`** to load `<cwd>/CLAUDE.md` (or `<cwd>/.claude/CLAUDE.md`),
  `.claude/rules/*.md`, and every **parent directory's** CLAUDE.md.
- **[verified]** `["project"]` loaded the workspace CLAUDE.md: the model knew the codeword, and `getContextUsage()`
  listed it under `memoryFiles` with type `Project`. `[]` did not load it (the model answered "UNKNOWN").
- **`"user"`** loads `~/.claude/settings.json`, `~/.claude/CLAUDE.md`, user rules, skills, commands and agents.
  **`"local"`** loads `CLAUDE.local.md` and `.claude/settings.local.json`.
- **Omitting `settingSources` is the same as `["user","project","local"]`**, which is the CLI's behaviour. In our
  default run, the user's plugins and skills loaded.
- **Loaded regardless of `settingSources`:** managed policy, `~/.claude.json`, and **auto memory** under
  `~/.claude/projects/<cwd>/memory/`.
- Source: [Use Claude Code features in the SDK](https://code.claude.com/docs/en/agent-sdk/claude-code-features).

**Implications for Glade**

- Pass `settingSources: ["user", "project", "local"]` explicitly, so a task behaves like `claude` run in the workspace
  root.
- Be aware that the user's own hooks, permissions, plugins, skills, `effortLevel` and model then apply too. Glade's
  explicit options win: `query()` options and `applyFlagSettings` sit above user settings.
- The system prompt: use `systemPrompt: { type: "preset", preset: "claude_code", append: "<task id, title, tool guidance>" }`.
  The snapshot behaviour (on by default) freezes the appended text for the life of the conversation until compaction.
  So put facts that change (like the title) in tool results or messages, not in `append`.

## 7. Interrupt [verified]

- Call `await q.interrupt()` in streaming-input mode.
  - Mid-text: the ack took 38ms and the `result` arrived **63ms** after the call.
  - Mid-foreground-Bash: the ack took 2ms and the `result` arrived **10ms** later, and the running command was killed.
- The session stays alive. The next pushed message ran normally. On resume, the model knew the interrupted turns had not
  completed.
- It returns a receipt `{ still_queued: string[] }`, the uuids of pushed messages that will still run. Setting
  `cancel_queued` drops them as well (capability `interrupt_cancel_queued_v1`) [docs].
- Background tasks get killed on interrupt unless `perTaskStopAffordance: true` [docs].
- `q.close()` kills the subprocess outright. Use it to shut a task down, not to stop a turn.
- Watch out: the Bash tool itself refuses a standalone `sleep N` and may push long commands into the background, where
  they then report through `task_*` events [verified].

**Implication:** the Stop button maps to `interrupt()`. Record the aborted partial text (`aborted: true`) in the tool
log or as a truncated reply, and show the turn as stopped rather than failed (`terminal_reason` `aborted_*`).

## 8. Resume [verified]

- **Transcripts** are written to `~/.claude/projects/<cwd with non-alphanumerics → "-">/<session_id>.jsonl` by default
  (`persistSession: true`).
- **Crash test:** we killed the process mid-turn (`close()` while the reply was streaming), then started a new
  `query({ options: { resume: sessionId, cwd } })`.
  - It resumed with the **same `session_id`** and full history. The model recalled the earlier content.
  - The crashed turn's user message was in the history, unanswered.
- **Is resume tied to `cwd`? No, not in this version.** Resuming the same id from a *different* `cwd` worked: init
  reported the new cwd, and the transcript kept being appended in the original project folder. The docs say
  cross-directory lookup arrived in Claude Code 2.1.223; older bundled CLIs only searched the current project directory
  ([Sessions › Resume by ID](https://code.claude.com/docs/en/agent-sdk/sessions#resume-by-id)).
- **Other options:** `forkSession: true` branches to a new id, `resumeSessionAt: <uuid>` truncates, and `continue: true`
  picks the most recent session in the cwd. `listSessions()`, `getSessionMessages()` and `getSessionInfo()` read
  transcripts.

**Implications for Glade**

- Store `session_id` in the task row from the first `init`.
- On relaunch, recreate each task's `query()` with `resume: session_id` and the same `cwd`. That is the same folder
  anyway, since tasks run in the workspace root.
- Glade's SQLite chat and tool log remain the source of truth for the UI. The SDK transcript is the model's memory.
- A turn that was in flight when Glade died has no `result`. Mark it interrupted in SQLite, and don't auto-re-run it.

### Resuming a Claude Code CLI session from the SDK [verified]

Probed for P13-02 (#221) on SDK 0.3.281 (Claude Code 2.1.281) with Haiku, in a throwaway folder. The session was
started by the bundled binary as a CLI would (`claude -p "<message>" --model haiku`, one short message that ran one
`Bash` call and replied), then resumed from the SDK with `query({ options: { resume: sessionId, cwd } })` in the same
folder, with Glade's options: `settingSources: ['user', 'project', 'local']`, an in-process `glade` server
(`createSdkMcpServer`) allowed as `mcp__glade`, and a `claude_code` preset with an appended system prompt.

- **It resumes, with its history.** `system/init` came back with the CLI session's `session_id`, and the agent
  recalled what the first message said and which command it had run. The new turn was appended to the same transcript.
- **Glade's tools apply.** `mcp__glade__set_status` was in the init's `tools`, and the agent found it with
  `ToolSearch` and called it; the handler ran.
- **Glade's appended system prompt does not.** Asked to quote any mention of Glade in its system prompt, the resumed
  agent found none, where a fresh session with the same options quoted it word for word. A control run showed why: a
  session started from the SDK with one appended prompt, then resumed with a different one, still quoted the *first*.
  On resume, Claude Code keeps the system prompt the session was started with, and a new `systemPrompt` is ignored.
  (The transcript records the prompt in `prompt_snapshot` attachments, which is likely where it comes from.)

**Implications for Glade (P13-02)**

- An imported session resumes, remembers its conversation and has Glade's tools, but it runs on the system prompt
  Claude Code gave it, without Glade's lines (the task id, keeping the title, objective and status, `ask`). So an
  imported task's agent doesn't keep its status current unless you ask it to.
- The same holds for Glade's own tasks: a resumed session keeps the prompt it started with, so a Settings change to
  what the prompt asks for (the upkeep switches) reaches a task only in a new session.
- So since P13-04, Glade sends a resumed session what it's missing once, as a `[Glade: …] … [end]` block ahead of the
  next message it sends it (`src/main/agent/session-context.ts`): Glade's whole prompt for an imported session, and a
  task's handoff note when the session started without it, or with an older one. What each session has had is kept
  in SQLite (`session_context`).

### Transcript entries [verified]

What one CLI session's transcript (`<projects>/<cwd slug>/<sessionId>.jsonl`) held, one JSON object per line, and what
the bundled binary's own schema shows for the entries a short `-p` run doesn't write. Sanitised: ids, paths and text
are made up.

```jsonc
// Your prompt: a string, or content blocks (text, image). Every conversation entry has these common fields.
{ "type": "user", "uuid": "…", "parentUuid": null, "isSidechain": false, "sessionId": "3f1c…", "cwd": "/Users/me/code/acme-api",
  "timestamp": "2026-09-25T14:53:44.119Z", "version": "2.1.281", "gitBranch": "main", "entrypoint": "cli",
  "promptId": "…", "permissionMode": "default",
  "message": { "role": "user", "content": "Run the tests" } }
// One entry per content block, as the SDK streams them; blocks of one API message share `message.id`.
{ "type": "assistant", "uuid": "…", "parentUuid": "…", "isSidechain": false, "timestamp": "…", "requestId": "req_…",
  "message": { "id": "msg_01…", "model": "claude-haiku-4-5-20251001", "role": "assistant", "stop_reason": "tool_use",
    "content": [{ "type": "tool_use", "id": "toolu_01…", "name": "Bash", "input": { "command": "npm test" } }],
    "usage": { "input_tokens": 10, "…": "…" } } }
{ "type": "user", "uuid": "…", "timestamp": "…", "sourceToolAssistantUUID": "…",
  "message": { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "toolu_01…", "content": "12 passed", "is_error": false }] },
  "toolUseResult": { "stdout": "12 passed", "stderr": "", "interrupted": false } }
// Thinking blocks are kept with an empty `thinking` and a signature.
{ "type": "assistant", "message": { "content": [{ "type": "thinking", "thinking": "", "signature": "…" }] } }
// Titles: the latest of each wins. `custom-title` is one you gave it (/rename); `summary` is from older versions.
{ "type": "ai-title", "aiTitle": "Fix the flaky date test", "sessionId": "3f1c…" }
{ "type": "custom-title", "customTitle": "Date bug", "sessionId": "3f1c…" }
{ "type": "summary", "summary": "Fixed the timezone bug", "leafUuid": "…" }
// A compaction: the boundary, then your side of it is the summary the agent carries on from.
{ "type": "system", "subtype": "compact_boundary", "content": "Conversation compacted", "timestamp": "…",
  "compactMetadata": { "trigger": "auto", "preTokens": 167000 } }
{ "type": "user", "isCompactSummary": true, "message": { "content": "This session is being continued from a previous conversation …" } }
```

- Also written, and of no use to an import: `attachment` entries (the environment, the model, deferred tool and skill
  listings, `prompt_snapshot`, the date, …, about half the lines of a short session), `queue-operation`,
  `last-prompt`, `atis-latch`, `cost-state` and `mode`. None has a `message`.
- Left out of a session's history by Claude Code itself when it names a session: `isMeta` user entries, compact
  summaries, tool results, and text that starts with a tag (`<command-name>`, `<local-command-stdout>`, …, what slash
  commands write) or with `[Request interrupted by user`.
- `isSidechain: true` marks a subagent's entries; newer versions keep subagents in their own files instead
  (`<sessionId>/subagents/…`), next to the session's (from the binary; the probe ran no subagent).

## 9. Permissions

Read from `sdk.d.ts` (0.3.281) for per-call permission review (P11, #68), then probed in P11-01: one scratch
`query()` on `haiku` in a temp folder, `settingSources: []` so no user rules got in the way, started in
`bypassPermissions` with `allowDangerouslySkipPermissions: true` and a `canUseTool` that logged each call. It switched
the live session to `default` and back with `setPermissionMode`, between turns, and ran `Bash`, `Edit`, `Write`, `Read`,
a denied call and a foreground subagent's call. What that run showed is marked **[verified]**; the rest is **[docs]**.

- **Glade** runs Allow all as `permissionMode: 'bypassPermissions'` and the ask mode as `'default'`, always with
  `allowDangerouslySkipPermissions: true` and a `canUseTool`, and with its own MCP servers in `allowedTools`
  (`mcp__glade`, a server-wide rule [docs]) so their tools never ask (`src/main/agent/sdk-backend.ts`).
- **[verified] `bypassPermissions` never calls `canUseTool`.** The SDK even warns about it when both are given
  (`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`, a Node process warning), which is harmless: the callback is there for when the
  session switches.
- **[verified] A live session switches between `bypassPermissions` and `default` with `setPermissionMode`, both ways,**
  without restarting: the next turn's `system/init` reports the new `permissionMode`, `canUseTool` is called from the
  next call on after switching to `default`, and not at all after switching back. So a mode change needs no restart
  with `resume`: Glade sends it through `configure`, in order with the messages after it, and it applies from the next
  call, mid-turn too. (The probe switched between turns; mid-turn is by the docs.)
- **[verified] What asks in `default`:** `Edit`, `Write` and `Bash` commands with side effects (`touch`, `mkdir`)
  called `canUseTool`. Claude Code let `Read` of a file in `cwd` and read-only `Bash` (`echo`, `ls`) through without
  asking. Glade decides the rest itself (`src/main/permissions/classify.ts`).
- **[verified] The call shapes.** The `tool_use` streams first, then `canUseTool(toolName, input, options)` is called,
  and the tool's `tool_result` follows once it's answered. Each call asks on its own, with its own `toolUseID` (the
  `tool_use` id) and `requestId`. Haiku made its "parallel" Bash calls one after another, so two prompts at once weren't
  seen; the docs say each call in one assistant message asks separately. What `options` carried:

  ```jsonc
  // Bash `touch two.txt`, in the session's own turn
  {
    "suggestions": [
      { "type": "addRules", "rules": [{ "toolName": "Bash", "ruleContent": "touch two.txt" }],
        "behavior": "allow", "destination": "localSettings" },
      { "type": "addDirectories", "directories": ["/tmp/glade-probe"], "destination": "session" },
      { "type": "setMode", "mode": "acceptEdits", "destination": "session" }
    ],
    "blockedPath": "/tmp/glade-probe/two.txt",
    "displayName": "Bash",
    "description": "Create an empty file named two.txt", // the command's own description
    "toolUseID": "toolu_01…",
    "requestId": "4dc0be03-…"
  }
  // Edit (and Write): only the file's name as the description, and a switch to acceptEdits as the one suggestion
  { "suggestions": [{ "type": "setMode", "mode": "acceptEdits", "destination": "session" }],
    "displayName": "Edit", "description": "a.txt", "toolUseID": "toolu_01…", "requestId": "a9ae62b2-…" }
  ```

  A multi-word command's rule is a prefix: `mkdir three` suggested `ruleContent: "mkdir three *"`. No `title`,
  `decisionReason`, `mcpServer`, `defaultToNo`, `suppressAlwaysAllowRule` or `matchedAskRule` came with these calls;
  their meaning is from the docs: `title` is a prompt sentence the CLI wrote; `mcpServer` is `{ name, source }` for an
  `mcp__*` tool, and `source: 'sdk'` means an in-process server the host registered, the one to trust, never the name
  prefix; `defaultToNo` means the prompt mustn't be approvable by a stray key; `suppressAlwaysAllowRule` means it
  mustn't offer to remember; `matchedAskRule` means a user `permissions.ask` rule forced it.
- **[verified] A subagent's call** asks the same way, with `agentID` set to the SDK's id for the subagent (e.g.
  `ac2cfaf3cec2364e5`), not the `Agent` call's `tool_use` id; its `tool_use` streams first with `parent_tool_use_id`
  set to the `Agent` call, which is how Glade finds which subagent it is. A background subagent's read-only calls went
  through without asking too.
- **[verified] Answers.** `{ behavior: 'allow', updatedInput, decisionClassification: 'user_temporary' }` runs the
  call. `{ behavior: 'deny', message, decisionClassification: 'user_reject' }` doesn't: the call's `tool_result` is an
  error whose text is exactly `message`, the model reads it (it repeated a note put in the message), the turn carries
  on, and the `result` lists the call in `permission_denials`. `decisionClassification` is `user_temporary` (allow
  once), `user_permanent` (always allow) or `user_reject` (deny) [docs]. The promise can stay pending as long as it
  likes: "permission prompts have no park deadline" [docs].
- **`signal`** is aborted when the call is cancelled, e.g. by `interrupt()` [docs]; Glade withdraws the request then.
- **Other modes [docs]:** `'acceptEdits'` also auto-allows file edits, `'dontAsk'` denies what isn't pre-approved,
  `'plan'` runs no tools, `'auto'` lets a classifier decide.
- **Rules [docs]:** `allowedTools` / `disallowedTools` take rule strings such as `Bash(npm test:*)`, which the CLI matches
  itself (it splits compound commands, so a prefix rule doesn't let `npm test && rm -rf x` through). A
  `PermissionUpdate` returned with `destination: 'session'` lasts only as long as the Claude Code process: session
  rules are gone after a relaunch. So Glade keeps a task's rules in SQLite, returns them as `updatedPermissions` when
  granted, and passes them as `allowedTools` when it starts or resumes the task's session (P11-03).
- **[verified] Rules, probed in P11-03:** two scratch `query()`s on `haiku` in a temp folder, `settingSources: []`,
  in `default` with a `canUseTool` that logged each call, each resumed with `resume` and `allowedTools` afterwards.
  - **The suggested rule** is the CLI's own: `npm test` suggested `npm test *` (a prefix, in the ` *` form, even for
    the bare command), `npm testing` suggested `npm testing *`, but `mkdir -p logs/one` and `touch 'a(1).txt'`
    suggested the exact command, no wildcard. A compound command suggests a rule per part (`mkdir -p logs/three &&
    touch evil.txt` suggested both), or only for the parts it would remember (`npm test && rm -rf build` suggested
    just `npm test *`). `Edit` and `Write` suggest only `setMode acceptEdits`, so Glade grants the whole tool.
  - **Live:** answering `{ behavior: 'allow', updatedPermissions: [{ type: 'addRules', rules: [rule], behavior:
    'allow', destination: 'session' }], decisionClassification: 'user_permanent' }` applied at once, in the same
    process: with `npm test *` granted, `npm test -- --watch` and `npm test` ran without asking, while
    `npm test && rm -rf build` and `npm testing` still asked. A whole-tool `Write` rule let the next `Write` through.
    Nothing was written to a settings file.
  - **After a resume:** `allowedTools` with `Bash(npm test:*)` or `Bash(npm test *)` let `npm test -- --coverage`
    through and still asked about `npm test && rm -rf build` and `npm testing`; `Write` let a `Write` through; an
    exact rule for `touch 'a(1).txt'`, written with its parentheses escaped (`Bash(touch 'a\(1\).txt')`), matched it.
    The SDK warns (`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`) that bare tool names in `allowedTools` skip `canUseTool`,
    which is the point.
- **The user's settings still apply [docs]** with `settingSources` including `"user"`: their `permissions.allow`/`deny`
  rules and `PreToolUse` hooks decide before `canUseTool` is asked. Denials made without asking are reported on
  `result.permission_denials` (authoritative) and, best effort, as a system event.
- **No survival across a relaunch [docs].** A pending `canUseTool` lives in Glade's process and the CLI subprocess
  waiting on it. `reinitialize()` redelivers pending requests only to a CLI that is still running (after a transport
  gap); once Glade quits, the subprocess is gone and the resumed transcript has a `tool_use` with no result, as with a
  blocking `ask` (§8, `model-surface.md`). What can survive is Glade's own record of the request: the card, the task
  needing you, and the decision, delivered to the resumed session as a message (P11-04). Glade sends a task's
  decisions in one message once all its requests the app quit on are decided, and lets the agent's next call with the
  same tool and input through once without asking, since Claude Code asks about it afresh (`src/main/agent/runner.ts`).
- **`permissionPromptToolName`** (route prompts to an MCP tool) and **`permissionPrompts: 'none'`** (never ask) are
  the alternatives [docs]; neither fits a card that waits for the user.

## 10. Claude Code's todo tools [verified]

Probed with SDK 0.3.281 (Claude Code 2.1.281) for #167: the `init` tool list of a one-message session in an empty temp
folder, with no settings sources, per model and environment.

| Model | Extra `env` | Todo tools in `init` |
| --- | --- | --- |
| `claude-haiku-4-5` | none | `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate` |
| `claude-haiku-4-5` | `CLAUDE_CODE_ENABLE_TASKS=false` | `TodoWrite` |
| `claude-sonnet-5` | none | none |
| `claude-sonnet-5` | `CLAUDE_CODE_ENABLE_TASKS=1` | none |
| `claude-sonnet-5` | `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` | `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate` |
| `claude-sonnet-5` | `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, `CLAUDE_CODE_ENABLE_TASKS=false` | `TodoWrite` |
| `claude-opus-5-5[1m]` | none | none |
| `claude-opus-5-5[1m]` | `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` | `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate` |

How the bundled binary decides, from its code:

- **Whether there are todo tools at all:** yes in an interactive session, or when the SDK's `tools` option names one of
  them, or when the main model is unknown or on a fixed list of older models (Claude 3.x, Opus/Sonnet 4.0–4.7, Haiku
  4.5), or when `CLAUDE_CODE_ENABLE_TODO_TOOLS` is true. So an SDK session on Opus 5.5 or Sonnet 5 has none, and the
  model can't find them with `ToolSearch` either. The model is checked live, so a `setModel` mid-session changes it.
- **Which ones:** `TaskCreate`/`TaskGet`/`TaskList`/`TaskUpdate` unless `CLAUDE_CODE_ENABLE_TASKS` is false, which
  swaps in the older `TodoWrite`.
- They are deferred tools (`shouldDefer`): the model loads them with `ToolSearch` (`select:TaskCreate,TaskUpdate`)
  before its first call. `TaskStop` is unrelated (it stops a background task) and is always there.

**Glade sets `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` in every session's `env`** (`SESSION_ENV` in `sdk-backend.ts`), and
leaves `CLAUDE_CODE_ENABLE_TASKS` to the user.

A real session built from Glade's `sdkOptions` (`claude-sonnet-5`), asked to keep a two-item list, made these calls,
which match the Todos tab's schemas (`src/main/todos/schema.ts`) and the scripted backend's `keeps-todos` script:

```text
{ "name": "ToolSearch", "input": { "query": "select:TaskCreate,TaskUpdate", "max_results": 5 } }
{ "name": "TaskCreate", "input": { "subject": "Say hello", "description": "Say hello" } }
→ "Task #1 created successfully: Say hello"
{ "name": "TaskUpdate", "input": { "taskId": "1", "status": "in_progress" } }
→ "Updated task #1 status"
{ "name": "TaskUpdate", "input": { "taskId": "1", "status": "completed" } }
→ "Updated task #1 status"
```

`activeForm` is optional, and the model left it out here. Glade's parser and `deriveTodoList` turned these into "Say
hello" done and "Say goodbye" todo.

## 11. Follow-ups the agent schedules itself [verified]

Probed with SDK 0.3.281 (Claude Code 2.1.281) for #168, on Haiku in throwaway folders with direct `query()` calls, then
once per tool on `claude-sonnet-5` through Glade's own `sdkOptions`. The question: which tools let the agent wait for
something and carry on by itself, how each one wakes it, and what survives a `resume`.

**What SDK sessions have.** Every `init` tool list (Haiku 4.5, Sonnet 5 and Opus 5.5, with a bare environment and no
settings sources) had `Bash` (with `run_in_background`), `Agent`/`Task` (with `run_in_background`), `Monitor`,
`ScheduleWakeup`, `CronCreate`, `CronDelete`, `CronList` and `TaskStop`, and also `PushNotification`, `RemoteTrigger`,
`SendMessage` and `ListAgents`. None needs turning on, unlike the todo tools (§10): the binary only turns the cron tools
off for `CLAUDE_CODE_DISABLE_CRON`, or a server-side flag (`tengu_kairos_cron`, on by default), and background tasks
for `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`. Glade sets neither. `Monitor` and the cron tools are deferred: Sonnet 5
loaded them with `ToolSearch` (`select:Monitor`) before its first call, and called `ScheduleWakeup` straight away.

| Tool | Returns | Wakes the agent with |
| --- | --- | --- |
| `Bash` + `run_in_background` | at once: "Command running in background with ID: …" | its `task_notification` when the command exits ("Turns the agent starts itself") |
| `Agent` + `run_in_background` | at once: "Async agent launched …" | its `task_notification` when the subagent ends ("Background subagents") |
| `Monitor` | at once: "Monitor started (task …)" | a turn per event (stdout line, batched within 200 ms), with nothing before it; then its `task_notification` when the command exits, times out or is stopped |
| `ScheduleWakeup` | at once: "Next wakeup scheduled for 01:16:00 (in 102s)" | a turn when it fires, started as an SDK command |
| `CronCreate` | at once: "Scheduled one-shot task ea750053 (16 1 25 9 *). Session-only …" | a turn at each fire time, started as an SDK command |

Every tool returns straight away, and the turn that called it ends without waiting, as a background subagent's does.
Each wake is a turn the agent starts on its own: its assistant messages carry no `user_message_uuid` and its `result`
no `user_message_uuids`. What comes before it and what the `result` says differs:

```
Monitor: tool_use Monitor { description: "ticks", timeout_ms: 60000, command: "for i in 1 2; do sleep 8; echo tick $i; done" }
 4.0  system/background_tasks_changed  { tasks: [{ task_id: "bl14…", task_type: "local_bash", description: "ticks" }] }
 4.0  system/task_started  { task_id: "bl14…", tool_use_id: <the Monitor call>, task_type: "local_bash", is_backgrounded: true }
 4.0  user  tool_result "Monitor started (task bl14…, expires in 1m …). You will be notified on each event. …"
            tool_use_result: { taskId: "bl14…", timeoutMs: 60000, persistent: false }
 4.8  result/success  { origin: { kind: "human" }, user_message_uuids: [the message] }
12.3  system/init … assistant [text] "tick 1" … result/success { origin: { kind: "task-notification" } }   ← nothing first
20.0  system/background_tasks_changed { tasks: [] }, task_updated { status: "completed" },
      task_notification { tool_use_id: <the Monitor call>, status: "completed", summary: "Monitor \"ticks\" stream ended" }
20.1  system/init … assistant [text] "tick 2" … result/success { origin: { kind: "task-notification" } }

ScheduleWakeup (CronCreate is the same):
  5.3  tool_use ScheduleWakeup { delaySeconds: 60, reason: "probe", prompt: "Reply with exactly: WOKE UP", noop: false }
       tool_result "Next wakeup scheduled for 01:16:00 (in 102s). Nothing more to do this turn — the harness
                    re-invokes you when the wakeup fires or a task-notification arrives."
       tool_use_result: { scheduledFor: 1790313360000, clampedDelaySeconds: 60, wasClamped: false }
107.7  command_lifecycle { command_uuid: <not one of Glade's>, state: "started" }    ← no "queued"
107.8  system/init … assistant [text] "WOKE UP"
109.7  result/success  { num_turns: 1 }                                             ← no origin, no user_message_uuids
109.7  command_lifecycle { state: "completed" }
```

- **The job's prompt never shows** as a message: the agent reads it, and Glade only sees the turn it starts. Two jobs
  due at once ran as one turn, with a `command_lifecycle` each.
- **Timing.** `ScheduleWakeup` clamps `delaySeconds` to 60–3600 and fires on a whole minute: asked for 60 s, it fired
  after 102 s. Its description says it's for `/loop`'s self-paced mode, but the models used it when asked to "check back
  in a minute". `CronCreate` takes a 5-field cron in local time; `recurring: false` fires once, a recurring job re-fires
  until deleted or for 7 days. `Monitor` times out after `timeout_ms` (default 5 minutes, at most 30).
- **`durable: true` isn't available.** Asked for a durable cron, the SDK session made it session-only anyway
  (`durable: false` in its result, "Session-only (not written to disk, dies when Claude exits)"), and nothing was
  written to `.claude/scheduled_tasks.json`.
- **Stop.** `interrupt()` during a turn a `Monitor` event woke ended that turn as usual (`error_during_execution`, with
  `origin: task-notification`), and the watch carried on: its next event woke the agent again. Interrupting doesn't
  cancel a wakeup, cron job or watch; only the agent can (`ScheduleWakeup` with `stop: true`, `CronDelete`,
  `TaskStop`), or `stopTask` with the watch's task id, or closing the session.
- **Resume.** One session scheduled a `ScheduleWakeup` (60 s), a session-only one-shot `CronCreate` and a "durable" one
  for the same minute, and was closed straight away; a new process then resumed it with `resume` and no message. At
  the fire time the resumed session ran both cron jobs, in one turn with no message sent. The `ScheduleWakeup` never
  fired. So the SDK restores a session's cron jobs from its transcript on resume, but not its wakeups; background
  commands, subagents and monitors die with the process. Not probed: a cron job whose time passed while no process ran,
  and recurring jobs across a resume.
- User turns now get `origin: { kind: "human" }` on their `result`, echoing the origin Glade stamps on each message.

**Implications for Glade (#168)**

- Glade enables nothing and builds nothing for these: each wake is a turn the agent starts on its own, which the runner
  already opens, saves and shows (#162), with unread and a notification, and which Stop stops. The runner doesn't read
  `origin` or `command_lifecycle`.
- A `Monitor` call's row is done as soon as the watch starts; its `task_started` and final `task_notification` are
  matched to the call but change nothing, as it isn't a subagent.
- A live session keeps its jobs, watches and background work until Glade closes it (the task is deleted or the app
  quits); marking a task done doesn't, so a job can still wake a done task, which stays done (#162).
- The scripted backend's `wake` step plays each shape (`WakeCause` in `src/main/agent/scripts.ts`).

---

## 12. Two MCP servers with one name [verified]

**What a task gets when the user's own Claude Code config also has a `glade-control` server** (P13-03): the command
Settings › Control gives, `claude mcp add --transport http glade-control <url> --header …`, run in the workspace, adds
one to the local config (or the user config with `-s user`), and Glade's session passes its in-process `glade-control`
in `mcpServers` too.

**How:** a throwaway script outside the repo. A temp `CLAUDE_CONFIG_DIR` with no login (so no API call is ever made:
each turn ends "Not logged in"), a temp folder as the workspace, the bundled binary's own `claude mcp add` pointing at
a local HTTP MCP server with one tool (`http_only_probe`), and a `query()` with `settingSources: ['user', 'project',
'local']` and an in-process `glade-control` with another (`inproc_probe`). Two turns, reading `system/init` and
`mcpServerStatus()` after each. SDK 0.3.281, Claude Code 2.1.281.

**[verified] Without anything done about it, the two merge under the one name:**

- The first `system/init` lists the server once, `{"name":"glade-control","status":"pending","source":"local"}`, with
  only the in-process tool, while the HTTP one connects.
- From the next turn on, `tools` has both, `mcp__glade-control__http_only_probe` and
  `mcp__glade-control__inproc_probe`, and `mcpServerStatus()` reports one server, `source: "local"`, `type: "http"`,
  with both tools. The same with `-s user` (`source: "user"`).
- With Glade's real endpoint behind the user's server, every tool would be there twice under one name, the HTTP ones
  calling Glade as `http` rather than as the task (so the self-guard wouldn't apply), and the server would no longer be
  reported as the in-process one, so the ask mode would ask for its reads too.

**[verified] Denying the name keeps the user's out and the in-process one in.** Passing
`settings: { deniedMcpServers: [{ serverName: 'glade-control' }] }` in the SDK options (flag settings, whose
`deniedMcpServers` merges with the user's own) leaves the user's server out: the HTTP server is never contacted, and
both `system/init`s and `mcpServerStatus()` show one `glade-control`, `source: "sdk"`, `scope: "dynamic"`, with only
the in-process tool. The denylist doesn't reach SDK servers. Denying by `serverUrl` does the same, but only for that
URL.

**Decided:** every session is started with `glade-control` denied by name (`src/main/agent/sdk-backend.ts`), whether
the switch is on or off: a Glade task reaches Glade in-process or not at all, never through the user's config.

## 13. Watchers: following what the agent leaves running [verified]

Probed with SDK 0.3.281 (Claude Code 2.1.281) for #250, on Haiku in throwaway folders with direct `query()` calls in
streaming input mode, with in-process `UserPromptSubmit`, `Stop` and `PostToolUse` hook callbacks logging what they were
given. Every session was closed at the end, which ends its session-only jobs; the one cron job left recurring was
deleted by the agent first. The question: can Glade list, follow and stop what the agent starts with the tools in §11,
without building any watching of its own?

**What starts a watcher.** A `Monitor` call and a `Bash` call with `run_in_background` each start a task the SDK runs in
the background, reported as it starts, then the call's result names it:

```
tool_use Monitor { description: "ticks", timeout_ms: 60000, command: "for i in 1 2 3; do sleep 4; echo tick $i; done" }
system/background_tasks_changed { tasks: [{ task_id: "b03hdfcxm", task_type: "local_bash", description: "ticks" }] }
system/task_started { task_id: "b03hdfcxm", tool_use_id: <the call>, description: "ticks", is_backgrounded: true,
                      task_type: "local_bash" }
user tool_result "Monitor started (task b03hdfcxm, expires in 1m …)"   tool_use_result: { taskId, timeoutMs: 60000,
                                                                                         persistent: false }
tool_use Bash { command: "sleep 6; echo bg done", description: "bg ok", run_in_background: true }
system/task_started { task_id: "be993izhk", …, task_type: "local_bash", is_backgrounded: true }
user tool_result "Command running in background with ID: be993izhk. Output is being written to: …/be993izhk.output."
     tool_use_result: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "be993izhk", … }
```

`ScheduleWakeup` and `CronCreate` start no task; their results say what they scheduled:
`{ scheduledFor: 1790377320000, clampedDelaySeconds: 60, wasClamped: false }` and
`{ id: "56a9acf7", humanSchedule: "Every minute", recurring: true, durable: false }`. `CronDelete`'s is `{ id }`.

**How it ends.** A task's end is a `task_updated` (`status: completed | failed | killed`) and a `task_notification`
(`status: completed | failed | stopped`) naming the call, whose `summary` says how: `Monitor "ticks" stream ended`,
`Monitor "fails" script failed (exit 7)`, `Background command "bg fail" failed with exit code 3`,
`Background command "bg ok" completed (exit code 0)`. A monitor that times out ends `stopped`, its summary just its
description, as when it's stopped; only the time tells them apart.

**Its wakes are prompts, seen only by the hook.** Nothing in the message stream carries a monitor's events: each wake
is a prompt the SDK submits itself, which reaches the session's `UserPromptSubmit` hook (`{ prompt, prompt_id, … }`, no
`source` field in this version) just before the turn's `system/init`:

```
<task-notification>                       ← a monitor event; lines within ~200 ms come as one event
<task-id>be9dsw3k8</task-id>
<summary>Monitor event: "burst"</summary>
<event>a
b</event>
</task-notification>

<task-notification>                       ← a task ending (a command's, or a monitor's with its last event)
<task-id>be9dsw3k8</task-id>
<tool-use-id>toolu_014n…</tool-use-id>
<output-file>…/tasks/be9dsw3k8.output</output-file>
<status>completed</status>
<summary>Monitor "burst" stream ended</summary>
<event>c</event>
</task-notification>
```

A job firing submits its own prompt, as the agent wrote it (`Reply with exactly: CRON TICK`), with a
`command_lifecycle` of the SDK's own uuid first. A monitor's timeout wakes it once more, with
`<event>[Monitor expired after 5s with no events delivered. …]</event>`. A task stopped with `stopTask` doesn't wake
it.

**The session's jobs, as each turn ends.** The `Stop` hook gets `session_crons`: every job the session still has,
`{ id, schedule, recurring, prompt }`. A `ScheduleWakeup` is one of them: a one-off job at its whole minute
(`{ id: "f4f53242", schedule: "2 19 * * *", recurring: false }`), whose id only shows here. A fired one-off job, or a
deleted one, is gone from the next list. (It also gets `background_tasks`, `{ id, type: "shell", status, description,
command }`, which the task messages already say.)

**Stopping from outside the session.**

- A monitor or background command: `stopTask(task_id)` kills it at once: `task_updated { status: killed }`, then
  `task_notification { status: stopped, summary: <its description> }`, and no wake.
- A wakeup or cron job: the `Query` has no call to list or delete one (no control request either; `CronDelete` is the
  agent's). But a `UserPromptSubmit` hook answering `{ decision: "block", reason }` turns the job's fire away: the SDK
  streams `system/init`, `system/informational` (`UserPromptSubmit operation blocked by hook: <reason> … Original
  prompt: …`, `prevent_continuation: true`) and a bare `result/success` (no `origin`, no model call), and the model never
  sees it. The job stays in the session (`CronList` still lists a recurring one, and it fires again, to be turned away
  again) until the agent deletes it, it expires, or the session ends. Checked for both a `CronCreate` job and a
  `ScheduleWakeup`.
- The hook sees every prompt, the host's own messages included, so it has to tell those apart: a hook that turned away
  anything containing a stopped job's words also turned away the host's message that mentioned them.

**Decided (#250):**

- Glade builds no watching and adds no tool: the agent writes whatever script it likes and runs it with `Monitor` or
  `run_in_background`, and the runner follows what the SDK reports (`src/main/watchers`). A script the agent
  backgrounds inside a foreground `Bash` call (`nohup ./watch.sh &`) is invisible to the SDK, so the system prompt asks
  for the SDK's tools instead (`docs/model-surface.md`).
- Every session gets the two hooks (`sdkHooks` in `src/main/agent/sdk-backend.ts`). The runner remembers the prompts it
  sent (`give`) and never counts or turns away one of its own; any other `<task-notification>` counts a wake on the
  watcher it names, and any other prompt that's a live job's is a fire.
- Stop uses `stopTask` for a monitor or command; for a wakeup or job it marks it stopped and turns its fires away by
  exact prompt, as long as no live job of the task has the same prompt.
- A relaunch ends running watchers and wakeups ("Stopped by the relaunch.", as §11 found) and suspends cron jobs until
  the resumed session's first `Stop` hook lists them again.

---

## Open risks

- **Subscription auth policy.** Glade is login-based by decision, but the docs don't clearly permit this for a
  third-party app, and Anthropic can enforce "without prior notice". If that happens, Glade would need an API-key path.
- **Auto-compact threshold.** Glade uses the SDK default (about 83% on 200k). A custom threshold is deferred; the SDK
  caps it at about `window − 13k`.
- **One CLI subprocess per live task.** Each `query()` spawns the ~220 MB native binary as a separate process. With many
  parallel tasks (P2), memory and startup cost need measuring. Idle tasks may need to `close()` and `resume` lazily.
- **Blocking `ask` across a crash.** If Glade dies while `ask` is waiting, the resumed session has a `tool_use` with no
  result. We haven't tested how the CLI repairs this; test it in P4.
- **The SDK moves fast.** The union has about 40 message types, many with `@alpha` fields, and the auto-compact maths is
  internal. Pin the SDK version, parse defensively (ignore unknown types and fields), and re-check these notes on each
  upgrade.
- **Inherited user config.** With `"user"` settings on, the user's own hooks, plugins, MCP servers, claude.ai connectors
  and permission rules run inside Glade tasks. That is intended, but it can surprise; for example, a user hook can
  block tools.
- **The `env` option replaces the environment.** Passing `env` without spreading `process.env` drops `PATH`/`HOME` and
  the login.
- **Not exercised:** the API-key path, `api_retry`, real auto-compaction (the `"auto"` trigger) and usage-limit
  errors. Their shapes above come from the types.

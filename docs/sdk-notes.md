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
  text and thinking [docs].
- `agentProgressSummaries: true` adds a one-line `summary` to `task_progress` about every 30s [docs].
- Background Bash commands use the same `task_*` events with `task_type: "local_bash"`, plus
  `system/background_tasks_changed` [verified].

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
- **Not exercised:** the API-key path, `api_retry`, real auto-compaction (the `"auto"` trigger), usage-limit errors,
  and `forwardSubagentText`. Their shapes above come from the types.

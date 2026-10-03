# Claude Agent SDK notes (P1-01 spike)

What the rest of P1 needs to know about the Claude Agent SDK, with evidence.

- **Tested:** `@anthropic-ai/claude-agent-sdk` **0.3.283**, which bundles Claude Code **2.1.283** as a native binary.
  Node 25, macOS (arm64). September 2026. Most probes below ran on 0.3.281 (Claude Code 2.1.281) and say so; each bump
  since is checked against them from its changelog and `sdk.d.ts` (see "SDK bumps", at the end).
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
  `initializationResult().account`) so the user is never surprised about billing. #281: Settings › General shows it,
  read with `accountInfo()` as each task's session starts and kept in SQLite (`src/main/account/account.ts`).

### Account info [verified]

Probed on SDK 0.3.281 with Haiku (#281): `accountInfo()` answers straight after `query()` starts, before any message is
sent, so reading it costs no API call; `initializationResult().account` is the same object. Its fields depend on the
credential. Values below are invented:

```jsonc
// A Claude subscription login (no tokenSource; subscriptionType is Claude Code's display name)
{ "email": "sam@acme.dev", "organization": "Acme Robotics", "subscriptionType": "Claude Max", "apiProvider": "firstParty" }
// ANTHROPIC_API_KEY set, on a machine that also has a login: the key is used, and there's no email or plan
{ "tokenSource": "claude.ai", "apiKeySource": "ANTHROPIC_API_KEY", "apiProvider": "firstParty" }
// Nothing signed in (an empty CLAUDE_CONFIG_DIR)
{ "tokenSource": "none", "apiProvider": "firstParty" }
```

- `system/init.apiKeySource` was `"none"` for the login, as in §1. `accountInfo()` carries the same `apiKeySource`
  when there's a key, so Glade reads only `accountInfo()`.
- From the bundled binary [docs]: a non-`firstParty` `apiProvider` (Bedrock, Vertex, Foundry, a gateway, …) comes
  alone; `tokenSource` is left out for a subscription (then `subscriptionType` is set) and set for
  `CLAUDE_CODE_OAUTH_TOKEN`; email and organization come only for a claude.ai or `/login managed key` login. With a
  plan and a key both present, Claude Code uses the plan and calls the key "not in use". Glade's `accountKind` follows
  that order.

### Logged out [docs]

What the SDK and the bundled Claude Code (0.3.283 / 2.1.283) say when the login expires or goes (#409), from `sdk.d.ts`
and the binary's own strings. Not probed live: that would mean logging Jared's machine out.

- **There's no auth status or login in the SDK's API.** `Query` has `accountInfo()` (§1) and nothing to log in or out
  with, and no control request for it. `SDKStartupFailureReason` names no lost login either (its
  sign-in reasons, `org_*` and `gateway_*`, are an organization's pin and a Cloud gateway's, which `claude auth login`
  doesn't fix). `SDKAuthStatusMessage` (`type: 'auth_status'`, `isAuthenticating`, `output`, `error`) only reports a
  cloud provider's credential refresh command (`awsAuthRefresh`, `gcpAuthRefresh`) running, and only with an internal
  `enableAuthStatus` option that isn't in `Options`. `session_stale_relogin` and `untrusted_device` are in the alpha
  Remote Control bridge's `CredentialsFailure` (`bridge.d.ts`), a 403 when minting remote session credentials: not
  something `query()` sees.
- **The error arrives as an API error.** The turn's last `assistant` message has `error: "authentication_failed"`
  (`SDKAssistantMessageError`) and its text is the error; the `result` is `is_error: true`, `terminal_reason:
  "api_error"`, with `api_error_status` 401 when the API itself refused it, and none when Claude Code failed the
  request before sending it. Claude Code doesn't retry it. An SDK session (non-interactive) words it as:
  - "Not logged in · Please run /login": no credential at all.
  - "Failed to authenticate: OAuth session expired and could not be refreshed": an expired login whose refresh token
    failed too. (An interactive session says "Login expired · Please run /login".)
  - "Failed to authenticate. API Error: 401 {…"type":"authentication_error"…}": any other 401 on Anthropic's API.
  - "Your account does not have access to Claude. Please login again or contact your administrator." (interactive:
    "OAuth token revoked · Please run /login").
  - With `/login managed key` the organization turned off: "… · Sign in again with your claude.ai account".
- **`authentication_failed` that logging in doesn't fix:** an external key ("Invalid API key · Fix external API key"),
  a cloud provider's credentials ("AWS credentials expired or invalid · …", Google Cloud, Foundry, each with
  `apiError: "provider_credentials"`, which the SDK message doesn't carry), a gateway that refused it ("… signing in
  again won't change this …"), and "Authentication error · This may be a temporary network issue" (remote sessions
  only). Another Claude Code process refreshing the login at the same moment is a `server_error` ("… another Claude Code
  process is refreshing it …"), which goes away.
- **A running Claude Code mostly picks a new login up itself.** On a 401 it re-reads the stored credential and carries
  on with a newer one if there is one (`tengu_oauth_401_recovered_from_keychain`, `…_from_disk`). That needs a 401 to
  happen, though: one that started with no credential at all fails before it sends anything.

**Decided (#409):** Glade parses these at the boundary into their own kind, `AgentErrorKind.LoggedOut`
(`src/main/agent/error-classification.ts`): `authentication_failed`, a 401, or the words above, unless the message names
something logging in doesn't fix (an external key, a key to unset, a cloud provider, a gateway, a passing network
error, another process refreshing). The task stops on it (it never pauses) with the logged-out card.

### Logging in [docs]

`claude auth login` (the bundled binary's subcommand; `claude auth` also has `logout` and `status [--json|--text]`)
logs in without a terminal [docs, from `--help` and the binary; not run]:

- `--claudeai` (the default), `--console` (API billing), `--sso`, `--email <email>`. Under managed settings that pin a
  Cloud gateway it refuses ("run interactive /login"), and exits 1.
- It starts a listener on a localhost port, opens the browser (`open`) at the sign-in page, whose redirect comes back to
  that port, and prints "Opening browser to sign in…", "If the browser didn't open, visit: <url>" (a second, manual
  link) and "Paste code here if prompted > ". It reads stdin for a pasted `code#state` from the manual link, but doesn't
  need it: the browser's redirect completes it by itself.
- Once signed in it saves the login where Claude Code keeps it (the Keychain), prints "Login successful." and exits 0;
  a failure prints "Login failed: …" (or "OAuth login failed: …") to stderr and exits 1.
- `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` with `CLAUDE_CODE_OAUTH_SCOPES` logs in from a refresh token instead, with no
  browser. Glade never sets them.

**Decided (#409):** Log in (the logged-out card's, and Settings › General's) runs the bundled binary's `auth login`
from main, with no terminal (`src/main/account/login.ts`): in the agents' environment, from your home folder, its
stdin a pipe nothing is written to, its output never logged (the manual link is a one-time one). Exit 0 is logged in;
anything else fails with the last line it printed on stderr. One runs at a time; Cancel kills it. Glade sees only
whether it worked, never the credential: sign-in completes through Anthropic's own flow, in the unmodified binary, as
§1 and `decisions.md` require. Once you're in, the task whose Log in was clicked is retried by itself; the others wait
for their Retry or Retry all. Retrying a turn a lost login stopped first closes the task's Claude Code process (unless
background work is running in it) and starts it again on the same conversation, so it reads the new login even when
it started with none. The terminal tab the issue offered as a fallback isn't needed.

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
  (`claude-opus-5-5[1m]`). See "The context window, and which `modelUsage` entry it is" below for how Glade finds it.
- **Or ask:** `q.getContextUsage({ detail: "summary" })` returns
  `{ totalTokens, maxTokens, percentage, autoCompactThreshold, isAutoCompactEnabled, memoryFiles, … }`. Its estimate ran
  higher than the per-message sum (29.0k vs 23.1k), and **right after a compaction it was stale** (31.4k, while the next
  request used 21.6k). Prefer the per-message usage, and use `getContextUsage()` for the threshold and the
  per-category breakdown.
- After compaction, `compact_boundary.compact_metadata.post_tokens` is the new baseline until the next assistant message
  arrives.

### The context window, and which `modelUsage` entry it is (#416) [from the SDK's types and binary, not probed]

A task on "Opus 5.5" read **905k / 200k**: its session ran at 1M, and Glade divided by a 200k guess. Read from
`sdk.d.ts` and the bundled CLI (0.3.283 / Claude Code 2.1.283), with no API call:

- **The id doesn't say the window.** The CLI's model catalog gives each model a `context` entry. Some are 1M only as a
  `[1m]` variant (`{ window: 200000, supports_1m_suffix: true }`), but the newer ones are **natively 1M with no
  suffix**: `claude-opus-5-5` is `{ window: 1e6, native_1m: true, … }`. So "`[1m]` means 1M, anything else 200k" is
  wrong for them. The suffix is matched whatever its case (`/\[1m\]/i`).
- **`ModelInfo` (`supportedModels`) has no context field:** `value`, `resolvedModel`, `displayName`, `description`,
  the effort fields, `supportsAdaptiveThinking`, `supportsFastMode`, `supportsAutoMode`. The only hints are a `[1m]` on
  `value` or `resolvedModel`, and "1M" in the name or description ("Opus (1M context)", "Opus 5.5 with 1M context"),
  which a row for a natively 1M model may not carry ("Opus 5.5 · Most capable …").
- **`modelUsage` is keyed by the model string each API request was made with** (the CLI credits usage to the
  request's own model, and works `contextWindow` out from that string and the session's betas). That is the *resolved*
  model, not the alias Glade passed: a task on `opus`, `default` or `opus[1m]` gets a key like `claude-opus-5-5` or
  `claude-opus-5-5[1m]`. It usually equals `system/init`'s `model`, but nothing in the types promises that, and each
  entry's `canonicalModel` "may differ from the raw model string this entry is keyed by (provider-specific ids,
  aliases)". It has **one entry per model the `query()` has used**: subagents on another model, and the model before
  a `setModel`, add their own, and a resumed session carries on from the totals its transcript saved.
- **`getContextUsage()` is not the model's window.** Its `maxTokens` and `rawMaxTokens` are both the window the SDK
  *compacts in* (the CLI sets them to the same value), which `autoCompactWindow` /
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` shrink (§5: 100000 on a 200k model). It does carry `model`. Glade keeps using it
  for the threshold only.

**What Glade does:**

- **The source is `modelUsage[…].contextWindow` on each turn's `result`**, matched by `matchReportedWindow`
  (`src/shared/contextWindow.ts`): the entry keyed by `init.model`, else by the task's model id, else by the full id
  the model list gives that id (`resolvedModel`); else an entry that is one of those spelled another way (case, a date
  after it); else **the only entry**, whatever its key, but only while the session has run on one model. After a
  model change (the picker, Retry with another model, a refusal's fallback) a lone entry may be the model before, from
  a turn that ended before the new model answered, so it's matched by name only; a mid-turn fallback also forgets
  `init.model` until the next init. With no match (the entries are other models'), it keeps the window it has and logs
  a warning with the names and the keys.
- **It's stored with the task** (`tasks.context_window_tokens`), so a relaunch, or switching tasks, shows it with no
  session running, and nothing overwrites it with a guess while the task stays on that model. A model change keeps it
  when the new id is the same model (two rows with one `resolvedModel`) or guesses the same size, and otherwise takes
  the new model's guess, clearing the auto-compact threshold with it.
- **It's also remembered by model** (`reported_context_windows`, migration 51), under the `modelUsage` key,
  `init.model`, the task's id and its full id. **The guess** for a task that hasn't had a report (a new task, a model
  change) is `guessContextWindow` (`src/shared/models.ts`): the window last reported for that model, else 1M if the id
  or its `resolvedModel` ends in `[1m]` or the list's name or description says 1M, else 200k.
- **Used > window is proof the window is wrong.** A task never shows more used than its window: the window becomes the
  smallest the SDK gives that holds what's used (200k, 1M), or the amount itself beyond those (`fitContextWindow`).
  Only what's used counts: a threshold from `getContextUsage()` above the window isn't proof, since it's asked for
  after the turn and a model change can leave it stale. A threshold that was for the wrong, smaller window is dropped, so the meter uses the SDK's default for the right one until the SDK says again. The runner logs
  `more context used than the window holds; trusting the larger size`.
- **The auto-compact percentage** is the threshold over that window, so it follows: 967k of 1M is 97%.

**Names, and the 1M variants in the picker:**

- `setModel` and the `model` option take aliases (`sonnet`, `opus`, `haiku`, `fable`, `best`, `opusplan`, and
  `sonnet[1m]`, `opus[1m]`, `fable[1m]`), full ids, and a full id with `[1m]`. The CLI checks a `[1m]` id against the
  catalog and the account, and refuses one it can't run ("… doesn't have a 1M context window", "Opus with 1M context
  is not available for your account"). **Nothing in `supportedModels` says which models an account can run at 1M**,
  so Glade offers only the 1M variants the SDK lists (a row whose `value` ends in `[1m]`), each right after its base
  model's row, and doesn't make any up.
- A task keeps whatever model it has (an old default, an import, one the list has since dropped): the picker always
  lists it, checked, after its base model if it's a 1M variant, else last.
- Every id gets a name, never the raw id (`modelName`): the list's `displayName`; for a 1M variant the list doesn't
  have, its base model's name and "(1M)" (`opus[1m]` → "Opus 5.5 (1M)"); else the name a full id spells out
  (`claude-opus-4-8` → "Opus 4.8"), or the newest of an alias's family in the list. Only an id that's none of those (a
  custom model) shows as it is. The input bar adds "(1M)" for a task whose window is 1M when the name doesn't say so.

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
- `agentProgressSummaries: true` adds a one-line `summary` to `task_progress` about every 30s [verified, below].
- Background Bash commands use the same `task_*` events with `task_type: "local_bash"`, plus
  `system/background_tasks_changed` [verified].

**Progress summaries [verified]** (#278). Probed on SDK 0.3.281 with Haiku, in a throwaway folder, with
`agentProgressSummaries: true`: one foreground subagent ran four `sleep 20 && echo …` Bash calls, one at a time, for
82s. Timings are seconds from the start.

```
 5.7  system/task_started   { task_id: "ae9b…", tool_use_id: "toolu_011g…", task_type: "local_agent", … }
 7.8  system/task_progress  { task_id: "ae9b…", tool_use_id: "toolu_011g…", description: "Running Wait 20 seconds then print one",
                              usage: { total_tokens: 12170, tool_uses: 1, duration_ms: 2075 }, last_tool_name: "Bash" }
29.4  system/task_progress  { …, description: "Running Wait 20 seconds then print two", usage: { …, tool_uses: 2 }, last_tool_name: "Bash" }
39.4  system/task_progress  { task_id: "ae9b…", tool_use_id: "toolu_011g…", description: "Running sleep 20 && echo one",
                              subagent_type: "general-purpose", usage: { total_tokens: 13530, tool_uses: 2, duration_ms: 33651 },
                              summary: "Running sleep 20 && echo one" }                  ← no last_tool_name
50.4  system/task_progress  { …, description: "Running Wait 20 seconds then print three", usage: { …, tool_uses: 3 }, last_tool_name: "Bash" }
71.5  system/task_progress  { …, description: "Running Wait 15 seconds then print four", usage: { …, tool_uses: 4 }, last_tool_name: "Bash" }
73.4  system/task_progress  { …, description: "Executing second bash command.", usage: { …, tool_uses: 4, duration_ms: 67675 },
                              summary: "Executing second bash command." }
87.5  system/task_updated   { task_id: "ae9b…", patch: { status: "completed", end_time: … } }
87.5  system/task_notification { task_id: "ae9b…", status: "completed", summary: <its final reply>, usage: { … } }
```

- A summary comes on a `task_progress` of its own, about every 30s after the subagent starts (here at 39s and 73s),
  with `summary` set, `description` the same text, and no `last_tool_name`. The progress messages after each tool call
  carry no `summary`, as before.
- It's one short line, but not always current: the fork summarises the conversation so far, so it can lag a call or
  two behind (at 39s it named the first command while the second ran; at 73s it said "second" during the fourth).
- None came after the subagent ended in this run, but nothing in the SDK's types rules a late one out.
- The subagent's own foreground Bash calls got `task_started` and `task_notification` of their own (`local_bash`,
  `owned_by_subagent: true`), as in "Background subagents" below.

**Implications for Glade (#278)**

- Glade sets `agentProgressSummaries: true`. The runner reads a `task_progress` that has a `summary` and names a
  `tool_use_id`, collapses its whitespace to one line, and keeps it on that `Agent` call's row in SQLite
  (`progress_summary`) while the call runs. One for a call that has finished, isn't an `Agent` or `Task` call, or
  isn't in the log is ignored. The row's summary is cleared once the call stops running (done, failed, paused or
  interrupted, a relaunch included).
- The Subagents tab shows it under a running subagent's name, on one line with the whole of it in its tooltip. It
  isn't sent to plugins.

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
  any subagent. Glade reads `task_progress` only for its summary (see "Subagents" above).
- Its calls and notes are logged whenever they arrive, with the turn its `Agent` call was made in. They never open a
  turn, and the end of a turn doesn't fail them. Its calls still running when it ends fail with it.
- Stop subagent calls `stopTask` with its task id, as for a foreground one.
- A background subagent dies with its session. If the process fails, its row fails. If the app quits, its row is left
  running and is interrupted on the next launch, whatever state its task is in.
- In the dogfooding session behind P9-03, the parent that stayed "working" for ten minutes was running a *foreground*
  `Agent` call (`run_in_background: false`). That turn really does wait for its subagent. Background subagents never
  kept a turn open.

### Subagents woken again [from the SDK's types and binary, not probed]

Read from SDK 0.3.283's `sdk.d.ts` and the Claude Code 2.1.283 binary it bundles (#395), after a kitten that a
supervisor messaged with `SendMessage`, hours after it had finished or been interrupted by a Glade restart, showed as
done or interrupted while it ran. No new message type marks it; the SDK starts the subagent's task again:

```
assistant  tool_use SendMessage { to: "a7c2…", message: "Now fix it.", summary: "…" }       ← the agent's own call
system/task_started  { task_id: "a7c2…", tool_use_id: <the SendMessage call>, task_type: "local_agent",
                       is_backgrounded: true, description: <its description>, prompt: "Now fix it." }
user  tool_result for the SendMessage call: "Resuming agent a7c2…"
      tool_use_result: { success: true, message: "Resuming agent a7c2…", resumedAgentId: "a7c2…" }
assistant  { parent_tool_use_id: <its original Agent call> } …                  ← its new run, as any background subagent's
system/task_progress      { task_id: "a7c2…", tool_use_id: <the SendMessage call>, … }
system/task_updated       { task_id: "a7c2…", patch: { status: "completed", … } }
system/task_notification  { task_id: "a7c2…", tool_use_id: <the SendMessage call>, status: "completed", summary: … }
```

- **`task_id` is the subagent's old id** (its `agentId`, the one its first `task_started` and its `Agent` call's
  `tool_use_result.agentId` named). `SendMessage` to a subagent that has stopped calls `resumeAgentForReply`, which
  registers the task again under that id (`isBackgrounded: true`: "A resumed subagent is always registered in the
  background", in `sdk.d.ts`), and registering a task emits `task_started`.
- **Its `tool_use_id` is the waking call's**, not the `Agent` call's: the new task takes the `toolUseId` of the
  `SendMessage` call that runs it (`toolUseContext.toolUseId`), and `task_progress` and `task_notification` carry the
  task's `toolUseId`. So the run's progress and end name the `SendMessage` call.
- **Its messages still carry its `Agent` call** as `parent_tool_use_id`: the run takes the id from the subagent's saved
  metadata, written when it was first spawned.
- **The SDK starting it again itself** (after work it left running ends, "Background work inside a subagent" below)
  sends the same `task_started`, under the `Agent` call's own id, as no call woke it.
- **A subagent still running** isn't woken: `SendMessage` queues the message for its next tool round ("Message queued
  for delivery to … at its next tool round."), and no `task_started` comes.
- **It survives a relaunch**: the subagent's transcript and metadata are on disk, so a resumed session's `SendMessage`
  wakes it the same way. A subagent stopped by the user isn't woken.

**Implications for Glade (#395)**

- An `Agent` call keeps its subagent's SDK task id in SQLite (`tool_events.sdk_task_id`, migration 47) from its first
  `task_started`. A later `task_started` (`local_agent`) under that id, or under its own `Agent` call once it has
  ended, wakes it: its row goes back to running, with no outcome, end time or summary, and keeps its log, and it's
  followed as a background subagent from then on, its calls and notes logged with its `Agent` call's turn. Its
  progress summaries and its end, under the waking call, go to its `Agent` call's row: done or failed, as for any
  background subagent. Stop subagent stops it by the same task id. If the app quits while it runs, the next launch
  interrupts it, as any background subagent; the agent can wake it again after that.
- A subagent started before Glade kept the ids (migration 47) is known by its new run's first message instead: the
  `Agent` call that message names, if it has ended, is the one a pending `SendMessage` woke.
- The Subagents tab, the task list's count, and the plugin feed all read the `Agent` call's row, so they follow: a
  plugin is sent `subagent.started` again for it, and a task whose log isn't loaded yet gets the row, to count it.

### Background work inside a subagent [verified]

Probed on SDK 0.3.281 with Haiku (#291), in a throwaway folder: the agent ran `sleep 3` in the foreground, then started
one background subagent that ran, with `Bash`: a 6-second command in the background, a 4-second one in the foreground,
a 40-second one in the background, an 8-second one in the foreground, and then replied and ended without waiting.
Timings are seconds from the first message:

```
 4.7  assistant  tool_use Bash "sleep 3; echo top-fg"                           ← the agent's own, in the foreground
 7.9  system/task_started  { task_id: "bnaq…", tool_use_id: <that call>, task_type: "local_bash", is_backgrounded: false }
 8.0  system/task_notification  { task_id: "bnaq…", status: "completed", summary: "top fg" }
 8.0  user  tool_result "top-fg"
11.8  … the Agent call, run_in_background: true, and its task_started (local_agent) and "launched" result
12.8  result/success                                                             ← the agent's turn ends
13.8  assistant  { parent_tool_use_id: <Agent call> } tool_use Bash { run_in_background: true, description: "bg alpha" }
13.8  system/task_started  { task_id: "bfss…", tool_use_id: <that call>, task_type: "local_bash", is_backgrounded: true,
                             owned_by_subagent: true }
13.8  user  { parent_tool_use_id: <Agent call> } tool_result "Command running in background with ID: bfss…"  (no tool_use_result)
15.2  assistant  { parent_tool_use_id: <Agent call> } tool_use Bash "sleep 4; echo fg-beta"
18.3  system/task_started  { task_id: "b7cf…", task_type: "local_bash", is_backgrounded: false, owned_by_subagent: true }
19.3  system/task_notification  { task_id: "b7cf…", status: "completed", summary: "fg beta" }
19.3  user  { parent_tool_use_id: <Agent call> } tool_result "fg-beta"
19.9  system/task_updated  { task_id: "bfss…", patch: { status: "completed" } }
19.9  system/task_notification  { task_id: "bfss…", tool_use_id: <bg alpha>, status: "completed",
                                  summary: "Background command \"bg alpha\" completed (exit code 0)" }
20.6  … "bg gamma" (sleep 40) starts in the background the same way; "fg wait" (sleep 8) runs in the foreground
31.7  system/task_notification  { task_id: <subagent>, status: "completed", summary: "sub done" }   ← the subagent ends
31.8  a turn of the agent's own (the subagent's end): "…This agent stopped with background work of its own still
      running. It may resume on its own when that work completes…"
60.7  system/task_notification  { task_id: <bg gamma>, tool_use_id: <bg gamma>, status: "completed", … }
60.7  system/task_started  { task_id: <subagent>, tool_use_id: <Agent call>, task_type: "local_agent", is_backgrounded: true }
62.7  assistant  { parent_tool_use_id: <Agent call> } [text] "Acknowledged. The background gamma task has completed…"
62.7  system/task_notification  { task_id: <subagent>, status: "completed", … }   ← it ends again, and wakes the agent
```

- **A foreground `Bash` call gets a task too**, once it has run about three seconds: `task_started` with
  `is_backgrounded: false`, then its `task_notification` just before the call's result. It's the call itself, which the
  turn waits on, not something left running. The agent's own calls do this as well as a subagent's.
- **A subagent's background command is reported to the task's session**, as the agent's own is: `task_started`
  (`is_backgrounded: true`, `owned_by_subagent: true`, and the call's `tool_use_id`, whose `tool_use` carries the
  subagent's `parent_tool_use_id`), and its `task_updated` and `task_notification` when it ends. Its call's result has
  no `tool_use_result`. Its end wakes the subagent, not the agent: no `<task-notification>` prompt of the agent's.
- **It outlives its subagent.** A subagent that finishes with work still running is only paused: the SDK keeps the work
  running, reports its end as above, then starts the subagent again (a second `task_started` for its `Agent` call),
  which ends again with a second `task_notification`.
- A foreground call that runs past its timeout is moved to the background (from the SDK's types and binary, not seen):
  `task_updated` with `patch.is_backgrounded: true`, and a result saying `Command did not complete within its …
  timeout and was moved to the background (ID: …)`. From then on it's a background command.

**Implications for Glade (#291)**

- A monitor or command belongs to whoever's call started it: the task's own agent, or the subagent whose `Agent` call is
  its call's `parent_tool_use_id`. The Watchers tab and every watcher count show only the task's own; a subagent's are
  under it in the Subagents tab.
- Only a backgrounded task (`is_backgrounded`, or a call with `run_in_background`) is a watcher. A foreground `Bash`
  call's task is a tool call; it becomes a watcher only if the SDK moves it to the background. Before #291 every
  foreground call over three seconds became a command watcher, and the ones whose `task_notification` never came stayed
  "running"; migration 36 deletes those rows.
- A subagent's watchers end as the task's own do, by their `task_notification`, even after the subagent has finished.
  A subagent that's stopped takes its live monitors and commands, and its nested subagents', with it: they end as
  "Ended with its subagent.", and the runner stops their tasks (not probed whether the SDK stops them itself).

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
    `max_output_tokens`, and more (`SDKAssistantMessageError`). A lost login (`authentication_failed` and its words)
    is its own kind: see §1, "Logged out".
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
  - A probe on SDK 0.3.281 (#281), invented values:
    `{ "status": "allowed_warning", "resetsAt": 1790920800, "rateLimitType": "seven_day", "utilization": 0.28,
    "isUsingOverage": false, "unifiedWindows": { "five_hour": { "utilization": 0.36, "resetsAt": … },
    "seven_day": { "utilization": 0.28, "resetsAt": … } } }`. `utilization` is a fraction of the `rateLimitType`
    window; `unifiedWindows` isn't in the SDK's types.
  - `allowed_warning` can come early: 28% of a week, above. Claude Code shows its own warning ("You've used 85% of
    your session limit · resets 2pm") only from 70% (`utilization` ≥ 0.7, or none given), so the usage meter turns
    purple only from there too (#327, `docs/design/html/32-usage-meter.html`). An event names one window
    (`rateLimitType`: `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `seven_day_overage_included`,
    `overage`), arrives as each turn starts, and mostly carries `utilization` only once it warns.
  - **Decision (#327, approved by Jared):** Glade reads the experimental
    `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })` (a `get_usage` control
    request on the `Query`; it needs a running session) as each session starts and after each turn, for the sidebar's
    usage meter. It answers `SDKControlGetUsageResponse`: `rate_limits_available` (false for an API key, a cloud
    provider or a login without the profile scope), and `rate_limits` with `five_hour`, `seven_day`,
    `seven_day_oauth_apps`, `seven_day_opus` and `seven_day_sonnet` (each `{ utilization: 0–100, resets_at: ISO 8601 }`
    or null), `model_scoped` (per-model weekly windows the server names, `display_name`) and `extra_usage`
    (`is_enabled`, `monthly_limit`, `used_credits`, `utilization`). `skipBehaviors` skips a scan of a week of local
    transcripts, which the meter doesn't need. Because it's experimental, `src/main/account/account.ts` parses it
    loosely at the boundary (a malformed window is left out; an answer of another shape, or with no window in it, is
    ignored), and anything that goes wrong (the method missing, a rejection, an unexpected answer) falls back to the
    rate limit events. Glade leaves out `seven_day_oauth_apps` and `seven_day_overage_included` (not shown by the
    meter: unclear what they count), and shows extra usage only as a percentage, not in money. Not yet probed live.
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
- **[docs] Startup failures with a reason (#280):** with `CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1` in the session's
  environment, a start that fails for a known reason first writes a zeroed `error_during_execution` result carrying
  `startup_failure_reason` (`SDKStartupFailureReason`: `cwd_unavailable`, `shell_tool_missing`, `proxy_invalid`,
  `temp_dir_unusable`, the `org_*`, `gateway_*` and `worktree_*` checks, `managed_settings_invalid`,
  `remote_settings_required_unavailable`, `session_held_by_background`, `cli_version_too_old`, `bypass_root`), with
  `errors` holding the same text as stderr; then the process exits. A failure with no known cause still ends with the
  process alone. From `sdk.d.ts` only: not probed, since a live start failing would need a broken environment.
  - **Decided:** Glade sets the variable (`SESSION_ENV`). The runner stops the task on such a result with a `startup`
    error whose code is the reason; the card words each reason (`src/shared/startupFailure.ts`), naming one it doesn't
    know as the SDK gives it, and **Show details** shows the `errors` text. The process exiting afterwards changes
    nothing, as the turn has already ended.
- **[docs] Diagnostics (#280):** the `stderr` option hears the Claude process's error output; Glade logs it to the
  task's log, rate-limited (`src/main/agent/stderr-log.ts`, `docs/logs.md`). `CLAUDE_AGENT_SDK_CLIENT_APP` names the
  host in the User-Agent: Glade sets `glade/<version>`.

### Safety refusals (#364)

- **[docs] `system/model_refusal_fallback`:** emitted when the primary model ends its stream with `stop_reason:
  "refusal"` (Opus 5.5 and Sonnet 5's safety classifiers, cyber/bio/reasoning-extraction) and the request is retried
  once on a fallback model, which answers. Carries `trigger: "refusal"`, `direction` (only `"retry"` is still
  emitted; `"revert"` and `"sticky"` are kept in the enum for SDK-consumer compat), `scope` (`"session"`: the main
  thread fell back and the session model is swapped from here on; `"local"`: only a subagent or side question
  (`/btw`) fell back, the session model is unchanged; absent on an older CLI reads as `"session"`), `original_model`,
  `fallback_model`, `api_refusal_category` (an open string, e.g. `cyber`, `bio`; null when neither lane carried one),
  `api_refusal_explanation` (client-lane only, display only, never parse), `retracted_message_uuids` (the refused
  leg's messages this fallback retracted — the complete audit record for the turn) and `refused_user_message_uuid`
  (for edit-and-retry; Glade doesn't offer that yet). Not probed live: from `sdk.d.ts` only.
  - **Superseding messages:** each of the retry's own `assistant` messages carries its own `supersedes: string[]`
    (wire uuids of previously-delivered messages it replaces — one uuid per normalized SDK message, so a
    multi-block turn's blocks each have their own), idempotent with the notice's `retracted_message_uuids`: evict on
    either arrival, whichever comes first.
  - **Decided:** parsed loosely (`src/main/agent/events.ts`): `AgentEventKind.ModelRefusalFallback` (only for
    `direction: "retry"`) and `AgentEventKind.MessagesEvicted` (from an assistant message's `supersedes`). The
    runner (`src/main/agent/runner.ts`) evicts the refused leg's narration and tool call rows the retry names (a
    real `DELETE`, so a relaunch never brings them back — not yet-flushed preamble is dropped from memory, matched
    by the SDK uuid its text block arrived on; a coalesced flush that merged several blocks is evicted whole if any
    contributor is named, since Glade doesn't keep per-block granularity once flushed), logs a quiet notice row
    (`ToolEventKind.RefusalFallback`, shown in the chat only, not the tool call panel: "Answered by
    `<fallback_model>`: the request was declined by a safety check (`<category>`)."), and, with `scope: "session"`,
    switches the task's own model to the fallback's (effort follows, as the model picker's own change does).
- **[docs] `system/model_refusal_no_fallback`:** emitted when the refusal has no fallback to retry on: no fallback
  model configured, or per-category routing declined the retry. Carries `original_model`, `api_refusal_category`,
  `api_refusal_explanation`, `refused_user_message_uuid` and `content`. The turn still ends with a normal `result`.
  Not probed live: from `sdk.d.ts` only.
  - **Decided:** parsed as `AgentEventKind.ModelRefusalNoFallback`, kept on the turn until its `result` arrives, then
    (overriding the usual error handling, whatever the result's own `is_error` and `terminal_reason` say) the task
    stops on a `TaskError` of its own kind (`AgentErrorKind.SafetyRefusal`, `TaskErrorSource.Refusal`; `code` is the
    category, `details` the explanation or `content`): the chat's declined card, in the error card's style, and the
    Needs you reason "Declined by a safety check" — not "Stopped on an error", so it never reads as a crash. Retry
    and Retry with another model both work as they do for any other error (edit-and-retry composer prefill isn't
    built: out of scope for #364).

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
- **Blocking works.** The `ask` handler awaited a promise for 1.5s, and the turn simply waited.
- **But not forever: every call has a timeout, about 28 hours by default [verified, #381].** The types say calls are
  bounded by `createSdkMcpServer({ timeout })` or the `MCP_TOOL_TIMEOUT` env var, and are "effectively unbounded by
  default" [docs]. They aren't: a real `ask` left overnight and through the next day failed with
  `MCP server "glade" tool "ask" timed out after 100000s`. From the bundled Claude Code binary (2.1.283), each MCP
  call's bound is:
  - the server's own `timeout` in ms, if it's at least 1000; else `MCP_TOOL_TIMEOUT`; else **100,000,000 ms**
    (100,000 s, about 27.8 hours);
  - clamped to at most **2,147,483,647 ms** (2^31 − 1, about 24.8 days), the longest a timer can wait. There's no
    "never": a value under 1000, 0 included, falls back to the default.
  - It's a hard wall-clock limit: progress notifications don't extend it. It races the call, and the MCP client's own
    request timeout, set to the same value, cancels the call too, so the handler's signal aborts (from the binary, and
    Glade's tests against the MCP SDK's client; not seen live).
  - `timeout` is per server, not per tool. The SDK sends an in-process server's `timeout` to Claude Code in its
    `initialize` request (`sdkMcpServerConfigs`); changing it for a server already registered is ignored until it's
    removed and re-added.
  - The separate idle timeout (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`, which aborts a call that sends nothing for 30
    minutes on stdio) doesn't apply to `sdk` servers. Nor does MCP auto-backgrounding, which is off in a
    non-interactive (SDK) session unless `CLAUDE_AUTO_BACKGROUND_TASKS` is set.
- `tool()` accepts Zod 3 or Zod 4 shapes. We used zod 4.
- Source: [Custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools), `sdk.d.ts` (`createSdkMcpServer`,
  `tool`), and the strings of the bundled binary for the timeout.

**Implications for Glade**

- Always set `alwaysLoad: true`. Hide `ToolSearch` calls from the tool log, or show them quietly, since the user's own
  MCP tools may still be deferred.
- `ask` is a plain awaiting handler, with no timer of its own. Keep the pending question in SQLite so it survives a
  crash.
- **The `glade` server sets `timeout` to 2^31 − 1 ms** (`GLADE_TOOL_TIMEOUT_MS`, #381), the longest Claude Code
  allows, so `ask` waits about 24.8 days before Claude Code fails it. Only that server: `glade-control` and the user's
  own servers keep the default. Glade doesn't set `MCP_TOOL_TIMEOUT`, which would lift the bound for every server, the
  user's own included (a user who sets it in their shell still gets it, and the `glade` server's own `timeout` still
  wins). The trade-off is that it covers every `glade` tool, not just `ask`; the others all return at once, so a hung
  one would only be a bug in Glade's own handler.
- The scripted agents' tool caller (`src/main/agent/mcp-tool-caller.ts`, for the fake backend and e2e) bounds each
  call the same way (`toolTimeoutMs`), so tests see the timeout a real session would.
- **At the bound**, about 24.8 days in, Claude Code fails the call with a timeout error and cancels it: the handler's
  signal aborts, the card is withdrawn, and the agent carries on its turn with the error.
- **A relaunch lifts the bound.** If Glade quits while `ask` waits, the call ends (the session's process is gone), but
  its question stays open in SQLite with no timer on it at all. Answering it resumes the session and hands the agent
  the answer as a message (the runner's `answeredAfterRestart`, P4), so a question the app quit on waits however long
  you take.
- Tool handlers run in the main process, so they must never block the event loop synchronously.

## 4. Per-turn settings: model and effort [verified]

- **Model:** `await q.setModel("sonnet")` before pushing the next message. The next turn's `init.model` changed
  (haiku → `claude-sonnet-5`) and back again. `setModel` also emits a `user` message containing
  `<local-command-stdout>Set model to …</local-command-stdout>`, which Glade should filter out of the chat.
- **Effort:** set it at start with the `effort` option, and change it mid-session with
  `await q.applyFlagSettings({ effortLevel: "low" })` (`null` resets it). We verified this through the `PreToolUse`
  hook input `effort.level`, which went `medium` → `low` between turns. Haiku 4.5 reports no effort (the field was
  absent).
- **What the pickers offer [verified]:** `q.supportedModels()` / `initializationResult().models` list each model with
  `supportsEffort`, `supportedEffortLevels` (`low|medium|high|xhigh|max`), `supportsAdaptiveThinking` and
  `displayName`. Glade builds its pickers from this list (#277).

  A probe (SDK 0.3.281, streaming input, no message sent, so no tokens spent) got the same list from both calls, as
  soon as the process had started. Each entry, trimmed:

  ```json
  { "value": "sonnet", "resolvedModel": "claude-sonnet-5", "displayName": "Sonnet",
    "description": "Sonnet 5 · Efficient for routine tasks", "supportsEffort": true,
    "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"],
    "supportsAdaptiveThinking": true, "supportsAutoMode": true }
  ```

  - `value` is what `model` and `setModel` take: mostly **aliases** (`default`, `opus[1m]`, `sonnet`, `haiku`), some
    full ids. `resolvedModel` is the full id it stands for (`claude-haiku-4-5-20251001`, dated), so a task saved with
    `claude-sonnet-5` matches the `sonnet` row by it. Two rows can resolve to the same model (`default` and
    `opus[1m]` were both `claude-opus-5-5[1m]`).
  - `displayName` is short (`Default (recommended)`, `Sonnet`); the version is in `description`.
  - **Haiku leaves both effort fields out**: no effort at all. Opus and Sonnet listed all five levels, `xhigh`
    included.
  - The list depends on the login: it had a model only some accounts get.
  - No field names a model's default effort. Glade uses High where the model has it, else its lowest level.

  Glade reads `initializationResult().models` (it's cached; `supportedModels()` asks again) once each session's process
  has started, keeps it in SQLite (`sdk_models`), and offers the built-in list until the first session reports one.
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

**Probed again (#279) [verified]**, SDK 0.3.281 on Haiku, in a throwaway folder: `getContextUsage({ detail: "summary" })`
before the first message, after each turn and after a `/compact`, with the user's settings changed per run, and the
compaction hooks registered.

```
default                            { maxTokens: 200000, autoCompactThreshold: 167000, isAutoCompactEnabled: true,  autocompactSource: "auto" }
settings { autoCompactWindow: 100000 }   { maxTokens: 100000, autoCompactThreshold: 67000,  isAutoCompactEnabled: true,  autocompactSource: "settings" }
CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000  { maxTokens: 100000, autoCompactThreshold: 67000,  isAutoCompactEnabled: true,  autocompactSource: "env" }
settings { autoCompactEnabled: false }  { maxTokens: 200000, isAutoCompactEnabled: false }        ← no autoCompactThreshold key
DISABLE_AUTO_COMPACT=1             { maxTokens: 200000, isAutoCompactEnabled: false }            ← no autoCompactThreshold key
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50 { autoCompactThreshold: 167000, autocompactSource: "auto" }   ← no change on this version
settings { autoCompactWindow: 40000 }    { autoCompactThreshold: 167000 }                         ← too small: ignored
```

- It answers before the first message (before `system/init`), and each call on the `summary` detail took no time.
  After `close()` it rejects: `Query closed before response received`.
- The threshold is in tokens, against the window the SDK compacts in (`maxTokens`), which `autoCompactWindow` shrinks;
  the model's own window (`modelUsage[model].contextWindow`, 200k) is unchanged. `rawMaxTokens` is the same number as
  `maxTokens`, not the model's window (#416). So the meter keeps its window and
  puts the threshold at `autoCompactThreshold / window`: 67k of 200k is 34%.
- `totalTokens` is stale right after a compaction (23.6k just after `/compact` left 1.7k), so it's used for nothing.
- `PostCompact` fired after `PreCompact` and before `status: null` / `compact_boundary`, with
  `{ hook_event_name: "PostCompact", trigger: "manual", compact_summary }`. `compact_summary` is the model's whole
  output: an `<analysis>…</analysis>` block, then `<summary>…</summary>` with numbered sections (1–2.8k characters in
  these runs). The user message the session carries on from ("This session is being continued … Summary: …") is the
  summary block alone. An automatic compaction wasn't probed (it needs 167k of context); the SDK's types give it the
  same hook with `trigger: "auto"`.

**Implications for Glade (#279)**

- After each turn's `result`, the runner asks `getContextUsage({ detail: "summary" })` and keeps where the SDK
  compacts on the task (`auto_compact`: on at a threshold, or off). A rejected call, or an answer without the fields,
  keeps the last known value; before the SDK has said (a new task, or a change to a model with another window), the
  meter falls back to `autoCompactThreshold()` in `shared/contextWindow.ts`, the SDK's default.
- The meter's marker, its note and its purple zone follow that threshold. With auto-compact off there's no marker, the
  note says so, and the ring never turns purple.
- Glade registers `PostCompact` and keeps the summary block (the whole text less any `<analysis>`, if there's no
  block) on the Compact row, which opens to it. An empty one is kept as none. It's stored with the row, so it's there
  after a relaunch.

**Decided (Jared):** Glade uses the SDK's default auto-compact threshold. Manual compaction (`/compact`) is triggered
from the context meter or ⌘⇧K. A custom threshold is deferred to Later. If it is revisited: the setting can only lower
the threshold, and disabling SDK auto-compaction so Glade compacts at a higher level risks the summarising request
itself hitting prompt-too-long.

The context meter shows `autoCompactThreshold` from `getContextUsage()` (#279, above).

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
- Background subagents get killed on interrupt unless `perTaskStopAffordance: true` [verified, below].
- `q.close()` kills the subprocess outright. Use it to shut a task down, not to stop a turn.
- Watch out: the Bash tool itself refuses a standalone `sleep N` and may push long commands into the background, where
  they then report through `task_*` events [verified].

**Implication:** the Stop button maps to `interrupt()`. Record the aborted partial text (`aborted: true`) in the tool
log or as a truncated reply, and show the turn as stopped rather than failed (`terminal_reason` `aborted_*`).

### What an interrupt leaves running [verified]

Probed for #276 on SDK 0.3.281 (Claude Code 2.1.281), with Haiku in a throwaway folder, streaming input mode and
`bypassPermissions`, once without `perTaskStopAffordance` and once with it. One turn started a `Bash` with
`run_in_background` (`sleep 90 && …`), an `Agent` with `run_in_background` (a subagent making ten foreground
`sleep 6 && echo N` calls, one after another) and a `Monitor` (a tick every 20 s), and replied "launched". The next
turn was interrupted as it started streaming text, with all three still running. Seconds from the start:

```
without perTaskStopAffordance
19.3  interrupt()  → { still_queued: [] }
19.3  system/background_tasks_changed  { tasks: ["bg sleeper", "ticker"] }       ← the subagent gone
19.3  system/task_updated       { task_id: "ad11…", patch: { status: "killed" } }
19.3  system/task_notification  { task_id: "ad11…", status: "stopped", summary: "Slow sub" }
19.3  result/error_during_execution  { terminal_reason: "aborted_streaming" }
27.3  (8 s on) still running: the background Bash and the Monitor; stopTask then stopped each

with perTaskStopAffordance: true
17.9  interrupt()  → { still_queued: [] }
17.9  result/error_during_execution  { terminal_reason: "aborted_streaming" }    ← nothing else
20.8  system/task_started  { task_type: "local_bash", owned_by_subagent: true }  ← the subagent's next call
25.9  (8 s on) still running: all three; stopTask then stopped each, as usual
```

- **Without the declaration, an interrupt kills every running background subagent**, with the turn: `task_updated`
  `killed` and a `stopped` `task_notification` whose summary is its description, as `stopTask` gives (no wake turn
  followed it). A background command a subagent had started (`owned_by_subagent`) was killed too, in an earlier run
  where its subagent had already ended.
- The session's own background `Bash` and `Monitor` survived the interrupt either way, as §11 saw.
- **With `perTaskStopAffordance: true`, the interrupt ends only the turn.** Every background task carried on (the
  subagent made its next call three seconds later), and `stopTask` still stopped each one.

**Decided (#276):** Glade passes `perTaskStopAffordance: true` (`sdkOptions` in `src/main/agent/sdk-backend.ts`): it
has a Stop of its own for each background subagent and watcher (the Subagents and Watchers tabs, which call
`stopTask`), so Stop on a turn stops only the turn. The scripted backend models both behaviours from the options Glade
passes (`interruptStopsSubagents` in `src/main/agent/scripted-session.ts`).

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
  next message it sends it (`src/main/agent/session-context.ts`): Glade's whole prompt for an imported session, the
  lines added to the prompt since the session started (`INSTRUCTION_UPDATES`, #301), and a task's handoff note when
  the session started without it, or with an older one. What each session has had is kept in SQLite
  (`session_context`).

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
  (`mcp__glade`, a server-wide rule [docs]) so their tools never ask (`src/main/agent/sdk-backend.ts`). That's with
  the agent sandbox off, as it is by default until P15 is finished; with it on, Allow all runs as `'acceptEdits'` and the session can't
  switch into bypassing (§15, "What Glade does").
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
- **A subagent's call to one of Glade's own tools (`glade`, `glade-control`) is refused before `canUseTool` runs
  [docs]**, not decided by it: `glade`'s tools are pre-approved in `allowedTools`, a server-wide rule Claude Code lets
  through without asking at all, and `bypassPermissions` skips `canUseTool` for every tool, `glade-control`'s included,
  so neither mode leaves a hook for `canUseTool` to catch a subagent's call in. Instead a `PreToolUse` hook with no
  matcher (`subagentGladeToolGuard`, `src/main/agent/sdk-backend.ts`) reads `agent_id` (set only for a subagent's call,
  `BaseHookInput.agent_id`) and `mcp_server` (`source: 'sdk'` and a name Glade registered, never trusting a configured
  server of the same name) off every `PreToolUse` input, and denies with `hookSpecificOutput: { hookEventName:
  'PreToolUse', permissionDecision: 'deny', permissionDecisionReason }` before the tool ever dispatches (#366). Not
  probed against a live session: built from `sdk.d.ts` and tested against the real `glade` MCP server, simulating the
  SDK's documented dispatch order, since the scripted test backend has no SDK hooks to exercise
  (`src/main/agent/subagent-tool-guard.test.ts`).

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

## 14. Commits: what a task's `Bash` calls committed [not probed]

For the Changes tab (#275). Not probed against a live session: built from the SDK's hook types (`sdk.d.ts`, SDK
0.3.281) and git's own output, and tested end to end with the scripted agent making real commits
(`ScriptStepKind.Shell`, `e2e/changes.spec.ts`).

**The hook.** A `PreToolUse` hook with the matcher `Bash` is called before each `Bash` call runs, the session's and a
subagent's, and the call waits for its callback to resolve. Its input has `tool_use_id` (the `tool_use` block's id,
which the call's result pairs with), `tool_input.command`, and `cwd`, the folder the command runs in; a subagent's has
`agent_id` too. Glade's callback waits at most 5 s (`BASH_HOOK_TIMEOUT_MS`), and answers `{}`: it never decides a call.

**What Glade reads, and when.** Before the call: for its `cwd` and each folder the command `cd`s to or runs `git -C`
in, the repository (`git rev-parse --path-format=absolute --show-toplevel --git-dir --git-common-dir`), and its working
tree's `HEAD` and reflog length (`git rev-list --walk-reflogs --count HEAD`). After the call's result: the reflog
entries added meanwhile (`git log -g -n<N> --format=%H%x1f%gs%x1f%gd --date=unix HEAD`). An entry whose message starts
`commit: `, `commit (initial|amend|merge): `, `cherry-pick`, `revert`, or is a `merge`/`pull` that says `Merge made by`
made a commit; `checkout: moving from …`, `reset: moving to …` and `Fast-forward` moved `HEAD` to one that was there.
An amend's entry follows the commit it replaced. `git commit` also prints the commit it made, `[main a1b2c3d] Fix the
test` (`[main (root-commit) …]`, `[detached HEAD …]`), which is resolved in the call's repositories.

**What's read later.** A commit's row (`git log --no-walk=unsorted --shortstat -M --diff-merges=first-parent`) is kept
in SQLite; its files (`git show --format= -z --raw --numstat -M --diff-merges=first-parent`) and a file as it left it
(`git cat-file blob <hash>:<path>`) are read through the common git dir (`--git-dir`), which outlives a removed
worktree. Every read runs with `GIT_OPTIONAL_LOCKS=0`, `core.quotepath=off` and no colour, pager or signatures.

**Not seen.** A commit made by a command left running in the background (`run_in_background`), which returns before it
commits, or by a script in a folder the command doesn't name. A rebase's rewritten commits aren't counted as made.
Unconfirmed: that a subagent isolated in a worktree gets its worktree as the hook's `cwd`; a command that `cd`s into
it is covered either way.

## 15. Sandbox

What the agent sandbox (P15, #445) relies on, probed for P15-01 (#446). SDK 0.3.283 (Claude Code 2.1.283), macOS
arm64, October 2026: about twenty scratch `query()`s, all on `haiku` but one on `sonnet` (for effort), in streaming
input mode with `settingSources: []` (one `['project']`, to load a `.mcp.json`), a `canUseTool` that logged every call,
and `PostToolUse` and `PostToolUseFailure` hooks on `Bash`. The probe folders sat under the home folder, as a workspace
usually does: the workspace `/Users/me/probe/ws` (the `cwd`), and siblings `/Users/me/probe/outside`,
`/Users/me/probe/outside2` and `/Users/me/probe/rw` standing in for folders the agent isn't granted, with dummy
credential files of their own. Unless a point says otherwise, the session ran in `acceptEdits` with:

```js
sandbox: {
  enabled: true, // failIfUnavailable then defaults to true
  autoAllowBashIfSandboxed: true,
  filesystem: { denyRead: ['~', '/Users', '/Volumes'], allowRead: ['/Users/me/probe/ws'], allowWrite: ['/Users/me/probe/ws'] },
}
```

Where a probe left a question, the bundled CLI's own code (strings in the binary) answered it; those points say so.

### What this changes in #445 [verified]

Each is explained, with its evidence, below.

1. **No `<sandbox_violations>` block for a blocked file read or write.** Claude Code only annotates a result with the
   file denials its own log monitor saw, and an SDK session never starts that monitor. The block appears for network
   denials only. **Alternative:** Glade reads Seatbelt's denials itself, from the system log (`log stream`), where each
   one names the `Bash` call it belongs to. See "A command's blocked read or write".
2. **`PostToolUse` doesn't fire for a `Bash` call that fails.** Most blocked commands exit non-zero, and those get a
   `PostToolUseFailure` hook instead, which can hold the turn and add context the same way. **Glade hooks both**, each
   with a long `timeout`: without one, Claude Code stops waiting on a hook after 10 minutes.
3. **`applyFlagSettings` can't narrow what the session started with.** The `sandbox` and `settings` lists given at
   start stay in force: a later `applyFlagSettings` adds to them, and replacing it only takes back what an earlier
   `applyFlagSettings` added. **Alternative:** start each session with only what can never be revoked (the workspace
   root, the read denies, the credential denies, the override ask rule), and apply the grants with `applyFlagSettings`
   straight after start, before the first message, and again on every change.
4. **Domain rules in `allowedTools` don't reach commands.** `WebFetch(domain:…)` rules widen the sandbox's network
   allowlist only from settings (`settings.permissions.allow`, or `applyFlagSettings({ permissions })`). P11's task
   rules stay in `allowedTools`; domain grants go in the flag settings.
5. **A file-tool ask has no `blockedPath`.** The path is the call's own input (`file_path`), and `decisionReason` is
   `"Path is outside allowed working directories"`. `blockedPath` comes with a `Bash` call's path check only.
6. **A sandbox that can't start doesn't stop the session.** It starts and answers as usual; each `Bash` call then fails
   with `Sandbox is required but failed to initialize: <why>. Restart to retry.`, and the agent goes on to ask to run
   the command outside the sandbox. **Glade has to spot that error** (in `PostToolUseFailure`, or the result) to show
   the task's error, and must keep denying the override that follows.
7. **The sandbox override's reason isn't `sandboxOverride`.** `canUseTool` says `decisionReason:
   "dangerouslyDisableSandbox"` (or nothing, when an allow rule also matched): Glade tells the request apart by the
   call's input, `dangerouslyDisableSandbox: true`.

Smaller things later issues need to know:

- **Reads outside the home folder ask too** (`/etc/hosts`, in `acceptEdits`): the file tools have no notion of "outside
  the home folder", so Glade's classifier must let those reads through itself, as #445 says.
- **`Grep` and `Glob` aren't tools** in an SDK session of this version (`system/init` lists neither; a model that
  looked for them with `ToolSearch` found nothing). Searches run through `Bash`, inside the sandbox.
- **Denying `~` hides the user's shell setup from commands.** Every sandboxed command's shell failed to read
  `~/.zshenv` and Claude Code's own shell snapshot (`~/.claude/shell-snapshots/snapshot-zsh-….sh`). The commands
  still ran, with Glade's `PATH`, but without the user's aliases and functions. Granting
  `~/.claude/shell-snapshots` read-only should bring the snapshot back (not probed).

### Reads and writes: `denyRead` with `allowRead` [verified]

- **`denyRead: ['~']` with `allowRead` of a workspace under `~` works.** `cat` and writes inside the workspace went
  through; `cat` of a sibling folder failed with `Operation not permitted`, and so did a write there.
- **`/Users` and `/Volumes` are denied the same way:** `ls /Users` and `ls /Volumes` failed with `Operation not
  permitted`, while `head /etc/hosts`, `ls /usr/bin` and `ls /opt/homebrew` worked.
- **Writes outside `allowWrite` are blocked, `/tmp` included** (`echo hi > /tmp/x` failed). Claude Code's own temp
  folders stay writable (docs).
- **A credential folder stays unreadable inside a granted one:** with `allowRead` naming `/Users/me/probe/outside`
  and `credentials.files: [{ path: '/Users/me/probe/outside/.ssh', mode: 'deny' }]`, `cat outside/secret.txt` worked and
  `cat outside/.ssh/id_dummy` failed.
- **Seatbelt never asks.** A sandboxed command (auto-allowed by `autoAllowBashIfSandboxed`) never reached `canUseTool`
  for a path; it ran, and the blocked read or write failed inside it.

### A command's blocked read or write [verified]

**The result.** A blocked `cat` or `mkdir` is an ordinary failure: the command's own error, with no
`<sandbox_violations>` block anywhere (the result, the hook inputs, the SDK's messages):

```jsonc
// tool_result, is_error: true (the PostToolUseFailure hook's `error` is the same text)
"Exit code 1\ncat: /Users/me/probe/outside/secret.txt: Operation not permitted"
"Exit code 1\n(eval):1: operation not permitted: /Users/me/probe/outside/new.txt" // a shell redirect
"Exit code 1\nmkdir: /Users/me/probe/outside2/newdir: Operation not permitted"
// a command that carries on after the blocked part exits 0: is_error false, and PostToolUse fires instead
"cat: /Users/me/probe/outside/secret.txt: Operation not permitted"
```

Neither the operation nor the path can be read off that reliably: not every tool prints the path, and none says
whether it was a read or a write.

**Why there's no block** (from the CLI's code): Claude Code appends `<sandbox_violations>` from a violation store
that its macOS log monitor fills, and the monitor only starts when the sandbox is initialised with it on. Claude Code
initialises it with only the config and the network-ask callback, so the store stays empty for files. The block that
does appear comes from the network proxy (below).

**Where the denials are: the system log.** Claude Code tags each sandboxed command's Seatbelt profile so its denials
are logged with a marker naming the call: `CMD64_<base64 of the tool_use id, first 100 characters>_END_<a random
per-process suffix ending in _SBX>`. Glade's own `log stream --predicate '(eventMessage ENDSWITH "_SBX")' --style
compact`, run by the host (no admin rights needed), saw every denial within a few milliseconds, before the call's
result came back. Each comes as two lines:

```text
2026-10-02 23:11:16.513 E  kernel[0:3f874aa] (Sandbox) Sandbox: cat(44794) deny(1) file-read-data /Users/me/probe/outside/secret.txt
CMD64_dG9vbHVfMDFLeDdRbTJWd1A5c0o0blI4dFliM0xj_END__k3j9x2abc_SBX
```

- The base64 decodes to the `tool_use` id (`toolu_01Kx7Qm2VwP9sJ4nR8tYb3Lc`), so a denial maps to its call exactly,
  even with several tasks running.
- The operations seen: `file-read-data` and `file-read-metadata` for a read, `file-write-create` (a new file or
  folder) and `file-write-unlink` (`rm`) for a write. A write is any `file-write-*`.
- Every command also logs noise to drop: `sysctl-read kern.iossupportversion`, `mach-lookup com.apple.diagnosticd`
  (Claude Code itself drops `mDNSResponder`, `diagnosticd` and `analyticsd` lookups), and the shell's own startup reads
  of `~/.zshenv` and the shell snapshot.
- **Best effort:** one write by a shell redirect left no log line in one run (the kernel limits how much it logs). The
  card can only follow the denials the log shows.
- **Undocumented:** the tag is Claude Code's internal format, not an SDK interface. Re-check it on each SDK bump.

This is the proposed replacement for the violation block: a host-side monitor feeding the `PostToolUse` /
`PostToolUseFailure` hook, which waits a moment for the call's denials before it decides whether to show a card.

### Holding the turn in a `Bash` hook [verified]

- **The hook that fires depends on the exit code:** `PostToolUse` (with `tool_response: { stdout, stderr, interrupted,
  isImage, noOutputExpected }`, stderr folded into stdout) for exit 0, `PostToolUseFailure` (with `error`, the same
  text as the result, and `is_interrupt: false`) otherwise. Both can return `additionalContext`.
- **The hook holds the turn,** with a `timeout` on its matcher. The `tool_result` streams only once the hook returns.
  A `PostToolUseFailure` hook held for 100 seconds with no `timeout` set, for 150 seconds with `timeout: 600`, and for
  11 minutes with `timeout: 86400`; each run carried on afterwards as usual, the hook's answer applied.
- **Without a `timeout`, Claude Code gives a hook callback 10 minutes.** Held for 11 minutes with none, the result went
  to the agent after exactly 600 seconds, without the hook's answer, and the answer that came later was ignored. Glade
  sets the longest a timer allows (`BASH_FINISHED_TIMEOUT_S`, about 24.8 days, `src/main/agent/sdk-backend.ts`).
- **`applyFlagSettings` works while the hook waits:** widening the sandbox from inside the held hook, then returning
  `additionalContext`, had the agent retry, and the retry read the file.
- **The context reaches the model.** The hook returned:

  ```js
  { hookSpecificOutput: { hookEventName: 'PostToolUseFailure',
      additionalContext: 'Glade: the user has now allowed this task to read and write the folder the command was blocked from. Run the same command again, once.' } }
  ```

  Haiku ran the same command again at once. With the sandbox not widened, the retry failed the same way and it gave up,
  saying the user had allowed it but the read still failed.

### File tools in `acceptEdits` [verified]

With `additionalDirectories: ['/Users/me/probe/rw']` and `allowedTools: ['Read(//Users/me/probe/outside2/**)']`:

| Call | Asked? |
| --- | --- |
| `Read` / `Edit` inside the workspace | no |
| `Read` / `Write` in `rw` (an additional directory) | no |
| `Read` in `outside2` (a `Read(//…/**)` rule) | no |
| `Write` in `outside2` | yes |
| `Read` / `Write` in `outside` | yes |
| `Read` of `outside/.ssh/id_dummy` | yes |
| `Read` of `/etc/hosts` | yes |

A read rule's path takes two slashes for an absolute path (`Read(//Users/me/…/**)`), as the suggestions show. What
`canUseTool` got (no `blockedPath`, no `title`, no `matchedAskRule`):

```jsonc
// Read /Users/me/probe/outside/secret.txt
{ "suggestions": [{ "type": "addRules", "rules": [{ "toolName": "Read", "ruleContent": "//Users/me/probe/outside/**" }],
                    "behavior": "allow", "destination": "session" }],
  "decisionReason": "Path is outside allowed working directories",
  "displayName": "Read", "description": "~/probe/outside/secret.txt", "toolUseID": "toolu_01…", "requestId": "c732d965-…" }
// Write /Users/me/probe/outside/by-write.txt (Edit and NotebookEdit weren't probed)
{ "suggestions": [{ "type": "addDirectories", "directories": ["/Users/me/probe/outside"], "destination": "session" }],
  "decisionReason": "Path is outside allowed working directories",
  "displayName": "Write", "description": "~/probe/outside/by-write.txt", "toolUseID": "toolu_01…", "requestId": "f2c4fad0-…" }
// Read /etc/hosts: a rule for both spellings of the folder
{ "suggestions": [{ "type": "addRules", "rules": [{ "toolName": "Read", "ruleContent": "//etc/**" }], "behavior": "allow", "destination": "session" },
                  { "type": "addRules", "rules": [{ "toolName": "Read", "ruleContent": "//private/etc/**" }], "behavior": "allow", "destination": "session" }],
  "decisionReason": "Path is outside allowed working directories", "displayName": "Read", "description": "/etc/hosts", … }
```

- **The folder a suggestion names is the file's own folder**, for a read (`Read(//<folder>/**)`) and a write
  (`addDirectories: [<folder>]`), already `session`-scoped. So "the agent wants to read `<folder>`" can come straight
  from the suggestion, or from `dirname(file_path)`.
- **`description`** abbreviates the home folder to `~`.

### Network: commands and `WebFetch` [verified]

**A command reaching an ungranted host** asks with a tool that isn't a model tool call, `SandboxNetworkAccess`, while
the connection waits: an answer held for 20 seconds, then allowed, let `curl` finish with `200`.

```jsonc
// canUseTool("SandboxNetworkAccess", input, options), during `curl https://www.example.org/`
{ "host": "www.example.org" }
{ "suggestions": [{ "type": "addRules", "rules": [{ "toolName": "WebFetch", "ruleContent": "domain:www.example.org" }],
                    "behavior": "allow", "destination": "localSettings" }],
  "displayName": "SandboxNetworkAccess", "description": "Allow network connection to www.example.org?",
  "toolUseID": "9d760934-dd51-…", // a fresh UUID: not the Bash call's tool_use id, and no agentID for the call
  "requestId": "c3810df8-…" }
```

- **The request doesn't name its `Bash` call.** Its `toolUseID` is a new UUID each time; the call it belongs to is the
  `Bash` call running at the time.
- **An allowed host stays allowed for the session:** the next command to the same host didn't ask.
- **A denied connection** fails the command, and its result (and `PostToolUseFailure`'s `error`) carries the one
  `<sandbox_violations>` block Claude Code writes in an SDK session:

  ```text
  Exit code 56
  curl: (56) CONNECT tunnel failed, response 403
  000
  <sandbox_violations>
  deny network-outbound www.example.org:443 (user denied)
  </sandbox_violations>
  ```

**`WebFetch` to an ungranted domain** asks as its own tool:

```jsonc
// canUseTool("WebFetch", { "url": "https://www.example.org/help/", "prompt": "…" }, options)
{ "suggestions": [{ "type": "addRules", "destination": "localSettings",
                    "rules": [{ "toolName": "WebFetch", "ruleContent": "domain:www.example.org" }], "behavior": "allow" }],
  "displayName": "WebFetch", "description": "https://www.example.org/help/", "toolUseID": "toolu_01…", "requestId": "889de9a8-…" }
```

Both suggest the same rule, `WebFetch(domain:<host>)`, to `localSettings`: Glade rewrites the destination.

**A domain rule reaches both, from settings only.** `applyFlagSettings({ permissions: { allow:
['WebFetch(domain:www.example.org)'] } })` mid-session let both `curl` and `WebFetch` to that host through without
asking, while other hosts still asked. The same rule in `allowedTools` at start did not: `curl` to it still asked.

### Running outside the sandbox [verified]

The model sets `dangerouslyDisableSandbox: true` on its `Bash` call, on its own after a sandbox failure, or when told.
`canUseTool("Bash", …)` then gets:

```jsonc
// in acceptEdits, autoAllowBashIfSandboxed: true, with Glade's ask rule given at start:
// settings: { permissions: { ask: ['Bash(dangerouslyDisableSandbox:true)'] } }
{ "command": "touch /Users/me/probe/ws/a.txt", "dangerouslyDisableSandbox": true }
{ "decisionReason": "dangerouslyDisableSandbox", "displayName": "Bash", "description": "touch /Users/me/probe/ws/a.txt",
  "toolUseID": "toolu_01…", "requestId": "b5a6dac2-…",
  "matchedAskRule": { "source": "flagSettings", "toolName": "Bash", "ruleContent": "dangerouslyDisableSandbox:true" } }
```

- **The ask rule is needed, and works:** with a P11 task rule matching the command (`Bash(touch *)` in
  `allowedTools`), the override still asked with the ask rule (with no `decisionReason` or `matchedAskRule` that time),
  and **ran without asking** without it. With neither rule, it asked, with `decisionReason:
  "dangerouslyDisableSandbox"`.
- **No suggestions** for a path in the workspace; for a path outside it, the `Bash` path check adds `blockedPath` and an
  `addRules` + `addDirectories` pair. A card for it shouldn't offer to remember anything.
- **The ask rule survives `applyFlagSettings({ permissions })`** that leaves it out, since it was given at start (see
  below).

### Changing a running session's sandbox: `applyFlagSettings` [verified]

- **Widening applies from the next command,** mid-turn too (from inside a held hook, above).
- **Narrowing works only for what `applyFlagSettings` added.** Started with `allowRead`/`allowWrite` of the workspace
  alone, widened to the sibling folder (the next `cat` worked), then narrowed back (the next `cat` failed again). But
  started with the sibling folder already allowed, in the `sandbox` option or in `settings.sandbox`, narrowing with
  `applyFlagSettings` left it readable. The lists of the two layers are merged, and only the later one is replaced.
- **The same for permissions:** `applyFlagSettings({ permissions: { allow: ['Read(//…/outside/**)'],
  additionalDirectories: ['…/outside2'] } })` let a `Read` and a `Write` there through without asking, and
  `applyFlagSettings({ permissions: { allow: [], additionalDirectories: [] } })` made both ask again. The `ask` rule
  given at start in `settings.permissions` still applied after both.
- **It merges with the other flag settings:** after `applyFlagSettings({ sandbox, permissions })`, a project server
  named in the start's `settings.deniedMcpServers` stayed left out, and the effort set by an earlier
  `applyFlagSettings({ effortLevel: 'high' })` stayed `high` (the `PreToolUse` hook's `effort.level`, on Sonnet). Each
  call replaces only the top-level keys it names (`sdk.d.ts`).
- **A host already allowed stays allowed** until the session restarts (docs; consistent with the probe above).

So Glade starts a sandboxed session with the parts that never change, and the grants as a flag-settings overlay:

```js
// query() options at start
sandbox: { enabled: true, autoAllowBashIfSandboxed, filesystem: { denyRead: ['~', '/Users', '/Volumes'],
           allowRead: [root], allowWrite: [root] }, credentials: { files: [...credential denies] } },
settings: { deniedMcpServers: [...], permissions: { ask: ['Bash(dangerouslyDisableSandbox:true)'] } },
// then, before the first message, and again on every grant change: the whole overlay each time
await q.applyFlagSettings({
  sandbox: { ...the same base, filesystem: { ...base, allowRead: [root, ...grants], allowWrite: [root, ...rwGrants] } },
  permissions: { allow: ['Read(//<ro grant>/**)', 'WebFetch(domain:<domain>)', …], additionalDirectories: [...rwGrants] },
})
```

### When the sandbox can't start [verified]

macOS has no sandbox dependency to miss (the CLI's dependency check only fails an unsupported platform), so the probe
broke the config instead: `network.tlsTerminate` with a CA certificate and no key.

- **The session starts and runs.** `system/init` came as usual, and the model answered. Nothing failed until a command.
- **Each `Bash` call fails** (a `PostToolUseFailure`, and an error result):
  `Sandbox is required but failed to initialize: tlsTerminate: caCertPath and caKeyPath must be provided together.
  Restart to retry.` (The CLI's code has a variant for a settings error: `…Fix the sandbox settings to retry (a
  --settings file is pinned for the process: restart).`)
- **The model then asks to run it outside the sandbox** (`dangerouslyDisableSandbox: true`,
  `decisionReason: "dangerouslyDisableSandbox"`), which ran once allowed. Glade must deny those itself, since the user
  would see an override card for every command.
- **With `failIfUnavailable: false`** the CLI's code instead says `Sandbox is enabled but failed to initialize…` once
  and runs every command unsandboxed for the rest of the session: Glade never sets it.
- **[docs]** Where a dependency is missing (bubblewrap on Linux), `query()` "will emit an error result and exit": not
  reachable on macOS.

### What Glade does (P15-03, #448)

The sandbox is on when Settings' `sandboxEnabled` is (Settings › Agent › Sandbox, P15-06), read as each session
starts; a session keeps the sandbox it started with for its whole life. **The setting is off by default while P15 is
being built**, since main is released from and a sandboxed task has no cards or settings to be granted anything with
yet: the default flips to on in P15's last PR (#452). With it off, a session starts exactly as it did before P15. With
it on (`src/main/agent/sandbox.ts`, wired in `runner.ts` and `sdk-backend.ts`):

- **At start, only the fixed parts** (`sandboxStartSettings`), since `applyFlagSettings` can't narrow them: `enabled`
  and `failIfUnavailable`; `filesystem.denyRead` the home folder (absolute, never `~`), `/Users` and `/Volumes`;
  `allowRead` and `allowWrite` the workspace root only; `network.allowedDomains` empty; the credential paths
  (`CREDENTIAL_PATHS`: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.config/gcloud`, `~/.azure`, `~/.kube`,
  `~/Library/Keychains`, `~/.netrc`, `~/.git-credentials`, `~/.docker/config.json`) in `credentials.files` and
  `filesystem.denyWrite`, and as `Read(…)` and `Edit(…)` rules in `settings.permissions.deny` for the file tools; and
  `settings.permissions.ask: ['Bash(dangerouslyDisableSandbox:true)']`. No grant, whatever is granted.
- **Then the overlay** (`sandboxOverlay`), with `applyFlagSettings`, straight after start and before the first message
  (the backend queues it ahead of `send`), and again whenever the task's permission mode changes: the fixed parts
  again, `autoAllowBashIfSandboxed` for the mode, and the grants (none until P15-04): every granted folder in
  `allowRead`, the read-write ones in `allowWrite` and `permissions.additionalDirectories`, the read-only ones as
  `Read(//<folder>/**)` rules and domains as `WebFetch(domain:…)` rules in `permissions.allow`. Domains never go in
  `allowedTools`. A grant that would open more than it names never reaches the settings (`usableGrants`), and is
  logged: a folder that isn't an absolute path, is `/` (or comes to it through `..`), or has a glob character (`*`,
  `?`, `[`, `]`, `{`, `}`, `\`: sandbox paths and rule contents are patterns), and a domain that isn't a bare host
  name with an optional leading `*.`.
- **`autoAllowBashIfSandboxed` is in the overlay only, never the start. [verified]** Probed for #448 (one `query()` on
  `haiku`, `permissionMode: 'default'`, `settingSources: []`, started with `sandbox: { enabled: true, filesystem: {
  allowWrite: [cwd] } }` and no `autoAllowBashIfSandboxed`, three turns each running `touch <file>` in the workspace):
  with nothing set, the command ran without `canUseTool` being asked (the SDK's default is on); after
  `applyFlagSettings({ sandbox: { …the same, autoAllowBashIfSandboxed: false } })`, `canUseTool("Bash", …)` was asked;
  after applying it with `true` again, the command ran unasked. So the overlay's value holds both ways when the start
  leaves it out. Whether an overlay could override a value the start did set wasn't probed, and Glade doesn't rely on
  it.
- **No message before the overlay, and no session without it.** The runner holds a sandboxed session's messages and
  settings changes until its first overlay is applied (`gatedSession`, `src/main/agent/gated-session.ts`): the backend
  delivers in order anyway, but carries on after a change the SDK refuses. An overlay that's refused, or that throws,
  closes the session (`onSandboxNotApplied`), the first one and any later one (a mode change): what was held is never
  sent, and the turn ends on the sandbox's error, "The sandbox couldn't start: couldn't apply the sandbox settings:
  <why>", whose Retry starts a new session. A session idle between turns is closed without an error, and the next
  message starts a new one.
- **The modes:** Allow all runs as `acceptEdits` (`sdkPermissionMode(mode, sandboxed)`), never `bypassPermissions`, and
  a sandboxed session is started without `allowDangerouslySkipPermissions`, so nothing can switch it into bypassing.
  The ask mode runs `default`. Switching a running task's mode calls `setPermissionMode` and reapplies the overlay.
- **What asks** (`toolCallVerdict`, `src/main/permissions/sandbox-classify.ts`), in either mode: a read (`Read`,
  `NotebookRead`, `LS`, and `Grep` and `Glob` should they come back) under the home folder, `/Users`, `/Volumes` or
  `/System/Volumes` outside the root and the granted folders; a write (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`)
  outside the root and the read-write folders; `WebFetch` to a domain that isn't granted; `SandboxNetworkAccess`; and
  every request to run outside the sandbox, whatever the `decisionReason`: `input.dangerouslyDisableSandbox` set to
  anything but `false` or the string `"false"` (a model may send `"true"`). A read outside those folders goes ahead,
  though `acceptEdits` asks about it. `WebSearch` never asks. In Allow all, everything else that isn't a write goes
  ahead; in the ask mode, P11's rules decide it. Until P15-05, a crossing opens P11's card, with Allow once and Deny
  only: Allow for this task isn't offered on it (`suppressAlwaysAllowRule`), since the rule P11 would grant for a write
  is the whole tool.
- **Paths are compared by where they really are** (`src/main/permissions/canonical-path.ts`), so another spelling of a
  denied folder asks like the folder itself: `~` is expanded, a relative path is from the root, symbolic links are
  followed (`fs.realpathSync.native` on the deepest part that exists, and `readlink` for a link whose target doesn't
  exist yet, since a write would create it there), the data volume's alias is dropped (`/System/Volumes/Data/Users/…`
  is `/Users/…`; `realpath` doesn't do that), and what's left is compared lower-cased, in one Unicode form. So a
  link a sandboxed command made in the root (`ln -s ~/Documents link`) leads where it leads, and `/users/ME/…` is
  `/Users/me/…`. A path that can't be resolved (a loop of links) asks. The root, the home folder and the granted
  folders are resolved once per session (`sandboxBounds`); deciding a call resolves only the call's own path.
  (Commands aren't denied `/System/Volumes`: the system runs from there. Only the file tools are bounded in it.)
- **A credential path is refused** by Glade itself, read or write, without a card, however it's spelled and whatever
  is granted (`CREDENTIAL_REFUSAL`): the deny rules in the settings are literal paths, which an alias might dodge.
- **A write inside the bounds that still reaches `canUseTool` asks.** In Allow all, `acceptEdits` lets edits inside
  the root and the additional directories through by itself, so a write Glade is asked about was held back by Claude
  Code's own check of the files that run code (`.mcp.json`, `.claude/`, `.git/`, `.vscode/`, `.idea/`, `.gitconfig`,
  `.gitmodules`, `.ripgreprc`, shell startup files: its list in the bundled binary), or by a user's ask rule: writing
  `.mcp.json`, `.claude/settings.local.json` or `.git/config` would each run code outside the sandbox later. Glade
  shows the card for it, in either mode, and Allow for this task isn't offered. (Glade's own `git` also runs with
  `-c core.fsmonitor=false`, `src/main/git/git.ts`: that config names a command, and Glade's git runs on the host.)
- **Whole-tool rules never reach a sandboxed session** (`isUnboundedRule`). P11's Allow for this task on an `Edit` or
  `Write` grants the whole tool, which Claude Code takes for every folder, in `allowedTools` and as a session rule
  alike: with it, `Write ~/Library/LaunchAgents/x.plist` runs unasked. So a sandboxed session is started without the
  task's rules for a whole tool the sandbox bounds (the file tools and `WebFetch`), and isn't handed one granted while
  it runs. The task keeps the rule, and Glade applies it itself in the ask mode: that tool's writes inside the bounds
  go ahead, except to the files that run code; outside them, it asks. Rules with content (`Bash(npm test *)`) go to
  the session as before.
- **A sandbox that can't start** is spotted in the session's `PostToolUseFailure` hook on `Bash` and `Monitor` (a
  matcher of `Bash|Monitor`: a `Monitor` call's command runs in the sandbox too; that it fails with the same text is
  [not probed]). The hook (`SessionHooks.onBashFinished`) is given only to a sandboxed session and answers at once,
  before the agent reads the result, so the failure is known before the agent can ask to run outside the sandbox. It's
  a failed call whose error starts with
  `Sandbox is required but failed to initialize:` (`sandboxFailureReason`, `src/shared/sandboxFailure.ts`). Text that
  only mentions it (a command's output, another tool's result, the agent's own message) doesn't count. From then on,
  every request to run outside the sandbox in that session is denied in `canUseTool` without a card, with a message
  telling the agent to stop running commands (`SANDBOX_FAILED_REFUSAL`), and the turn ends on a `TaskError` with
  `source: 'sandbox'` and Claude Code's message as its details: the existing error card, "The sandbox couldn't
  start: <why>". A failure seen with no turn running (a background command) stops the task at once. Retry closes the
  session first, so the retry's new session starts its sandbox again; unlike a retry after a lost login, it closes a
  session with background subagents or watchers too, which end saying the session was restarted, since retrying in
  the same session would only fail the same way. Other tasks' sessions are unaffected. `failIfUnavailable` stays
  true, so nothing ever runs unsandboxed.

### Test backends

The scripted and fake backends play these shapes (`src/main/agent/sandbox-requests.ts`): see the sandbox steps in
`src/main/agent/scripts.ts`, and `FakeAgentSession` (`fake-backend.ts`). They record the `sandbox` and `permissions`
a session starts with and every `applyFlagSettings` call. The `sandbox-fails` script plays a session whose sandbox
couldn't start (`e2e/sandbox.spec.ts`).

---

## SDK bumps

What each bump changed, from the SDK's changelog, Claude Code's changelog and a diff of `sdk.d.ts`, and what it means
for Glade. Dependabot opens each bump (`docs/kitten-sop.md`, "Dependabot PRs").

### 0.3.281 → 0.3.283 (Claude Code 2.1.283) (#329)

Nothing Glade relies on changed shape: the diff of `sdk.d.ts` leaves `SDKMessage`, `system/init`, `result`, the task
events, `compact_boundary`, `rate_limit_event` (and its `usage_EXPERIMENTAL_…` field, which Glade doesn't read),
`AccountInfo`, `ModelInfo` and the startup failure reasons as they were. The packaged app ran one Haiku turn from its
bundled binary. What did change:

- **`system/informational` messages mid-turn.** Claude Code now streams warnings and notices raised during a turn as
  `system/informational` messages; before, it dropped them. Glade's parser ignores that subtype (§2), so they change
  nothing on screen. The one Glade relies on, a prompt its `UserPromptSubmit` hook turned away (§13), came as one
  already.
- **`system/init` gains `plugin_errors`** (optional: a Claude Code plugin that didn't load, with a `path` for a plugin
  directory). Glade passes no `plugins` and doesn't read it; the user's own plugins may now show up there.
- **`set_max_thinking_tokens`:** leaving `max_thinking_tokens` out now keeps the budget; `null` resets it. Glade never
  sends it (§4: thinking is session-level).
- **Alpha, unused:** `prewarm()` and `SpareProcess.claim()` start a Claude Code process before its folder is known and
  bind it later, and `@anthropic-ai/claude-agent-sdk/core` is a smaller entry point. Both are candidates for the "one
  CLI subprocess per live task" risk below, not adopted.
- **Fixes:** `getSessionMessages()` and `forkSession()` no longer return or copy a rewound-away branch; Glade reads
  Claude Code transcripts itself for imports (§8) and calls neither. Claude Code 2.1.283 also fixes SDK sessions losing
  a deferred tool call or finished tool result when a turn ended early, and a non-streaming fallback's `result.usage`.
- **Managed settings:** `availableModelsMatch`, `deniedModels`, `strictKnownMarketplaces` and `blockedMarketplaces`
  are new. A managed policy that blocks every model now fails startup with `managed_settings_invalid`, a reason Glade
  already handles.
- A new remote-session `subkind` (`session-inbox`) on a user message's origin, and `_meta` keys under `com.anthropic/`
  dropped from `readMcpResource()`: Glade reads neither.

---

## Open risks

- **Subscription auth policy.** Glade is login-based by decision, but the docs don't clearly permit this for a
  third-party app, and Anthropic can enforce "without prior notice". If that happens, Glade would need an API-key path.
  Log in (#409) runs the unmodified binary's own `claude auth login`, so sign-in completes in Anthropic's own flow and
  Glade never holds a credential, but it is a button in a third-party app that starts a claude.ai login.
- **Auto-compact threshold.** Glade uses the SDK default (about 83% on 200k). A custom threshold is deferred; the SDK
  caps it at about `window − 13k`.
- **One CLI subprocess per live task.** Each `query()` spawns the ~220 MB native binary as a separate process. With many
  parallel tasks (P2), memory and startup cost need measuring. Idle tasks may need to `close()` and `resume` lazily.
- **Blocking `ask` across a crash.** If Glade dies while `ask` is waiting, the resumed session has a `tool_use` with no
  result. Glade keeps the question open and hands the answer to the resumed session as a message (§3, P4).
- **`ask`'s bound.** Claude Code bounds every MCP call, at most about 24.8 days (§3); Glade raises the `glade` server's
  to that, but it can't be lifted entirely. Re-check the default and the clamp on each SDK bump: if a version lowers the
  clamp, a long-waiting `ask` fails sooner.
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

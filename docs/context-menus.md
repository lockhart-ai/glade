# Context menus

Right-click anything that can be acted on. Menus mirror the on-screen buttons plus less common actions; destructive
items are in pink and sit last, bar the terminal tab's Close. ![Context menus](design/screens/13-context-menus.png)

| Target | Items |
|---|---|
| Task (active), sidebar row | Open ↵ · — · Pin to top ⌘⇧P · Rename… F2 · Mark as unread ⌘⇧U · — · Mark done ⌘⇧D · — · Copy link to task · — · Delete task… |
| Task (done), row or search result | Open ↵ · — · Pin to top · Rename… · — · Reopen · — · Copy link to task · Copy outcome · — · Delete task… |
| Chat message (agent reply) | Copy ⌘C · Copy as Markdown · Quote in reply · — · Show this turn's tool calls |
| Queued message | Edit · — · Remove |
| Tool call | Copy command · Copy output · Open file · — · Run again in terminal |
| File tab / file | Close ⌘W · Close others · Close all · — · Open in editor ⌘⇧E · Reveal in Finder · Copy path · Copy relative path |
| Artifact | Open ↵ · Open in editor ⌘⇧E · — · Copy contents · Copy path · Reveal in Finder · — · Remove from artifacts |
| Subagent | Expand log ↵ · Copy log · — · Stop subagent |
| Terminal tab | Rename… · Duplicate · Clear ⌘K · — · Kill process ⌃C · Close ⌘W |
| Todo | Copy · Ask agent about this |

Some items show only when they apply: Pin to top reads Unpin on a pinned task; Show this turn's tool calls needs a
turn with tool calls; a tool call's Copy command, Copy output, Open file and Run again in terminal need a command, an
output or a file; Expand log reads Collapse log when the log is open; and Stop subagent shows while it runs. Delete
task always confirms before deleting.

**Copy link to task** copies a `glade://task/<id>` link, which names the task but doesn't open anything yet: Glade
doesn't register the `glade:` scheme with macOS (`src/shared/taskLink.ts`).

**Todos** have no Mark done or Remove: the agent keeps the list with Claude Code's own todo tools, so changing it is
the agent's job. Ask agent about this puts the todo in your message to it.

# Context menus

Right-click anything that can be acted on. Menus mirror the on-screen buttons plus less common actions; destructive
items sit last, in pink. ![Context menus](design/screens/13-context-menus.png)

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
| Todo | Copy · Ask agent about this · — · Mark done myself · Remove |

Delete task always confirms before deleting.

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
| Link artifact | Open link ↵ · — · Copy link · — · Remove from artifacts |
| Subagent | Expand log ↵ · Copy log · — · Stop subagent |
| Terminal tab | Rename… · Duplicate · Clear ⌘K · — · Kill process ⌃C · Close ⌘W |
| Todo | Copy · Ask agent about this |
| Link | Open link · — · Copy link · — · Add to artifacts |

Some items show only when they apply: Pin to top reads Unpin on a pinned task; Show this turn's tool calls needs a
turn with tool calls; a tool call's Copy command, Copy output, Open file and Run again in terminal need a command, an
output or a file; Expand log reads Collapse log when the log is open; and Stop subagent shows while it runs. Delete
task always confirms before deleting. A file tab showing a file as a commit left it (opened from the Changes tab) is
only in git, so its menu has no Open in editor, Reveal in Finder or Copy path; Copy relative path copies its path in
the commit's repository. An artifact's row also opens its menu from its **More** button, shown while the row is hovered. A commit in the Changes tab has no menu: the tab only shows what the agent did.

**Copy link to task** copies a `glade://task/<id>` link, which names the task but doesn't open anything yet: Glade
doesn't register the `glade:` scheme with macOS (`src/shared/taskLink.ts`).

**Links** have their own menu wherever they're shown (a reply, a todo, a tool's output): right-clicking one opens it,
not the menu of what it's in. Open link opens it in your browser, as clicking it does; Copy link copies its address.
Add to artifacts (#407) adds a web link to the open task's artifacts, called what the link says, or `#412` or `API-123`
for a bare PR, issue or ticket link; it shows only for an `http:` or `https:` link that isn't one of them already.
A **link artifact**'s row in the Artifacts tab has its own menu: Open link opens it in your browser, as clicking the
row does, Copy link copies its address, and Remove from artifacts takes it off the list.

**Todos** have no Mark done or Remove: the agent keeps the list with Claude Code's own todo tools, so changing it is
the agent's job. Ask agent about this puts the todo in your message to it. With the todo hub on (the hidden
`todoHubEnabled` setting, off until #501), the menu is the same and opens from a todo's head (its title and status
line); **Not under a todo** has none, and a tile's own menu comes with its kind (#498, #499). A PR, an issue or a
ticket a todo names, which is a link while the task has it as one (#500), has the link's menu, not the todo's: Open
link and Copy link, with no Add to artifacts, since it's one already.

**A file's and a link's tile** in the todo hub (#498, behind the same hidden `todoHubEnabled` setting until #501) have
the menus their rows in the Artifacts tab have, item for item: a file's is **Artifact**'s above, and a link's is
**Link artifact**'s. A tile's menu opens from a right-click on it, from Context menu (⇧F10) while it or one of its
buttons has the focus, and from its **More** button, which shows with Open and Reveal in folder (or Open link and
Copy link) in place of the tile's age while the tile is under the pointer or has the focus. Remove from artifacts
takes the tile out of its todo's list and count, and leaves the file. A file that's gone keeps its menu, so it can
still be removed. With the setting off there are no tiles, and the Artifacts tab's rows have their menus as before.

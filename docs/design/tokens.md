# Design tokens

Dark theme only, cool tones. Flat near-black background; every section is a rounded card floating above it; cards
can nest one level (header and right panel float inside the task card).

## Colour

| Token | Hex | Use |
|---|---|---|
| `bg` | `#0A0B0F` | Window background, inset fields, code blocks |
| `panel` | `#14151C` | Top-level cards (sidebar, task card, terminal, plugin) |
| `raised` | `#1D1F29` | Selected rows, input bar, dark buttons |
| `inner` | `#1C1E28` | Nested cards (header, right panel) |
| `inner-2` | `#272A38` | Active tab, highlighted rows inside nested cards |
| `border` | `#272A37` | Top-level card borders |
| `inner-border` | `#2E3242` | Nested card borders and dividers |
| `strong` | `#343850` | Button outlines, input bar border |
| `menu` | `#20222C` | Menus and popovers |
| `text` | `#E6E8F0` | Primary text |
| `muted` | `#A6ABBD` | Secondary text |
| `faint` | `#8A8FA5` | Labels, timestamps, hints |
| `blue` | `#5B8DEF` | Working, primary buttons, links (`#8FB2F5` for text on dark) |
| `purple` | `#C8B2FF` | Waiting on you, questions, the lit blade |
| `slate` | `#5C6378` | Done, finished tool calls |
| `pink` | `#E58FA8` | Errors, destructive menu items, deleted lines |
| `teal` | `#7FD1C7` | Added lines, strings in code |
| user bubble | `#22304D` | Your messages |
| question highlight | `#1E1B33` / `#3B3366` | Background / border of the agent's question card |

## Type

- **Geist** for everything; **Geist Mono** for labels, timestamps, paths, code, tool calls.
- Sizes: task title 26/600 · chat 14.5/1.6 · body 14 · secondary 12.5–13 · labels 11 mono uppercase, letter-spacing 0.08em.

## Spacing

One scale; every padding, margin and gap comes from it.

| Token | px |
|---|---|
| `space-2xs` | 2 |
| `space-xs` | 4 |
| `space-sm` | 6 |
| `space-md` | 8 |
| `space-lg` | 12 |
| `space-xl` | 16 |
| `space-2xl` | 24 |

And the insets that keep things on shared lines:

- `space-outer` = 8: the window's outer padding and the gaps between top-level cards.
- `space-inset` = 8: every panel's inset, from a card's edge to the cards, rows and fields inside it. The task card's
  header, chat column, input bar and right panel all sit 8 in from its edges; in the sidebar the workspace button,
  search field, filter chips, section headers and task rows share one left edge 8 in; the right panel's rows sit 8 in
  from it.
- `space-item` = 8: the inner padding of those rows, fields and buttons (inside their 1px border), so their content
  (dots, icons, chevrons, labels) shares a second line, 17px in from the panel's edge.
- Nested cards pad their content by `space-xl` (16) at the sides and `space-lg`–`space-xl` top and bottom; lists
  inside a panel space their rows `space-2xs`, and sections `space-xl`.

## Shape

- Top-level card radius 16; nested cards 12; buttons 7–8; pills 13; menus 10.
- Nested cards get `box-shadow: 0 6px 20px rgba(0,0,0,.25)`. Menus and popovers `0 16px 40px rgba(0,0,0,.55)`.
  Toasts `0 12px 32px rgba(0,0,0,.45)`.
- Touch targets at least 28px in dense areas, 44px for the send button.

The exact markup for every screen is in `html/` — open a file to read the CSS values. After changing one, re-render
its PNG in `screens/` with `npm run render-design -- <name>` (e.g. `task-workspace`; no names renders them all).

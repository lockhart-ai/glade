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

## Shape and spacing

- Outer padding and gaps between top-level cards: 12px. Top-level card radius 16; nested cards 12; buttons 7–8;
  pills 13; menus 10.
- Nested cards get `box-shadow: 0 6px 20px rgba(0,0,0,.25)`. Menus and popovers `0 16px 40px rgba(0,0,0,.55)`.
- Touch targets at least 28px in dense areas, 44px for the send button.

The exact markup for every screen is in `html/` — open a file to read the CSS values. (Those files need the design
tool's runtime to render; use the PNGs in `screens/` to look at them.)

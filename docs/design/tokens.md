# Design tokens

Dark theme only, cool tones. Flat near-black background; every section is a rounded card floating above it; cards
can nest one level (header and right panel float inside the task card).

## Colour

| Token | Hex | Use |
|---|---|---|
| `bg` | `#0A0B0F` | Window background, inset fields, code blocks |
| `panel` | `#181921` | Top-level cards (sidebar, task card, terminal, plugin) |
| `raised` | `#232531` | Selected rows, input bar, dark buttons |
| `inner` | `#222430` | Nested cards (header, right panel, the agent's reply cards) |
| `inner-hover` | `#282B39` | The row under the pointer inside a nested card: halfway from `inner` to `inner-2` (the Browse tree, #431) |
| `inner-2` | `#2E3243` | Active tab, highlighted rows inside nested cards |
| `border` | `#2F3343` | Top-level card borders |
| `inner-border` | `#373C4F` | Nested card borders and dividers |
| `strong` | `#3D425E` | Button outlines, input bar border |
| `menu` | `#262935` | Menus and popovers |
| `text` | `#E6E8F0` | Primary text |
| `muted` | `#AEB3C3` | Secondary text |
| `faint` | `#999DB0` | Labels, timestamps, hints |
| `blue` | `#5B8DEF` | Working, primary buttons, links (`#8FB2F5` for text on dark) |
| `purple` | `#C8B2FF` | Waiting on you (a question, a permission card, an unread reply), questions, the lit blade |
| `purple-bg` | `#2E2748` | Background for `purple` on a filled surface: a workspace's badge, the closed switcher's "needs you" count pill |
| `slate` | `#5C6378` | Done, an active task that's idle (#430), finished tool calls, a withdrawn permission's shield |
| `pink` | `#E58FA8` | Errors, destructive menu items, deleted lines, a denied or blocked permission |
| `teal` | `#7FD1C7` | Added lines, strings in code, done todos, a granted permission |
| user bubble | `#22304D` | Your messages |
| question highlight | `#1E1B33` / `#3B3366` | Background / border of the agent's question card, and of every agent reply (#410) |

### Contrast

The surfaces step up in lightness from `bg`, keeping one cool hue, so each card stands off the one it sits on even in
bright light. `tokens.test.ts` holds each neighbouring pair to at least these WCAG contrast ratios, so the steps can't
quietly slip back:

| Pair | At least |
|---|---|
| `panel` on `bg` | 1.12 |
| `raised` on `panel` | 1.15 |
| `inner` on `panel` | 1.13 |
| `inner-hover` on `inner` | 1.09 |
| `inner-2` on `inner` | 1.21 |
| `menu` on `panel` | 1.20 |
| `border` on `bg` | 1.56 |
| `border` on `panel` | 1.39 |
| `inner-border` on `panel` | 1.60 |
| `inner-border` on `inner` | 1.40 |
| `strong` on `panel` | 1.78 |
| `strong` on `raised` | 1.54 |
| `strong` on `inner` | 1.56 |

`text`, `muted` and `faint` each meet 4.5:1 on every surface: `bg`, `panel`, `raised`, `inner`, `inner-hover`,
`inner-2` and `menu` (the lowest is `faint` on `inner-2`, 4.72:1).

## Type

- **Geist** for everything; **Geist Mono** for labels, timestamps, paths, code, tool calls.
- Sizes: task title 20/600 · chat 14.5/1.6 · body 14 · secondary 12.5–13 · labels 11 mono uppercase, letter-spacing 0.08em.

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
- `title-bar-height` = 28: there's no title bar row; the cards rise to the window's outer inset, as on the other sides.
  The sidebar card starts with a strip this tall that holds the macOS window controls (the traffic lights, placed 16
  in and 16 down: centred in it, 7 inside the card's top and left edges, as macOS draws them 14px across) and nothing
  else. The strip, and the outer inset along the window's top, drag the window, and double-clicking them zooms. While
  the app-wide banner shows, it starts below the lights, and the sidebar's own strip folds away.
  While the sidebar is collapsed, the lights move into the task header's first row instead (#357;
  `lights-collapsed-width` = 60, the room the AppKit measures the lights' cluster takes; placed 34 in and 34 down,
  left of the Show task list toggle, the dot and the title, which shift right to clear them), or the row that shows
  the task list again with no task open. The header (or that row) starts at the window's outer inset like the right
  panel: there's no strip above it any more. `lights-clear-y` says how deep the lights currently reach (36 open, 50
  collapsed), so Settings and the relaunch notice, and the banner's own top offset, keep clear of whichever is live.
  That row doesn't drag the window while the sidebar or the right panel slides, though (a drag region that moves with
  every frame stalls the slide on macOS): it does again once the slide lands.
- `space-inset` = 8: every panel's inset, from a card's edge to the cards, rows and fields inside it. The task card's
  header, chat column, input bar and right panel all sit 8 in from its edges; in the sidebar the workspace button,
  search field, section headers and task rows share one left edge 8 in; the right panel's rows sit 8 in
  from it.
- `space-item` = 8: the inner padding of those rows, fields and buttons (inside their 1px border), so their content
  (dots, icons, chevrons, labels) shares a second line, 17px in from the panel's edge.
- Nested cards pad their content by `space-xl` (16) at the sides and `space-lg`–`space-xl` top and bottom; lists
  inside a panel space their rows `space-2xs`, and sections `space-xl`.

## Shape

- Top-level card radius 16; nested cards 12; buttons 7–8; pills 13; menus 10.
- A box drawn inside a card, a few pixels in from its edge, takes the radius that keeps its corner concentric with the
  card's: the card's 16, less its 1px border and the gap. The workspace switcher's hover and open box, 3px in, is 12.
- Nested cards get `box-shadow: 0 6px 20px rgba(0,0,0,.25)`. Menus and popovers `0 16px 40px rgba(0,0,0,.55)`.
  Toasts `0 12px 32px rgba(0,0,0,.45)`.
- Touch targets at least 28px in dense areas, 44px for the send button.

## Scroll bars

Every scroll bar is a thin rounded thumb on a transparent track, the same with macOS's overlay scroll bars (a trackpad)
or its always-on ones (a mouse, or "Show scroll bars: Always"). They're styled once, in `global.css`; the terminal's
(xterm.js draws its own) takes the same colours and shape.

| Token | Value | Use |
|---|---|---|
| `scrollbar-size` | 10px | The room the bar takes, across it |
| `scrollbar-inset` | 2px | The gap between the thumb and the bar's edges: a 6px thumb, fully rounded |
| `scrollbar-thumb-min` | 32px | The shortest the thumb gets |
| `scrollbar-thumb` | `strong` | The thumb |
| `scrollbar-thumb-hover` | `slate` | The thumb under the pointer |
| `scrollbar-thumb-active` | `faint` | The thumb while it's dragged |

## Motion

State changes animate rather than jump: short, calm, easing out. Animate opacity, `transform` (or `translate` and
`scale`) or a panel's size; nothing bounces or overshoots.

| Token | Value | Use |
|---|---|---|
| `motion-duration` | 200ms | Panels collapsing and expanding, sections and rows opening, toasts, the question card |
| `motion-duration-fast` | 120ms | Menus and popovers appearing, toggles, hover colours |
| `motion-ease` | `cubic-bezier(0.2, 0, 0, 1)` | Everything: ease-out |

- Panels (the sidebar, the right panel, the bottom bar) slide: their size animates while their content keeps its size
  and is clipped, so nothing inside reflows. Only how open a panel is animates, never its size, so dragging a resize
  handle follows the pointer at once.
- Sections and rows (task list sections, tool calls, subagents) open and close by height with a fade.
- Toasts rise 8px and fade in, and fade out. The question card rises and fades in when the agent asks, and cross-fades
  to its answered state. Menus and popovers fade in from 97% scale; they close at once.
- Things that are already on screen when a window or task opens don't animate in.
- The working line's three dots pulse in turn while the agent works: each fades from 33% up to full and back over
  7 × `motion-duration`, one `motion-duration` behind the dot before it. It's the one thing that moves on its own.
- **Reduce motion** (macOS, `prefers-reduced-motion`): both durations are 0, so every change is instant, and the
  working dots hold still in the design's frame.

The exact markup for every screen is in `html/` — open a file to read the CSS values. After changing one, re-render
its PNG in `screens/` with `npm run render-design -- <name>` (e.g. `task-workspace`; no names renders them all). It
retries a capture that comes back without its text, and fails if none has it. If no screen finishes for 60 s (5
minutes in all), it stops Electron and fails, naming the step it was stuck on. CI runs `npm run check-design`, which
fails if any screen renders without its text or a committed PNG is missing its text.

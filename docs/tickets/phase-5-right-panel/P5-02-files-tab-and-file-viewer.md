---
id: P5-02
title: "P5-02: Files tab and file viewer"
milestone: "P5 · Right panel tabs"
labels: [phase-5, feature]
depends_on: [P5-01]
---

# P5-02: Files tab and file viewer

Read files the task touched, next to the chat.

## Scope

- Second row of open-file tabs (close buttons; blue dot on files the agent changed).
- File list dropdown: Changed and Read, derived from tool events.
- Viewer: source with line numbers and syntax highlighting; Source / Preview toggle for Markdown; Open in editor.
- `show_file` tool opens a file here.
- Read-only viewer. No diff review, no keep/revert.

## Acceptance criteria

- [ ] Matches `08-open-file.png`.
- [ ] Large files stay responsive.

## Design

![08-open-file](../../design/screens/08-open-file.png)

## Depends on

P5-01

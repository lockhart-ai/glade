---
id: P4-02
title: "P4-02: Question card"
milestone: "P4 · Rich questions"
labels: [phase-4, ui, feature]
depends_on: [P4-01]
---

# P4-02: Question card

Render the agent's questions as a card in the chat.

## Scope

- Option cards (radio/checkbox) with optional sketches, pill selectors, optional text field.
- "N of M answered"; Send answers button; keys 1–9 select options.
- After sending, the card collapses to show the chosen answers.
- The task counts as Needs you while a question is open.

## Acceptance criteria

- [ ] Matches `03-rich-question.png`.
- [ ] Keyboard-only answering works.

## Design

![03-rich-question](../../design/screens/03-rich-question.png)

## Depends on

P4-01

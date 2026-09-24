---
id: P3-02
title: "P3-02: Automatic compaction with CLAUDE.md notes"
milestone: "P3 · Context and resilience"
labels: [phase-3, agent]
depends_on: [P3-01]
---

# P3-02: Automatic compaction with CLAUDE.md notes

Compact at 99% without losing the thread.

## Scope

- Threshold default 99% (setting in P7-03).
- Before compacting, the agent saves its notes to the task's CLAUDE.md; after, it resumes from those notes and the summary.
- Chat divider "Compacted automatically at 99% · 198k → 41k"; tool log shows the notes edit and a Compact row.

## Acceptance criteria

- [ ] A long task crosses the threshold and continues coherently.
- [ ] The full chat and tool log stay in Glade.

## Design

![19-compaction](../../design/screens/19-compaction.png)

## Depends on

P3-01

/**
 * The colour tokens from docs/design/tokens.md, keyed by their CSS custom property name in tokens.css. tokens.test.ts
 * checks that this, tokens.css and tokens.md agree.
 */
export const colors = {
  '--color-bg': '#0a0b0f',
  '--color-panel': '#14151c',
  '--color-raised': '#1d1f29',
  '--color-inner': '#1c1e28',
  '--color-inner-2': '#272a38',
  '--color-border': '#272a37',
  '--color-inner-border': '#2e3242',
  '--color-strong': '#343850',
  '--color-menu': '#20222c',
  '--color-text': '#e6e8f0',
  '--color-muted': '#a6abbd',
  '--color-faint': '#8a8fa5',
  '--color-blue': '#5b8def',
  '--color-blue-text': '#8fb2f5',
  '--color-purple': '#c8b2ff',
  '--color-slate': '#5c6378',
  '--color-pink': '#e58fa8',
  '--color-teal': '#7fd1c7',
  '--color-user-bubble': '#22304d',
  '--color-question-bg': '#1e1b33',
  '--color-question-border': '#3b3366',
} as const

export type ColorToken = keyof typeof colors

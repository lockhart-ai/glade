/**
 * The colour tokens from docs/design/tokens.md, keyed by their CSS custom property name in tokens.css. tokens.test.ts
 * checks that this, tokens.css and tokens.md agree.
 */
export const colors = {
  '--color-bg': '#0a0b0f',
  '--color-panel': '#181921',
  '--color-raised': '#232531',
  '--color-inner': '#222430',
  '--color-inner-2': '#2e3243',
  '--color-border': '#2f3343',
  '--color-inner-border': '#373c4f',
  '--color-strong': '#3d425e',
  '--color-menu': '#262935',
  '--color-text': '#e6e8f0',
  '--color-muted': '#aeb3c3',
  '--color-faint': '#999db0',
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

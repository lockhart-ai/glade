// The working line's dots (Chat.module.css): with motion on they pulse in turn, on the motion tokens; with Reduce motion
// on they hold still in the design's frame. Vitest blanks CSS (even `?raw`), so this reads the stylesheet from disk; the
// e2e spec (e2e/animations.spec.ts) checks what the real app draws.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const chatCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Chat.module.css'), 'utf8')

/** The body of the `@media` block for `query`, or '' if there's none. */
function mediaBlock(query: string): string {
  const start = chatCss.indexOf(`@media (${query})`)
  if (start === -1) return ''
  let depth = 0
  for (let index = chatCss.indexOf('{', start); index < chatCss.length; index += 1) {
    if (chatCss[index] === '{') depth += 1
    if (chatCss[index] === '}') depth -= 1
    if (depth === 0) return chatCss.slice(start, index + 1)
  }
  return ''
}

/** Everything outside the `@media` blocks. */
function outsideMedia(): string {
  return chatCss.replace(mediaBlock('prefers-reduced-motion: no-preference'), '')
}

describe('the working line’s dots', () => {
  it('pulse endlessly, in turn, on the motion tokens, only with motion on', () => {
    const moving = mediaBlock('prefers-reduced-motion: no-preference')

    expect(moving).toContain(
      'animation: working-pulse calc(var(--motion-duration) * 7) var(--motion-ease) infinite both;',
    )
    expect(moving).toMatch(/:nth-child\(2\) \{\s*animation-delay: var\(--motion-duration\);/)
    expect(moving).toMatch(/:nth-child\(3\) \{\s*animation-delay: calc\(var\(--motion-duration\) \* 2\);/)
    expect(chatCss).toMatch(/@keyframes working-pulse \{[^}]*opacity: 0\.33;[^}]*\}\s*30% \{\s*opacity: 1;/)
  })

  it('hold still with Reduce motion on, in the design’s frame', () => {
    // Nothing outside the motion-on block animates them.
    expect(outsideMedia()).not.toMatch(/\.dots[^{]*\{[^}]*animation/)
    // A bright dot trailing two dimmer ones (docs/design/html/02-agent-working.html).
    expect(outsideMedia()).toMatch(/\.dots > span \{[^}]*background: var\(--color-blue\);/)
    expect(outsideMedia()).toMatch(/\.dots > span:nth-child\(2\) \{\s*background: #3e62a8;/)
    expect(outsideMedia()).toMatch(/\.dots > span:nth-child\(3\) \{\s*background: #2b4579;/)
  })
})

import { memo, useLayoutEffect, useMemo, useRef } from 'react'
import { HIGHLIGHT_CHUNK_LINES, type HighlightedLine } from './highlight'
import styles from './SourceView.module.css'

/**
 * How many lines go in one block: as many as highlighting colours at a time, so each chunk it finishes re-renders only
 * its block. The page lays out and paints only the blocks on screen (`content-visibility`), so a file of thousands of
 * lines scrolls as smoothly as a short one.
 */
export const BLOCK_LINES = HIGHLIGHT_CHUNK_LINES

/** The tokens of each block's lines, by block, as far as highlighting has got; a block without shows plain text. */
export type HighlightedBlocks = readonly (readonly HighlightedLine[] | undefined)[]

export interface SourceViewProps {
  /** The file's lines. */
  lines: readonly string[]
  highlighted: HighlightedBlocks
  /** A line to mark and scroll to, from 1; null for none. */
  focusLine: number | null
  /** Changes with every request to show `focusLine`, so asking for the same line again scrolls to it again. */
  focusRequest: number
}

interface BlockProps {
  /** The index of the block's first line in the file. */
  start: number
  lines: readonly string[]
  tokens: readonly HighlightedLine[] | undefined
  /** The marked line, when it's in this block. */
  focusLine: number | null
}

function LineText({ text, tokens }: { text: string; tokens: HighlightedLine | undefined }): React.JSX.Element {
  if (tokens === undefined) return <>{text}</>
  return (
    <>
      {tokens.map((token, index) => (
        <span
          key={index}
          style={{
            color: token.color,
            fontWeight: token.bold ? 600 : undefined,
            fontStyle: token.italic ? 'italic' : undefined,
          }}
        >
          {token.content}
        </span>
      ))}
    </>
  )
}

/** A block of lines. Memoised, so colouring one block, or marking a line in it, doesn't re-render the others. */
const Block = memo(function Block({ start, lines, tokens, focusLine }: BlockProps): React.JSX.Element {
  return (
    <div className={styles.block} style={{ containIntrinsicBlockSize: `auto ${String(lines.length * 1.7)}em` }}>
      {lines.map((text, index) => {
        const number = start + index + 1
        return (
          <div
            key={number}
            className={styles.line}
            data-line={number}
            data-focused={number === focusLine ? true : undefined}
          >
            <span className={styles.number} aria-hidden="true">
              {number}
            </span>
            <span className={styles.code}>
              <LineText text={text} tokens={tokens?.[index]} />
            </span>
          </div>
        )
      })}
    </div>
  )
})

/**
 * A file's source, read-only: numbered lines, coloured as highlighting reaches them, with `focusLine` marked and
 * scrolled into view.
 */
export function SourceView({ lines, highlighted, focusLine, focusRequest }: SourceViewProps): React.JSX.Element {
  const view = useRef<HTMLDivElement>(null)
  const blocks = useMemo(() => {
    const sliced: (readonly string[])[] = []
    for (let start = 0; start < lines.length; start += BLOCK_LINES) sliced.push(lines.slice(start, start + BLOCK_LINES))
    return sliced
  }, [lines])

  useLayoutEffect(() => {
    if (focusLine === null) return
    view.current?.querySelector(`[data-line="${String(focusLine)}"]`)?.scrollIntoView({ block: 'center' })
  }, [focusLine, focusRequest])

  return (
    <div ref={view} className={styles.source} role="code" data-testid="source">
      {blocks.map((block, index) => {
        const start = index * BLOCK_LINES
        const inBlock = focusLine !== null && focusLine > start && focusLine <= start + block.length
        return (
          <Block
            key={start}
            start={start}
            lines={block}
            tokens={highlighted[index]}
            focusLine={inBlock ? focusLine : null}
          />
        )
      })}
    </div>
  )
}

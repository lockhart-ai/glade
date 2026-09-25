// What a user message hands the agent: its text, and the images pasted into it as image content blocks. Shared by the
// SDK backend and the test modes' scripted one, which records it for e2e specs to read.
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ImageData } from '../../shared/images'

/** A user message's content, as the Messages API takes it. */
export type UserContent = SDKUserMessage['message']['content']

/**
 * The content of a message with its images: just its text when it has none; otherwise an image content block for each
 * image, in order, then its text, unless it's blank (the API refuses an empty text block).
 */
export function userContent(text: string, images: readonly ImageData[] = []): UserContent {
  if (images.length === 0) return text
  return [
    ...images.map(({ mediaType, data }) => ({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: mediaType, data },
    })),
    ...(text.trim() === '' ? [] : [{ type: 'text' as const, text }]),
  ]
}

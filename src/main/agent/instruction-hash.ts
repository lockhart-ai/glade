/**
 * A short, stable fingerprint of an ordered list of prompt lines' exact text (`./session-context`, #708): what tells
 * a line whose wording changed from one that's merely new. Not security-sensitive — any fast, stable hash would do;
 * sha256 is already used the same way elsewhere (`../artifacts/thumbnails`, `../openrouter/sdk-model`).
 */
import { createHash } from 'node:crypto'

/** The fingerprint of `lines`, in order: the same lines, same order, same text always hash the same. */
export function hashLines(lines: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(lines)).digest('hex')
}

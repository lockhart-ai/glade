/**
 * Matching a query against text, for search fields that filter a list in place (the OpenRouter model settings' search
 * and the provider menus' own search, #566).
 */

/**
 * `text` lowercased with its diacritics folded: "Éclair" → "eclair", "GLM" → "glm". Accents and case don't stand in
 * the way of a match.
 */
export function foldText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
}

/**
 * Whether every word of `query` appears in any of `texts`, all diacritic-folded: the words may land in different
 * fields, in any order ("glm flash" matches a model whose name says "GLM" and whose description says "flash"), and
 * runs of whitespace in the query count as one break. An all-whitespace query matches everything.
 */
export function matchesWords(query: string, ...texts: readonly string[]): boolean {
  const folded = texts.map(foldText)
  return foldText(query)
    .split(/\s+/)
    .filter((word) => word !== '')
    .every((word) => folded.some((text) => text.includes(word)))
}

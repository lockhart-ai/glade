/** Joins the class names that are set, skipping `false`, `undefined` and empty strings. */
export function classNames(...names: (string | false | undefined)[]): string {
  return names.filter((name) => name !== false && name !== undefined && name !== '').join(' ')
}

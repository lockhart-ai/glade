/** Looks up a class in a CSS module, failing loudly if the module doesn't define it. For tests. */
export function moduleClass(styles: Readonly<Record<string, string>>, name: string): string {
  const className = styles[name]
  if (className === undefined) throw new Error(`CSS module has no class "${name}"`)
  return className
}

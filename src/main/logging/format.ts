/**
 * How a log record becomes a line of the log file: one JSON object, with its time, level, scope, task id (when it has
 * one) and message first, then its fields. Nothing secret gets through: a field whose name looks like a secret's is
 * redacted, however deep it is, and so is an environment (`redactEnv`). Message text is cut short (`excerpt`), and no
 * string, however it got in, is longer than `MAX_STRING_LENGTH`.
 */
import type { LogFields, LogRecord } from './logger'

/** How much of a message, tool input or tool output the log keeps (at debug level). */
export const EXCERPT_LENGTH = 500

/** The longest any string in a record can be: a stack trace fits, a whole file doesn't. */
export const MAX_STRING_LENGTH = 4000

/** How deep into a field's value the log goes. */
const MAX_DEPTH = 8

/** What a secret's value is logged as. */
export const REDACTED = '[redacted]'

/** The words that make a name a secret's wherever they are in it: `GH_TOKEN`, `clientSecret`, `DB_PASSWORD`. */
const SECRET_WORDS: ReadonlySet<string> = new Set([
  'token',
  'secret',
  'password',
  'passwd',
  'passphrase',
  'credential',
  'credentials',
  'apikey',
  'auth',
  'authorization',
  'cookie',
])

/** `ANTHROPIC_API_KEY` → api, key; `outputTokens` → output, tokens; `x-api-key` → x, api, key. */
function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== '')
    .map((word) => word.toLowerCase())
}

/**
 * Whether a variable or field named `name` holds a secret: it ends in a key (`*_KEY`, `apiKey`), has a secret's word
 * in it (`*_TOKEN`, `*_SECRET`, `authorization`), or has a password anywhere in it (`*PASSWORD*`). A count of tokens
 * (`outputTokens`) isn't one.
 */
export function isSecretName(name: string): boolean {
  const parts = words(name)
  if (parts.at(-1) === 'key') return true
  if (parts.some((word) => SECRET_WORDS.has(word))) return true
  return /pass(word|wd)/i.test(name)
}

/** An environment with the values of its secrets' variables redacted, for the log. */
export function redactEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const redacted: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) redacted[name] = isSecretName(name) ? REDACTED : value
  }
  return redacted
}

/** `text` cut to `length` characters, saying how much more there was. */
export function excerpt(text: string, length: number = EXCERPT_LENGTH): string {
  if (text.length <= length) return text
  return `${text.slice(0, length)}… (${String(text.length - length)} more characters)`
}

/** A value as the log keeps it: JSON-safe, with errors spelled out, secrets redacted and long strings cut. */
function clean(value: unknown, depth: number, seen: Set<object>): unknown {
  if (typeof value === 'string') return excerpt(value, MAX_STRING_LENGTH)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function' || typeof value === 'symbol') return String(value)
  if (typeof value !== 'object' || value === null) return value
  if (seen.has(value)) return '[circular]'
  if (depth >= MAX_DEPTH) return '[too deep]'
  seen.add(value)
  try {
    if (value instanceof Error) return cleanError(value, depth, seen)
    if (value instanceof Date) return value.toISOString()
    if (Array.isArray(value)) return value.map((item) => clean(item, depth + 1, seen))
    return cleanObject(value as Record<string, unknown>, depth, seen)
  } finally {
    seen.delete(value)
  }
}

function cleanObject(value: Readonly<Record<string, unknown>>, depth: number, seen: Set<object>): object {
  const cleaned: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    cleaned[key] = isSecretName(key) ? REDACTED : clean(item, depth + 1, seen)
  }
  return cleaned
}

/** An error's name, message, stack, and any code and cause it has. */
function cleanError(error: Error, depth: number, seen: Set<object>): object {
  const code: unknown = Reflect.get(error, 'code')
  return {
    name: error.name,
    message: clean(error.message, depth + 1, seen),
    ...(code === undefined ? {} : { code: clean(code, depth + 1, seen) }),
    ...(error.stack === undefined ? {} : { stack: clean(error.stack, depth + 1, seen) }),
    ...(error.cause === undefined ? {} : { cause: clean(error.cause, depth + 1, seen) }),
  }
}

/** The names a record's own properties take, which its fields can't use. */
const RESERVED: ReadonlySet<string> = new Set(['time', 'level', 'scope', 'taskId', 'msg'])

/**
 * A record as a line of the log: `{"time":…,"level":…,"scope":…,"taskId":…,"msg":…,…fields}`, with no newline. A field
 * named like one of the record's own (`time`, `level`, `scope`, `msg`) is kept as `field.<name>`.
 */
export function formatRecord({ time, level, scope, message, fields }: LogRecord): string {
  const { taskId, ...rest } = fields
  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(cleanObject(rest, 0, new Set()) as LogFields)) {
    extra[RESERVED.has(key) ? `field.${key}` : key] = value
  }
  return JSON.stringify({
    time: time.toISOString(),
    level,
    scope,
    ...(taskId === undefined ? {} : { taskId: clean(taskId, 0, new Set()) }),
    msg: message,
    ...extra,
  })
}

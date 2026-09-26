/**
 * Readers that parse a database row (`unknown`, as better-sqlite3 returns it) into typed values, column by column.
 * Each throws a `RowError` naming the table and column when the row doesn't hold what the schema promises.
 */

/** A row that doesn't match the schema: a missing column, a wrong type or an unknown enum value. */
export class RowError extends Error {
  constructor(table: string, column: string, problem: string) {
    super(`${table}.${column}: ${problem}`)
    this.name = 'RowError'
  }
}

/** One row being parsed, remembering its table for error messages. */
export class Row {
  private readonly values: object

  constructor(
    private readonly table: string,
    row: unknown,
  ) {
    if (typeof row !== 'object' || row === null) throw new RowError(table, '*', 'expected a row object')
    this.values = row
  }

  private value(column: string): unknown {
    if (!(column in this.values)) throw new RowError(this.table, column, 'missing')
    const value: unknown = Reflect.get(this.values, column)
    return value
  }

  private fail(column: string, expected: string, value: unknown): never {
    const shown = typeof value === 'bigint' ? `${String(value)}n` : JSON.stringify(value)
    throw new RowError(this.table, column, `expected ${expected}, got ${shown}`)
  }

  text(column: string): string {
    const value = this.value(column)
    return typeof value === 'string' ? value : this.fail(column, 'text', value)
  }

  nullableText(column: string): string | null {
    return this.value(column) === null ? null : this.text(column)
  }

  integer(column: string): number {
    const value = this.value(column)
    return Number.isSafeInteger(value) && typeof value === 'number' ? value : this.fail(column, 'an integer', value)
  }

  /** Any finite number, such as FTS5's rank. */
  real(column: string): number {
    const value = this.value(column)
    return typeof value === 'number' && Number.isFinite(value) ? value : this.fail(column, 'a number', value)
  }

  nullableReal(column: string): number | null {
    return this.value(column) === null ? null : this.real(column)
  }

  nullableInteger(column: string): number | null {
    return this.value(column) === null ? null : this.integer(column)
  }

  /** Bytes stored as a BLOB, which better-sqlite3 reads as a `Buffer`. */
  blob(column: string): Buffer {
    const value = this.value(column)
    return Buffer.isBuffer(value) ? value : this.fail(column, 'a blob', value)
  }

  /** A 0/1 integer as a boolean. */
  flag(column: string): boolean {
    const value = this.value(column)
    if (value === 0) return false
    if (value === 1) return true
    return this.fail(column, '0 or 1', value)
  }

  /** One of a string enum's values, e.g. `row.oneOf('state', Object.values(TaskState))`. */
  oneOf<T extends string>(column: string, values: readonly T[]): T {
    const value = this.value(column)
    return values.find((candidate) => candidate === value) ?? this.fail(column, `one of ${values.join(', ')}`, value)
  }

  /** Any JSON value stored as text, unparsed beyond JSON: the caller checks its shape. */
  json(column: string): unknown {
    const text = this.text(column)
    try {
      return JSON.parse(text) as unknown
    } catch {
      return this.fail(column, 'JSON', text)
    }
  }

  /** A JSON object stored as text. */
  jsonObject(column: string): Readonly<Record<string, unknown>> {
    const parsed = this.json(column)
    return isRecord(parsed) ? parsed : this.fail(column, 'a JSON object', parsed)
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

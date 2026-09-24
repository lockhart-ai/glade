import type { Migration } from '../migrate'
import { schemaVersionMigration } from './0001-schema-version'

/** Every migration, in version order. Append new ones; never edit or reorder shipped ones. */
export const MIGRATIONS: readonly Migration[] = [schemaVersionMigration]

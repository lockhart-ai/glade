/**
 * A fingerprint of one of Glade's own tools — its name, its description and its input schema — so a session can be
 * told when one it already knows has changed since it last saw it (#709). Claude Code keeps a resumed session's
 * deferred-tool schemas from before the resume (see the spike in the PR), so a tool call still reaches the live,
 * current server, but the model's own view of what it takes can be stale; this is what catches that.
 *
 * A tool's signature comes straight from the same name, description and zod shape its server is built from
 * (`./glade-tools`, `./managed-backend`, `../control/tools`), not a separately hand-kept list: add a tool to one of
 * those and it's covered here too, nothing else to remember.
 */
import { createHash } from 'node:crypto'
import { z, type ZodRawShape } from 'zod'

/** A tool as this fingerprints it: what the model is told about it. */
export interface ToolSignature {
  readonly name: string
  readonly description: string
  /** Its input schema, as JSON Schema (what the model actually sees), not the zod shape itself. */
  readonly inputSchema: Readonly<Record<string, unknown>>
}

/** A zod shape's JSON Schema, the same form `ToolSignature.inputSchema` takes. */
export function jsonSchemaOfShape(shape: ZodRawShape): Readonly<Record<string, unknown>> {
  return z.toJSONSchema(z.object(shape))
}

/** The fingerprint of one tool: changes if, and only if, its name, description or input schema does. */
export function toolFingerprint({ name, description, inputSchema }: ToolSignature): string {
  return createHash('sha256').update(JSON.stringify({ name, description, inputSchema })).digest('hex')
}

/** The fingerprint of every tool in `signatures`, by name. */
export function toolFingerprints(signatures: readonly ToolSignature[]): ReadonlyMap<string, string> {
  return new Map(signatures.map((signature) => [signature.name, toolFingerprint(signature)]))
}

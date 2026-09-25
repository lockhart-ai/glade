// Checks the packaged app can start Claude Code: its native binary must be a real, executable file in
// app.asar.unpacked (where src/main/agent/sdk-backend.ts points the SDK), not only inside app.asar, which can't be
// spawned. Run after `npm run package`: `node scripts/check-packaged-claude.mjs [path/to/Glade.app]`.
import { execFileSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'

const app = process.argv[2] ?? 'release/mac-arm64/Glade.app'
const binary = join(
  app,
  'Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
)

try {
  accessSync(binary, constants.X_OK)
  const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim()
  console.log(`Claude Code is unpacked and runs: ${version}`)
} catch (error) {
  console.error(`The packaged app can't run Claude Code at ${binary}:`, error)
  process.exit(1)
}

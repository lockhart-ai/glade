#!/usr/bin/env node
// Makes node-pty's prebuilt spawn-helpers executable, after `npm install`. node-pty 1.1.0 publishes them without the
// execute bit (its 1.2.0 betas have it), and without it every shell fails to start with "posix_spawnp failed". Does
// nothing when node-pty isn't installed.
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const prebuilds = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'node-pty', 'prebuilds')
if (existsSync(prebuilds)) {
  for (const platform of readdirSync(prebuilds)) {
    const helper = join(prebuilds, platform, 'spawn-helper')
    if (existsSync(helper)) chmodSync(helper, 0o755)
  }
}

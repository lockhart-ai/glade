// Opened from Finder or the Dock, the app has launchd's bare PATH; its agents run in the login shell's environment
// instead (#161). The app is launched with that PATH and a fake login shell: a `/bin/sh` script standing in for `$SHELL`
// and its profile, never the machine's own.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentEnvs, expect, test, type Glade } from './fixtures'
import { chat, firstRun, inputBar, taskList } from './selectors'

/** launchd's PATH: what an app opened from Finder or the Dock starts with. */
const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

/** Writes an executable login shell running `profile` first, then the command it's given. Returns its path. */
function loginShell(folder: string, profile: string): string {
  const path = join(folder, 'login-shell')
  writeFileSync(path, `#!/bin/sh\n${profile}\nexec /bin/sh -c "$2"\n`)
  chmodSync(path, 0o755)
  return path
}

/** Opens a workspace, starts a task and sends it a message, then waits for the scripted agent's reply. */
async function sendAndWaitForReply({ window }: Glade): Promise<void> {
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  const bar = inputBar(window)
  await bar.field.fill('Which node is on my PATH?')
  await bar.field.press('Enter')
  await expect(chat(window).agentReplies).toHaveCount(1)
}

test("the agent runs with the login shell's PATH when the app starts with launchd's bare one", async ({
  launch,
  tempFolder,
}) => {
  const folder = tempFolder()
  const root = join(folder, 'acme-api')
  mkdirSync(root)
  const shell = loginShell(folder, `echo 'Welcome back!'\nexport PATH="/opt/sample/bin:$PATH"`)
  const glade = await launch({
    agentScript: 'simple-reply',
    chosenFolder: root,
    loginShell: shell,
    env: { PATH: LAUNCHD_PATH },
  })

  await sendAndWaitForReply(glade)

  const { sessions } = await agentEnvs(glade)
  expect(sessions).toHaveLength(1)
  expect(sessions[0]?.PATH).toBe(`/opt/sample/bin:${LAUNCHD_PATH}`)
})

test("the agent still runs, on the app's own environment, when the login shell is broken", async ({
  launch,
  tempFolder,
}) => {
  const folder = tempFolder()
  const root = join(folder, 'acme-api')
  mkdirSync(root)
  const shell = loginShell(folder, `echo 'zsh: command not found: nvm' >&2\nexit 1`)
  const glade = await launch({
    agentScript: 'simple-reply',
    chosenFolder: root,
    loginShell: shell,
    env: { PATH: LAUNCHD_PATH },
  })

  await sendAndWaitForReply(glade)

  const { sessions } = await agentEnvs(glade)
  expect(sessions).toHaveLength(1)
  expect(sessions[0]?.PATH).toBe(LAUNCHD_PATH)
})

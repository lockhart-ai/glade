import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { E2E_WINDOW_SIZE } from '../src/main/e2e'
import { expect, holdCommand, test } from './fixtures'
import { CommandName } from '../src/shared/bridge'
import { openRouterChoiceId, type OpenRouterChoice } from '../src/shared/openrouter'
import { chooseMenuItem } from './menu'
import { agentsTab, chat, firstRun, inputBar, pauseBanner, regions, settings, taskList, taskPanel } from './selectors'
import { boxOf, MIN_WINDOW, resize } from './window-layout'
import { inMain } from './in-main'

test('curates an OpenRouter route, monitors key usage and preserves Glade chat and log history across a relaunch', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ agentScript: 'simple-reply', chosenFolder: root })
  const { window } = glade
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  const bar = inputBar(window)
  await bar.field.fill('Add a Retry-After header.')
  await bar.field.press('Enter')
  await expect(chat(window).agentReplies.first()).toContainText('The client retries idempotent requests')
  const original = await chat(window).agentReplies.first().getByRole('paragraph').first().innerText()
  await chooseMenuItem(glade, 'Glade', 'Settings…')
  const modal = settings(window)
  const loading = await holdCommand(glade, CommandName.OpenRouterStatus)
  await modal.section('Models').click()
  await loading.reached()
  await expect(modal.dialog.getByText('Loading models…')).toBeVisible()
  await expect(modal.dialog.getByLabel('OpenRouter API key')).toHaveCount(0)
  await loading.release()
  await modal.dialog.getByLabel('OpenRouter API key').fill('invalid')
  await modal.dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(modal.dialog.getByRole('alert')).toContainText('OpenRouter returned 401')
  await modal.dialog.getByLabel('OpenRouter API key').fill('fixture-key')
  await modal.dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(modal.dialog.getByText('Sample Flash', { exact: true })).toBeVisible()
  await modal.dialog.getByRole('button', { name: 'Provider for Sample Flash: Select provider' }).click()
  await window.getByRole('menuitemradio', { name: 'Sample Host', exact: true }).click()
  await modal.dialog.getByRole('checkbox', { name: 'Enable Sample Flash' }).click()
  await expect(modal.dialog.getByText('Selected · 1')).toBeVisible()
  await modal.dialog.getByRole('button', { name: 'Filter providers: All providers' }).click()
  await window.getByRole('menuitemradio', { name: 'Sample Host', exact: true }).click()
  await expect(modal.dialog.getByText('Sample Flash', { exact: true })).toBeVisible()
  await modal.dialog.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(modal.dialog.getByRole('button', { name: 'Filter providers: All providers' })).toBeVisible()
  const media = process.env.GLADE_OPENROUTER_MEDIA_DIR
  if (media !== undefined) {
    mkdirSync(media, { recursive: true })
    await modal.dialog.screenshot({ path: join(media, 'settings-models.png') })
  }
  await modal.close.click()
  const usage = window.getByRole('button', { name: 'OpenRouter usage' })
  await expect(usage).toContainText('$8.00')
  await usage.click()
  const usageDialog = window.getByRole('dialog', { name: 'OpenRouter usage' })
  await expect(usageDialog.getByRole('group', { name: 'Today · UTC' })).toContainText('$0.25')
  await expect(usageDialog.getByRole('group', { name: 'This month · UTC' })).toContainText('$12.00')
  await expect(usageDialog.getByRole('group', { name: 'Key spending limit' })).toContainText('monthly reset')
  await usageDialog.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(usageDialog.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled()
  if (media !== undefined) await usageDialog.screenshot({ path: join(media, 'openrouter-usage.png') })
  await usageDialog.press('Escape')
  await bar.field.fill('Keep this draft during the switch.')
  await bar.setting('Model').click()
  await expect(bar.options('Model')).toHaveText([
    'Default (recommended)',
    'Sonnet',
    'Haiku',
    'Sample Flash · Sample Host',
  ])
  const switching = await holdCommand(glade, CommandName.TasksUpdate)
  await bar.option('Sample Flash · Sample Host').click()
  await switching.reached()
  await expect(bar.setting('Model')).toHaveAccessibleName('Model: Switching…')
  await expect(bar.setting('Model')).toBeDisabled()
  if (media !== undefined) await regions(window).inputBar.screenshot({ path: join(media, 'model-switch-pending.png') })
  await switching.release()
  await expect(bar.setting('Model')).toHaveAccessibleName('Model: Sample Flash · Sample Host')
  await expect(bar.field).toHaveValue('Keep this draft during the switch.')
  await expect(window.getByRole('button', { name: 'Subagents', exact: true })).toHaveCount(0)
  await resize(glade, MIN_WINDOW.width, MIN_WINDOW.height)
  const row = regions(window).inputBar.getByTestId('context-meter-slot').locator('..')
  expect(await row.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  for (const name of ['Model', 'Permissions'] as const) {
    await expect(bar.setting(name)).toBeInViewport({ ratio: 1 })
  }
  if (media !== undefined) await regions(window).inputBar.screenshot({ path: join(media, 'narrow-model-pickers.png') })
  await resize(glade, E2E_WINDOW_SIZE.width, E2E_WINDOW_SIZE.height)
  await expect(chat(window).agentReplies.first().getByRole('paragraph').first()).toHaveText(original)
  await taskPanel(window).tab('Agents').click()
  await expect(taskPanel(window).log).toContainText('Switched model to Sample Flash · Sample Host (OpenRouter)')
  if (media !== undefined) await regions(window).task.screenshot({ path: join(media, 'task-model-switch.png') })
  await bar.field.fill('Continue with the same context.')
  await bar.field.press('Enter')
  await expect(chat(window).agentReplies).toHaveCount(2)
  await expect(chat(window).agentReplies.first().getByRole('paragraph').first()).toHaveText(original)
  await glade.close()
  const again = await launch({ agentScript: 'simple-reply' })
  await expect(again.window.getByRole('button', { name: 'OpenRouter usage' })).toContainText('$8.00')
  await expect(inputBar(again.window).setting('Model')).toHaveAccessibleName('Model: Sample Flash · Sample Host')
  await expect(chat(again.window).agentReplies).toHaveCount(2)
  await taskPanel(again.window).tab('Agents').click()
  await expect(taskPanel(again.window).log).toContainText('Switched model to Sample Flash · Sample Host (OpenRouter)')
  await inputBar(again.window).setting('Model').click()
  await inputBar(again.window).option('Haiku').click()
  await expect(inputBar(again.window).setting('Model')).toHaveAccessibleName('Model: Haiku')
  await expect(taskPanel(again.window).log).toContainText('Switched model to Haiku')
  await expect(chat(again.window).agentReplies).toHaveCount(2)
  await chooseMenuItem(again, 'Glade', 'Settings…')
  const reopened = settings(again.window)
  await reopened.section('Models').click()
  await reopened.dialog.getByRole('button', { name: 'Remove', exact: true }).click()
  await reopened.close.click()
  await expect(again.window.getByRole('button', { name: 'OpenRouter usage' })).toHaveCount(0)
})

test('keeps a credit failure visible in the usage meter after relaunch and metadata refresh', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ chosenFolder: root })
  await firstRun(glade.window).openFolder.click()
  await chooseMenuItem(glade, 'Glade', 'Settings…')
  const modal = settings(glade.window)
  await modal.section('Models').click()
  await modal.dialog.getByLabel('OpenRouter API key').fill('fixture-key')
  await modal.dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(modal.dialog.getByText('Sample Flash', { exact: true })).toBeVisible()
  const data = await inMain(glade.app, ({ app }) => app.getPath('userData'))
  await glade.close()
  // Reopen with the persisted status that the relay's 402 handler writes; refresh still succeeds independently.
  const db = new Database(join(data, 'glade.db'))
  db.prepare('UPDATE openrouter_usage SET error = ?').run(
    'OpenRouter requests are blocked: insufficient credits or the key spending limit was reached.',
  )
  db.close()
  const again = await launch()
  const usage = again.window.getByRole('button', { name: 'OpenRouter usage' })
  await expect(usage).toContainText('blocked')
  await usage.click()
  const dialog = again.window.getByRole('dialog', { name: 'OpenRouter usage' })
  await expect(dialog).toContainText('insufficient credits')
  await dialog.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled()
  await expect(usage).toContainText('blocked')
  const media = process.env.GLADE_OPENROUTER_MEDIA_DIR
  if (media !== undefined) {
    mkdirSync(media, { recursive: true })
    await again.window.screenshot({ path: join(media, 'openrouter-credit-blocked.png') })
  }
})

test('keeps the Selected rows at full height in a short dialog, with an error line showing (#599)', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ chosenFolder: root })
  await firstRun(glade.window).openFolder.click()
  await chooseMenuItem(glade, 'Glade', 'Settings…')
  const modal = settings(glade.window)
  await modal.section('Models').click()
  await modal.dialog.getByLabel('OpenRouter API key').fill('fixture-key')
  await modal.dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(modal.dialog.getByText('Sample Flash', { exact: true })).toBeVisible()
  await modal.close.click()
  const data = await inMain(glade.app, ({ app }) => app.getPath('userData'))
  await glade.close()

  // Two selected models, saved directly: each choice keeps its own copy of the model and provider it was saved
  // with (#599), so this doesn't depend on either being in the catalog the fixture key offers.
  const choices: readonly OpenRouterChoice[] = [
    {
      id: openRouterChoiceId('first/model', 'first-host'),
      model: {
        id: 'first/model',
        name: 'First Model',
        description: 'A saved choice',
        contextLength: 64_000,
        inputs: ['text'],
        parameters: ['tools'],
        inputPrice: '0.0000001',
        outputPrice: '0.0000002',
      },
      provider: { id: 'first-host', name: 'First Host' },
      enabled: true,
    },
    {
      id: openRouterChoiceId('second/model', 'second-host'),
      model: {
        id: 'second/model',
        name: 'Second Model',
        description: 'Another saved choice',
        contextLength: 32_000,
        inputs: ['text'],
        parameters: ['tools'],
        inputPrice: '0.0000003',
        outputPrice: '0.0000004',
      },
      provider: { id: 'second-host', name: 'Second Host' },
      enabled: true,
    },
  ]
  const db = new Database(join(data, 'glade.db'))
  for (const choice of choices)
    db.prepare('INSERT OR REPLACE INTO openrouter_choices VALUES (?, ?)').run(choice.id, JSON.stringify(choice))
  db.close()

  const again = await launch()
  await resize(again, MIN_WINDOW.width, MIN_WINDOW.height)
  await chooseMenuItem(again, 'Glade', 'Settings…')
  const reopened = settings(again.window)
  await reopened.section('Models').click()
  await expect(reopened.dialog.getByText('Selected · 2')).toBeVisible()

  // The error line that the reported screenshot showed, from a Replace key that fails.
  await reopened.dialog.getByRole('button', { name: 'Replace key', exact: true }).click()
  await reopened.dialog.getByLabel('OpenRouter API key').fill('invalid')
  await reopened.dialog.getByRole('button', { name: 'Save key', exact: true }).click()
  await expect(reopened.dialog.getByRole('alert')).toContainText('OpenRouter returned 401')

  const media = process.env.GLADE_OPENROUTER_MEDIA_DIR
  if (media !== undefined) {
    mkdirSync(media, { recursive: true })
    await reopened.dialog.screenshot({ path: join(media, 'models-selected-short-window.png') })
  }

  // Both Selected rows show at full height: a flex item with overflow: auto otherwise gets an automatic minimum
  // height of 0, so the short dialog (the error line above, a window at its minimum size) could squeeze the
  // Selected list to a sliver instead of the catalog below it giving up room.
  const selectedList = reopened.dialog.getByRole('list', { name: 'Selected models' })
  const firstRow = reopened.dialog.getByRole('checkbox', { name: 'Enable First Model' })
  const secondRow = reopened.dialog.getByRole('checkbox', { name: 'Enable Second Model' })
  await expect(firstRow).toBeVisible()
  await expect(secondRow).toBeVisible()
  const listBox = await boxOf(selectedList)
  const firstBox = await boxOf(firstRow.locator('xpath=..'))
  const secondBox = await boxOf(secondRow.locator('xpath=..'))
  expect(listBox.height).toBeGreaterThan(60)
  expect(firstBox.height).toBeGreaterThan(20)
  expect(secondBox.height).toBeGreaterThan(20)
  await expect(firstRow).toBeInViewport({ ratio: 1 })
  await expect(secondRow).toBeInViewport({ ratio: 1 })
})

for (const fromBanner of [false, true]) {
  test(`resumes ${fromBanner ? 'several limit-paused tasks from the banner' : 'a limit-paused task from its picker'} on OpenRouter immediately`, async ({
    launch,
    tempFolder,
  }) => {
    const root = join(tempFolder(), 'acme-api')
    mkdirSync(root)
    const glade = await launch({ agentScript: 'usage-limit-hour', chosenFolder: root })
    const { window } = glade
    await firstRun(window).openFolder.click()
    await chooseMenuItem(glade, 'Glade', 'Settings…')
    const modal = settings(window)
    await modal.section('Models').click()
    await modal.dialog.getByLabel('OpenRouter API key').fill('fixture-key')
    await modal.dialog.getByRole('button', { name: 'Connect', exact: true }).click()
    await modal.dialog.getByRole('button', { name: 'Provider for Sample Flash: Select provider' }).click()
    await window.getByRole('menuitemradio', { name: 'Sample Host', exact: true }).click()
    await modal.dialog.getByRole('checkbox', { name: 'Enable Sample Flash' }).click()
    await expect(modal.dialog.getByText('Selected · 1')).toBeVisible()
    await modal.close.click()
    for (let i = 0; i < (fromBanner ? 2 : 1); i++) {
      await taskList(window).newTask.click()
      await inputBar(window).field.fill(`Copy sample files ${String(i + 1)}.`)
      await inputBar(window).field.press('Enter')
      await expect(pauseBanner(window).banner).toContainText(
        `${String(i + 1)} ${i === 0 ? 'task is' : 'tasks are'} paused`,
      )
    }
    if (fromBanner) await pauseBanner(window).banner.getByRole('button', { name: 'Switch model', exact: true }).click()
    else await inputBar(window).setting('Model').click()
    await expect(window.getByRole('menu').getByText('OpenRouter', { exact: true })).toBeVisible()
    await window.getByRole('menuitemradio', { name: 'Sample Flash · Sample Host', exact: true }).click()
    await expect(pauseBanner(window).banner).toHaveCount(0)
    await expect(chat(window).agentReplies.last()).toContainText(
      'The copy finished: all 3,900 files are in the bucket.',
    )
    await expect(inputBar(window).setting('Model')).toHaveAccessibleName('Model: Sample Flash · Sample Host')
    await taskPanel(window).tab('Agents').click()
    await expect(taskPanel(window).log).toContainText('Switched model to Sample Flash · Sample Host (OpenRouter)')
    await inputBar(window).field.fill('Continue now.')
    await inputBar(window).field.press('Enter')
    await expect(chat(window).agentReplies).toHaveCount(2)
  })
}

for (const source of ['Claude', 'OpenRouter'] as const) {
  test(`${source} parent uses native same-source and dispatched cross-source children with their chosen models`, async ({
    launch,
    tempFolder,
  }) => {
    const root = join(tempFolder(), 'acme-mixed')
    mkdirSync(root)
    const glade = await launch({
      agentScript: source === 'Claude' ? 'mixed-models' : 'mixed-models-router',
      agentScriptsByFirstMessage: { 'Report from the routed child.': 'replies-briefly' },
      chosenFolder: root,
    })
    const { window } = glade
    await firstRun(window).openFolder.click()
    await chooseMenuItem(glade, 'Glade', 'Settings…')
    const modal = settings(window)
    await modal.section('Models').click()
    await modal.dialog.getByLabel('OpenRouter API key').fill('fixture-key')
    await modal.dialog.getByRole('button', { name: 'Connect', exact: true }).click()
    await modal.dialog.getByRole('button', { name: 'Provider for Sample Flash: Select provider' }).click()
    await window.getByRole('menuitemradio', { name: 'Sample Host', exact: true }).click()
    await modal.dialog.getByRole('checkbox', { name: 'Enable Sample Flash' }).click()
    await modal.close.click()
    await taskList(window).newTask.click()
    const bar = inputBar(window)
    if (source === 'OpenRouter') {
      await bar.setting('Model').click()
      await bar.option('Sample Flash · Sample Host').click()
    }
    await bar.field.fill('Choose the right model for each child.')
    await bar.field.press('Enter')
    await expect(chat(window).agentReplies.last()).toContainText('Both children finished on their selected models.')
    await taskPanel(window).tab('Agents').click()
    const agents = agentsTab(window)
    await expect(agents.tabs).toHaveCount(3)
    await agents.tab('Check the sample file').click()
    await expect(agents.line).toContainText('Sample Flash · Sample Host')
    await expect(agents.line).toContainText('Done')
    await expect(agents.list).toContainText('Here is a first draft of the release notes.')
    const media = process.env.GLADE_OPENROUTER_MEDIA_DIR
    if (media !== undefined && source === 'Claude') {
      mkdirSync(media, { recursive: true })
      await regions(window).task.screenshot({ path: join(media, `mixed-${source.toLowerCase()}-parent.png`) })
    }
    await agents.tab('Review the sample test').click()
    await expect(agents.line).toContainText('Haiku')
    await expect(agents.line).toContainText('Done')
    if (media !== undefined && source === 'OpenRouter') {
      mkdirSync(media, { recursive: true })
      await regions(window).task.screenshot({ path: join(media, 'mixed-openrouter-parent.png') })
    }
    await expect(chat(window).agentReplies).toHaveCount(1)
  })
}

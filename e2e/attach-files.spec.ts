// Attaching any file (#396): dropped onto the input bar, or pasted from Finder, a file is copied into the workspace and
// shown as a chip; the agent gets its path, the chat keeps the chip, and the draft, the queue and a relaunch keep it.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentReceived, expect, test } from './fixtures'
import { dropFiles, dropPicked, filesOnDisk, pasteFiles } from './drop'
import { chat, contextMenu, deleteTaskDialog, filesTab, firstRun, inputBar, taskList, toasts } from './selectors'

/** A message's text content, as the agent got it. */
function textSent(content: unknown): string {
  if (typeof content === 'string') return content
  return (content as { type: string; text?: string }[]).find(({ type }) => type === 'text')?.text ?? ''
}

/** Made-up files on a made-up Desktop, as Finder would hand them over. */
function desktopFiles(folder: string): Record<'sales' | 'policy' | 'latest' | 'reports', string> {
  const desktop = join(folder, 'Desktop')
  mkdirSync(desktop, { recursive: true })
  // A file for now, which the test turns into a folder once it's picked up (a file input takes no folders).
  writeFileSync(join(desktop, 'reports'), '')
  const sales = join(desktop, 'sales.csv')
  writeFileSync(sales, 'region,quarter,total\nnorth,Q3,1200\nsouth,Q3,840\n')
  const policy = join(desktop, 'retention-policy.pdf')
  writeFileSync(policy, Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n', 'latin1'))
  const latest = join(desktop, 'latest.csv')
  symlinkSync(sales, latest)
  return { sales, policy, latest, reports: join(desktop, 'reports') }
}

test('attaching files: dropped or pasted, each is copied into the workspace, sent as a path, and kept in the chat', async ({
  launch,
  tempFolder,
}) => {
  const folder = tempFolder()
  const root = join(folder, 'acme-api')
  mkdirSync(root)
  const files = desktopFiles(folder)
  const glade = await launch({ agentScript: 'simple-reply', chosenFolder: root })
  await firstRun(glade.window).openFolder.click()
  await taskList(glade.window).newTask.click()
  const bar = inputBar(glade.window)
  await bar.field.fill('Check these against the manifest.')

  // Dropping two files attaches each as a chip, with its type and size.
  expect(await dropFiles(bar.field, [files.sales, files.policy])).toBe(true)
  await expect(bar.fileChips).toHaveCount(2)
  await expect(bar.fileChip('sales.csv')).toHaveAccessibleName('sales.csv, CSV · 48 bytes')
  await expect(bar.fileChip('retention-policy.pdf')).toContainText('PDF')

  // The copies are in the task's own folder in the workspace, byte for byte.
  const [taskFolder] = readdirSync(join(root, '.glade', 'attachments'))
  const attachments = join(root, '.glade', 'attachments', taskFolder ?? '')
  expect(readFileSync(join(attachments, 'sales.csv'))).toEqual(readFileSync(files.sales))
  expect(readFileSync(join(attachments, 'retention-policy.pdf'))).toEqual(readFileSync(files.policy))

  // A folder is refused with a toast; a symlink is copied as the file it leads to; the same name again gets a new one.
  const picked = await filesOnDisk(glade.window, [files.reports])
  rmSync(files.reports)
  mkdirSync(files.reports)
  await dropPicked(bar.field, picked)
  await expect(toasts(glade.window).saying('reports is a folder: only files can be attached for now.')).toBeVisible()
  expect(await pasteFiles(bar.field, [files.latest, files.sales])).toBe(false)
  await expect(bar.fileChips).toHaveCount(4)
  await expect(bar.fileChip('sales (2).csv')).toBeVisible()
  expect(readFileSync(join(attachments, 'latest.csv'), 'utf8')).toBe(readFileSync(files.sales, 'utf8'))
  await expect(bar.field).toHaveValue('Check these against the manifest.')

  // ✕ takes one off, and its copy goes with it.
  await bar.removeFile('latest.csv').click()
  await expect(bar.fileChips).toHaveCount(3)
  await expect.poll(() => existsSync(join(attachments, 'latest.csv'))).toBe(false)

  // Sent: the chat keeps a chip per file, and the agent gets a line with each one's path, never its contents.
  await bar.field.press('Enter')
  const conversation = chat(glade.window)
  await expect(conversation.userMessages).toHaveCount(1)
  await expect(conversation.fileChips).toHaveCount(3)
  await expect(conversation.fileChips.first()).toHaveAccessibleName('sales.csv, CSV · 48 bytes')
  await expect(bar.fileChips).toHaveCount(0)
  const [sent] = await agentReceived(glade)
  const text = textSent(sent)
  expect(text).toMatch(
    /^Check these against the manifest\.\n\nAttached file: sales\.csv \(48 bytes\) at \.glade\/attachments\//,
  )
  expect(text.split('\n').filter((line) => line.startsWith('Attached file: '))).toEqual([
    expect.stringContaining('sales.csv (48 bytes) at .glade/attachments/'),
    expect.stringContaining('retention-policy.pdf ('),
    expect.stringContaining('sales (2).csv (48 bytes) at .glade/attachments/'),
  ])
  expect(text).not.toContain('north,Q3')
  await expect(conversation.agentReplies.first()).toBeVisible()

  // A text file's chip opens it in the Files tab.
  await conversation.fileChips.first().click()
  await expect(filesTab(glade.window).tab('sales.csv')).toHaveAttribute('aria-pressed', 'true')

  // A draft keeps its files across a relaunch.
  await dropFiles(bar.field, [files.sales])
  await expect(bar.fileChips).toHaveCount(1)
  await glade.close()
  const relaunched = await launch()
  const again = inputBar(relaunched.window)
  await expect(again.fileChip('sales (3).csv')).toBeVisible()
  // And the chat keeps the sent message's chips.
  await expect(chat(relaunched.window).fileChips).toHaveCount(3)

  // Deleting the task deletes its attached files.
  const list = taskList(relaunched.window)
  await list.rows('Active').first().click({ button: 'right' })
  await contextMenu(relaunched.window, 'Task actions').item('Delete task…').click()
  await deleteTaskDialog(relaunched.window).confirm.click()
  await expect.poll(() => existsSync(attachments)).toBe(false)
})

test('attaching files: a message queued while the agent works keeps its files until the agent gets them', async ({
  launch,
  tempFolder,
}) => {
  const folder = tempFolder()
  const root = join(folder, 'acme-api')
  mkdirSync(root)
  const files = desktopFiles(folder)
  const glade = await launch({ agentScript: 'long-running', chosenFolder: root })
  await firstRun(glade.window).openFolder.click()
  await taskList(glade.window).newTask.click()
  const bar = inputBar(glade.window)
  await bar.field.fill('Run the e2e suite.')
  await bar.field.press('Enter')
  await expect(bar.stop).toBeVisible()

  await dropFiles(bar.field, [files.sales])
  await expect(bar.fileChips).toHaveCount(1)
  await bar.queue.click()

  await expect(bar.queuedRows).toHaveCount(1)
  await expect(bar.queuedFile(1, 'sales.csv')).toBeVisible()
  await expect(bar.fileChips).toHaveCount(0)
})

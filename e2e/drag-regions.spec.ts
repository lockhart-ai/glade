// The window's drag regions (the top edge and the traffic lights' strips) hold still while a panel slides (#358).
// Electron sends macOS the window's drag regions again each time one moves or resizes; with the task card's strip
// following the sidebar or the right panel frame by frame, the slide dropped to about 1 fps on screen. These specs count
// the updates Electron's own draggable-region debugger logs (ELECTRON_DEBUG_DRAGGABLE_REGIONS) as each panel slides:
// one or two as it starts and lands are fine, one a frame is the bug. The hidden window paints every frame, so a slide
// that moved a region would log a dozen or more.
import type { ElectronApplication, Locator } from '@playwright/test'
import { expect, seedPath, test, type Glade } from './fixtures'
import { runningAnimations } from './motion'
import { panelToggles, regions, taskHeader, taskPanel } from './selectors'

/** The most drag region updates a slide may send: as it starts, and as it lands. */
const MAX_UPDATES_PER_SLIDE = 3

/** Turns on Electron's draggable-region debugger, which logs each update the window gets. */
const DEBUG_ENV = { ELECTRON_DEBUG_DRAGGABLE_REGIONS: '1', ELECTRON_ENABLE_LOGGING: '1' }

/** The drag region updates Electron has logged since the last `take`. */
interface RegionUpdates {
  take(): number
  count(): number
}

function watchRegionUpdates(app: ElectronApplication): RegionUpdates {
  let updates = 0
  let taken = 0
  let rest = ''
  app.process().stderr?.on('data', (chunk: Buffer) => {
    const lines = (rest + chunk.toString()).split('\n')
    rest = lines.pop() ?? ''
    updates += lines.filter((line) => line.includes('[draggable-regions]') && / update #\d+/.test(line)).length
  })
  return {
    count: () => updates - taken,
    take: () => {
      const count = updates - taken
      taken = updates
      return count
    },
  }
}

/**
 * Slides a panel by clicking `button`, waits for it to land, and checks the drag regions were updated at least once
 * (so the debugger is listening) but not with every frame.
 */
async function expectStillRegions(
  { window }: Glade,
  updates: RegionUpdates,
  button: Locator,
  landed: () => Promise<void>,
): Promise<void> {
  updates.take()
  await button.click()
  await landed()
  await expect.poll(() => runningAnimations(window)).toBe(0)
  await expect.poll(() => updates.count()).toBeGreaterThan(0)
  expect(updates.take()).toBeLessThanOrEqual(MAX_UPDATES_PER_SLIDE)
}

test('drag regions: they hold still while the sidebar slides shut and open, and the right panel beside the strip', async ({
  launch,
}) => {
  const glade = await launch({ seed: seedPath('tool-log.json'), motion: true, env: DEBUG_ENV })
  const { window, app } = glade
  const { sidebar, lightsStrip, taskPanel: panel } = regions(window)
  const toggles = panelToggles(window)
  await expect(taskPanel(window).tab(/^Tool calls/)).toHaveText('Tool calls 6')
  const updates = watchRegionUpdates(app)

  // The task card's strip slides in with the task card, and only drags the window once it's there.
  await expectStillRegions(glade, updates, toggles.collapseTaskList, () => expect(sidebar).toBeHidden())
  await expect(lightsStrip).toHaveCSS('-webkit-app-region', 'drag')

  // With the sidebar collapsed, the strip reaches over to the right panel, so it resizes as the panel slides.
  await expectStillRegions(glade, updates, taskPanel(window).collapse, () => expect(panel).toBeHidden())
  await expect(lightsStrip).toHaveCSS('-webkit-app-region', 'drag')
  await expectStillRegions(glade, updates, taskHeader(window).showSidePanel, () => expect(panel).toBeVisible())
  await expect(lightsStrip).toHaveCSS('-webkit-app-region', 'drag')

  await expectStillRegions(glade, updates, toggles.showTaskList, () => expect(sidebar).toBeVisible())
  await expect(lightsStrip).toHaveCSS('-webkit-app-region', 'drag')
})

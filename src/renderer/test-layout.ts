// The layout test-setup.ts stands in for jsdom's, which lays nothing out: how tall a virtualised row and everything
// else are, for tests to work out what shows.

/** How tall a virtualised row (one with a `data-index`) is. */
export const STUB_ROW_HEIGHT = 60

/** How tall any other element is, a scroller's visible area included. */
export const STUB_VIEWPORT_HEIGHT = 600

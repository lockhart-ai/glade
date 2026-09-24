/**
 * The attribute the renderer sets on `<html>` once the page has rendered, its fonts have loaded and its store has
 * hydrated. `npm run screenshot` waits for it before capturing; nothing else reads it.
 */
export const READY_ATTRIBUTE = 'data-glade-ready'

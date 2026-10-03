// What `../evidence.spec.ts` and the Playwright run it starts (`./playwright.config.ts` on `./kept.inner.ts`) share.
// Neither can import the other: importing a file of tests adds its tests to the importer's.

/** Where the inner run writes its results and its JSON report: `../evidence.spec.ts` sets both, to a throwaway folder. */
export const INNER_OUTPUT_ENV = 'GLADE_E2E_INNER_OUTPUT'
export const INNER_REPORT_ENV = 'GLADE_E2E_INNER_REPORT'

/** The titles of the inner tests, which `../evidence.spec.ts` finds their results by. */
export const INNER_TESTS = {
  fails: 'fails with its app running',
  failsClosed: 'fails after closing its app',
  passes: 'passes',
} as const

/** The workspace each inner test opens, and the title its agent gives the task (`simple-reply` in `scripts.ts`). */
export const INNER_WORKSPACE = 'acme-api'
export const INNER_TASK_TITLE = 'Explain the retry policy'

/** How an inner test fails on purpose: `../evidence.spec.ts` checks it's this failure, and no other, that failed it. */
export const DELIBERATE_FAILURE = 'failing on purpose, to see what is kept'

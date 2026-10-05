import { faCircleDot, faFileCode, faFileImage, faFileLines } from '@fortawesome/free-regular-svg-icons'
import { faCodePullRequest, faLink, faTicket } from '@fortawesome/free-solid-svg-icons'
import { describe, expect, it } from 'vitest'
import { linkIcon, tileIcon } from './artifactIcons'

describe('tileIcon', () => {
  it('is an image, code or a page, by the file’s type', () => {
    expect(tileIcon('screens/landing.png')).toBe(faFileImage)
    expect(tileIcon('src/date.ts')).toBe(faFileCode)
    expect(tileIcon('config/site.yml')).toBe(faFileCode)
    expect(tileIcon('docs/releases/2.4.md')).toBe(faFileLines)
    // Anything it doesn't know reads as prose.
    expect(tileIcon('LICENSE')).toBe(faFileLines)
  })
})

describe('linkIcon', () => {
  it('is what the link is, from its address alone: a pull request, an issue, a ticket, or any other page', () => {
    expect(linkIcon('https://github.com/acme/api/pull/412')).toBe(faCodePullRequest)
    expect(linkIcon('https://github.com/acme/api/issues/398')).toBe(faCircleDot)
    expect(linkIcon('https://acme.atlassian.net/browse/API-123')).toBe(faTicket)
    expect(linkIcon('https://example.com/style/code-samples')).toBe(faLink)
  })
})

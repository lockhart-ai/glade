/**
 * The icon an artifact shows before its title, on its tile in the Todos tab: a file's by
 * its type, a link's by what it is.
 */
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { faCircleDot, faFileCode, faFileImage, faFileLines } from '@fortawesome/free-regular-svg-icons'
import { faCodePullRequest, faLink, faTicket } from '@fortawesome/free-solid-svg-icons'
import { LinkKind, recogniseLink } from '../../shared/artifactLinks'
import { fileTileKind, FileTileKind } from './artifactsModel'

/** The icon on a file's tile, by its type: an image, code, or prose. */
export function tileIcon(path: string): IconDefinition {
  switch (fileTileKind(path)) {
    case FileTileKind.Image:
      return faFileImage
    case FileTileKind.Code:
      return faFileCode
    case FileTileKind.Text:
      return faFileLines
  }
}

/** The icon on a link's tile, by what it is: a pull request, an issue, a ticket, or any other page. */
export function linkIcon(url: string): IconDefinition {
  const link = recogniseLink(url)
  switch (link.kind) {
    case LinkKind.PullRequest:
      return faCodePullRequest
    case LinkKind.Issue:
      return faCircleDot
    case LinkKind.Ticket:
      return faTicket
    case LinkKind.Web:
      return faLink
  }
}

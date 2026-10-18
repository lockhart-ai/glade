/**
 * What the Todos tab draws of a task's watched GitHub links (#683): an expanded link tile's state line (under its
 * title, in `LinkTile`), and the state a collapsed todo's kind row carries after its link count (`TodoHub`). What
 * each says comes from `linkWatchModel`; the views draw it, in the colours the settled screen gives (A5).
 */
import { Fragment, useMemo } from 'react'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { useShallow } from 'zustand/react/shallow'
import { faCircleDot, faComment } from '@fortawesome/free-regular-svg-icons'
import {
  faCircleCheck,
  faCircleNotch,
  faCheck,
  faCodePullRequest,
  faEllipsis,
  faXmark,
} from '@fortawesome/free-solid-svg-icons'
import { LinkKind, recogniseLink } from '../../shared/artifactLinks'
import { GithubLinkKind, GithubLinkState, type GithubLinkWatch } from '../../shared/githubWatch'
import { ChildKind, type Child } from '../../shared/todoHub'
import { Icon, IconSize } from '../components'
import { classNames } from '../components/classNames'
import { linkIcon } from '../artifacts/artifactIcons'
import { useGladeStore } from '../store/react'
import {
  collapsedGroups,
  collapsedStateItem,
  LinkTone,
  twoOrFewer,
  type LinkStateIcon,
  type LinkStateItem,
} from './linkWatchModel'
import styles from './LinkState.module.css'

/** The small icon before a state item's text, as the screen draws each. */
const ITEM_ICONS: Readonly<Record<LinkStateIcon, IconDefinition>> = {
  check: faCheck,
  cross: faXmark,
  spinner: faCircleNotch,
  dots: faEllipsis,
  comment: faComment,
}

/** The class a tone's colour goes by, as `LinkState.module.css` has them. */
function toneClass(tone: LinkTone): string | undefined {
  switch (tone) {
    case LinkTone.Open:
      return styles.open
    case LinkTone.Active:
      return styles.active
    case LinkTone.Muted:
      return styles.muted
    case LinkTone.Alert:
      return styles.alert
    case LinkTone.Faint:
      return styles.faint
  }
}

/**
 * The icon a watched GitHub link's tile and collapsed entry show: a pull request's, whatever it is; an open issue's
 * dot, or the closed one's filled check. A link with no watch yet keeps the icon it has always shown.
 */
export function githubLinkIcon(url: string, watch: GithubLinkWatch | undefined): IconDefinition {
  const link = recogniseLink(url)
  if (watch?.kind === GithubLinkKind.Issue && watch.state === GithubLinkState.Closed && link.kind === LinkKind.Issue) {
    return faCircleCheck
  }
  return linkIcon(url)
}

/**
 * The tile-icon class a watched link wears, by what the watch says it is: teal for open, blue for the merge queue,
 * slate for merged, closed or draft. Null when there is no watch, so the icon keeps the tile's own grey.
 */
export function tileIconClass(watch: GithubLinkWatch): string | undefined {
  if (watch.kind === GithubLinkKind.PullRequest && (watch.merged || watch.draft)) return toneClass(LinkTone.Muted)
  if (watch.inMergeQueue) return toneClass(LinkTone.Active)
  return watch.state === GithubLinkState.Open ? toneClass(LinkTone.Open) : toneClass(LinkTone.Muted)
}

/**
 * One item of a link's state line: its small icon (or, for a state, a dot) and its text, in its tone's colour.
 * The headline item (the state word) is medium weight; the rest of the line qualifies it.
 */
export function LinkStateItemView({ item }: { readonly item: LinkStateItem }): React.JSX.Element {
  return (
    <span className={classNames(styles.item, toneClass(item.tone), item.headline && styles.headline)}>
      {item.icon === null ? (
        <span className={styles.dot} aria-hidden="true" />
      ) : (
        <Icon icon={ITEM_ICONS[item.icon]} size={IconSize.Small} />
      )}
      {item.text}
    </span>
  )
}

/**
 * An expanded link tile's state line, the foot of its tile: the state, then its checks, its review and its comment
 * count, separated by faint middle dots.
 */
export function LinkStateLine({ items }: { readonly items: readonly LinkStateItem[] }): React.JSX.Element {
  return (
    <>
      {items.map((item, index) => (
        <Fragment key={index}>
          {index > 0 && (
            <span className={styles.sep} aria-hidden="true">
              ·
            </span>
          )}
          <LinkStateItemView item={item} />
        </Fragment>
      ))}
    </>
  )
}

/** What a collapsed todo's line says of one watched link: a state-coloured icon, its number, and the one thing. */
function CollapsedLink({ url, watch }: { readonly url: string; readonly watch: GithubLinkWatch }): React.JSX.Element {
  const item = collapsedStateItem(watch)
  const link = recogniseLink(url)
  return (
    <span className={styles.git}>
      <span className={classNames(styles.gitIcon, tileIconClass(watch))}>
        <Icon icon={githubLinkIcon(url, watch)} size={IconSize.Small} />
      </span>
      <span className={styles.number}>
        #{String(link.kind === LinkKind.PullRequest || link.kind === LinkKind.Issue ? link.number : 0)}
      </span>
      <span className={classNames(toneClass(item.tone), item.icon !== null && styles.toned)}>
        {item.icon !== null && <Icon icon={ITEM_ICONS[item.icon]} size={IconSize.Small} />}
        {item.text}
      </span>
    </span>
  )
}

/** What a collapsed todo's line says of one count per state, for a todo with more than two watched links. */
function CollapsedGroup({
  group,
}: {
  readonly group: {
    readonly tone: LinkTone
    readonly icon: LinkStateIcon | null
    readonly text: string
    readonly pullRequest: boolean
  }
}): React.JSX.Element {
  return (
    <span className={styles.git}>
      <span className={classNames(styles.gitIcon, toneClass(group.tone))}>
        <Icon icon={group.pullRequest ? faCodePullRequest : faCircleDot} size={IconSize.Small} />
      </span>
      <span className={classNames(toneClass(group.tone), group.icon !== null && styles.toned)}>
        {group.icon !== null && <Icon icon={ITEM_ICONS[group.icon]} size={IconSize.Small} />}
        {group.text}
      </span>
    </span>
  )
}

export interface LinkStateClusterProps {
  readonly taskId: string
  /** The todo's children: the GitHub links among them are what it says something of. */
  readonly list: readonly Child[]
}

/**
 * The state a collapsed todo's kind row carries after its link count (#683): for two watched links or fewer, each
 * one's number and the one thing that matters most about it; for more, one count per state (`1 failing · 2 open`).
 * Nothing for a todo with no watched link, and nothing for a link the watcher hasn't fetched yet — it shows as it
 * did before. It reads only its own links' watches, so a watch changing renders the one cluster whose link it is.
 */
export function LinkStateCluster({ taskId, list }: LinkStateClusterProps): React.JSX.Element | null {
  const urls = useMemo(() => list.flatMap(({ kind, key }) => (kind === ChildKind.Link ? [key] : [])), [list])
  const watches = useGladeStore(useShallow((state) => urls.map((url) => state.githubWatches[taskId]?.[url])))
  const watched = useMemo(() => watches.flatMap((watch) => (watch === undefined ? [] : [watch])), [watches])
  if (watched.length === 0) return null
  const entries: readonly React.JSX.Element[] = !twoOrFewer(watched)
    ? collapsedGroups(watched).map((group, index) => <CollapsedGroup group={group} key={index} />)
    : watched.map((watch) => <CollapsedLink url={watch.url} watch={watch} key={watch.url} />)
  // No separators: each entry's own fixed width does the separating (#727), as it does between the counts before
  // it. An expanded link tile's state line keeps its dots (`LinkStateLine`).
  return <span className={styles.cluster}>{entries}</span>
}

/** What the Todos tab's own small purple count of what's waiting on you says (#680; `./TodoWaitingBadge`). */

/** The badge's own text: the count, or `9+` past 9, as the switcher's "needs you" pill reads it. */
export function badgeText(count: number): string {
  return count > 9 ? '9+' : String(count)
}

/** What the badge says to a screen reader and in its tooltip: `1 todo waiting on you`, `2 todos waiting on you`. */
export function waitingLabel(count: number): string {
  return `${String(count)} todo${count === 1 ? '' : 's'} waiting on you`
}

import { useState } from 'react'
import { MIN_GITHUB_WATCH_POLL_SECONDS } from '../../shared/settings'
import { Input, Toggle } from '../components'
import { Intro, SettingRow, useSettings } from './SettingsSections'
import styles from './SettingsDialog.module.css'

/** What the interval row says when the number you typed can't be one. */
export const INTERVAL_PROBLEM = `An interval is a whole number of seconds, at least ${String(MIN_GITHUB_WATCH_POLL_SECONDS)}.`

interface IntervalFieldProps {
  seconds: number
  onChange: (seconds: number) => void
  onProblem: (problem: string | null) => void
}

/** The poll interval: typed, then saved when you press Return or leave the field. One that can't be one goes back. */
function IntervalField({ seconds, onChange, onProblem }: IntervalFieldProps): React.JSX.Element {
  const [draft, setDraft] = useState<{ seconds: number; text: string } | null>(null)
  const text = draft?.seconds === seconds ? draft.text : String(seconds)

  const commit = (): void => {
    setDraft(null)
    const trimmed = text.trim()
    const next = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN
    if (!Number.isInteger(next) || next < MIN_GITHUB_WATCH_POLL_SECONDS) {
      onProblem(trimmed === String(seconds) ? null : INTERVAL_PROBLEM)
      return
    }
    onProblem(null)
    if (next !== seconds) onChange(next)
  }

  return (
    <Input
      label="Poll interval, in seconds"
      className={styles.portField}
      inputMode="numeric"
      value={text}
      onChange={(event) => {
        setDraft({ seconds, text: event.target.value })
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit()
      }}
    />
  )
}

/**
 * Settings › GitHub watching (#682): how often Glade polls every task's linked issues and pull requests (default a
 * minute), and which of their changes wake the task. All four toggles are on by default. No mockup; built to match
 * the other sections' look.
 */
export function GithubSection(): React.JSX.Element {
  const [settings, update] = useSettings()
  const [problem, setProblem] = useState<string | null>(null)

  return (
    <>
      <Intro>
        Glade watches every issue and pull request a task has linked, with your GitHub token, and tells the task when
        something changes. Linked issues and PRs need no watcher script of their own.
      </Intro>
      <SettingRow
        name="Poll interval"
        description={
          <>
            <span>How often Glade checks every linked issue and PR.</span>
            {problem !== null && (
              <span role="alert" className={styles.warning}>
                {problem}
              </span>
            )}
          </>
        }
      >
        <IntervalField
          seconds={settings.githubWatchPollSeconds}
          onChange={(githubWatchPollSeconds) => {
            update({ githubWatchPollSeconds })
          }}
          onProblem={setProblem}
        />
      </SettingRow>
      <SettingRow name="State changes" description="Opened, closed, merged, or entered or left the merge queue.">
        <Toggle
          label="State changes"
          checked={settings.githubWatchOnStateChange}
          onChange={(githubWatchOnStateChange) => {
            update({ githubWatchOnStateChange })
          }}
        />
      </SettingRow>
      <SettingRow name="CI finishing" description="Its checks going green or red.">
        <Toggle
          label="CI finishing"
          checked={settings.githubWatchOnChecksFinished}
          onChange={(githubWatchOnChecksFinished) => {
            update({ githubWatchOnChecksFinished })
          }}
        />
      </SettingRow>
      <SettingRow name="Reviews and comments" description="A new review or comment, from anyone.">
        <Toggle
          label="Reviews and comments"
          checked={settings.githubWatchOnReviewsComments}
          onChange={(githubWatchOnReviewsComments) => {
            update({ githubWatchOnReviewsComments })
          }}
        />
      </SettingRow>
      <SettingRow name="New commits" description="Commits pushed to it since the last check.">
        <Toggle
          label="New commits"
          checked={settings.githubWatchOnNewCommits}
          onChange={(githubWatchOnNewCommits) => {
            update({ githubWatchOnNewCommits })
          }}
        />
      </SettingRow>
    </>
  )
}

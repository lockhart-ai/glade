import { useEffect, useState } from 'react'
import {
  CONTROL_SERVER_NAME,
  connectCommand,
  isControlPort,
  MAX_CONTROL_PORT,
  MIN_CONTROL_PORT,
  type ControlStatus,
} from '../../shared/control'
import { Button, ButtonSize, Input, Toggle } from '../components'
import { describeFailure } from '../store/hydrate'
import { useGladeStore } from '../store/react'
import { Intro, SettingRow, useSettings } from './SettingsSections'
import styles from './SettingsDialog.module.css'

/** What the port row says when the port you typed can't be one. */
export const PORT_PROBLEM = `A port is a whole number from ${String(MIN_CONTROL_PORT)} to ${String(MAX_CONTROL_PORT)}.`

/** What the port row says about the port in use: that it isn't the one chosen, or why there's none. */
function portNotice(status: ControlStatus): string | null {
  if (status.error !== null) return status.error
  if (status.port !== null && status.port !== status.chosenPort) {
    const chosen = String(status.chosenPort)
    return `${chosen} is in use, so Glade is listening on ${String(status.port)}. A command copied before points at ${chosen}.`
  }
  return null
}

interface PortFieldProps {
  port: number
  onChange: (port: number) => void
  onProblem: (problem: string | null) => void
}

/** The port: typed, then saved when you press Return or leave the field. One that can't be a port goes back. */
function PortField({ port, onChange, onProblem }: PortFieldProps): React.JSX.Element {
  const [draft, setDraft] = useState<{ port: number; text: string } | null>(null)
  const text = draft?.port === port ? draft.text : String(port)

  const commit = (): void => {
    setDraft(null)
    const trimmed = text.trim()
    const next = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN
    if (!isControlPort(next)) {
      onProblem(trimmed === String(port) ? null : PORT_PROBLEM)
      return
    }
    onProblem(null)
    if (next !== port) onChange(next)
  }

  return (
    <Input
      label="Port"
      className={styles.portField}
      inputMode="numeric"
      value={text}
      onChange={(event) => {
        setDraft({ port, text: event.target.value })
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit()
      }}
    />
  )
}

/**
 * Settings › Control (`docs/design/screens/21-settings-control.png`; `docs/control-api.md`, "Turning it on"): the
 * switch that lets other agents drive Glade and, while it's on, the endpoint, the command that connects Claude Code to
 * it with a Copy button, Regenerate token, the port, and a note that Glade's own tasks get the tools too.
 */
export function ControlSection(): React.JSX.Element {
  const [settings, update] = useSettings()
  const status = useGladeStore((state) => state.controlStatus)
  const loadControlStatus = useGladeStore((state) => state.loadControlStatus)
  const regenerateControlToken = useGladeStore((state) => state.regenerateControlToken)
  const copyText = useGladeStore((state) => state.copyText)
  const [error, setError] = useState<string | null>(null)
  const [portProblem, setPortProblem] = useState<string | null>(null)

  const attempt = async (action: () => Promise<void>): Promise<void> => {
    setError(null)
    try {
      await action()
    } catch (failure) {
      setError(describeFailure(failure))
    }
  }

  useEffect(() => {
    // Aborted when the section closes before main has answered.
    const closed = new AbortController()
    void (async () => {
      try {
        await loadControlStatus()
      } catch (failure) {
        if (!closed.signal.aborted) setError(describeFailure(failure))
      }
    })()
    return () => {
      closed.abort()
    }
  }, [loadControlStatus])

  const command = status?.url != null && status.token !== null ? connectCommand(status.url, status.token) : null
  const notice = status === null ? null : portNotice(status)

  return (
    <>
      <Intro>
        Other agents, like a chat in Claude Code, can list, read, create and change your tasks through Glade&apos;s MCP
        server. Changes save automatically.
      </Intro>
      <SettingRow
        name="Let agents control Glade"
        description={
          <span>
            Serve the <code className={styles.inlineCode}>{CONTROL_SERVER_NAME}</code> tools on this Mac only, behind a
            token.
          </span>
        }
      >
        <Toggle
          label="Let agents control Glade"
          checked={settings.controlEnabled}
          onChange={(controlEnabled) => {
            update({ controlEnabled })
          }}
        />
      </SettingRow>
      {settings.controlEnabled && (
        <>
          <SettingRow
            name="Endpoint"
            description={
              <span aria-label="Endpoint URL" className={styles.endpoint}>
                {status?.url ?? 'Not listening'}
              </span>
            }
          >
            {null}
          </SettingRow>
          <div className={styles.commandRow}>
            <div className={styles.commandHeader}>
              <div className={styles.rowText}>
                <span className={styles.rowName}>Connect Claude Code</span>
                <span className={styles.rowDescription}>Run this in a terminal to add Glade to Claude Code.</span>
              </div>
              <Button
                size={ButtonSize.Small}
                disabled={command === null}
                onClick={() => {
                  if (command !== null) void attempt(() => copyText(command))
                }}
              >
                Copy
              </Button>
            </div>
            {command !== null && (
              <code aria-label="Connect command" className={styles.command}>
                {command}
              </code>
            )}
          </div>
          <SettingRow
            name="Token"
            description="Anyone with it can control Glade. Regenerating stops the old one at once; copy the command again."
          >
            <Button size={ButtonSize.Small} onClick={() => void attempt(regenerateControlToken)}>
              Regenerate token
            </Button>
          </SettingRow>
          <SettingRow
            name="Port"
            description={
              <>
                <span>If it&apos;s taken, Glade tries the next nine.</span>
                {portProblem !== null && (
                  <span role="alert" className={styles.warning}>
                    {portProblem}
                  </span>
                )}
                {notice !== null && (
                  <span role="status" className={styles.warning}>
                    {notice}
                  </span>
                )}
              </>
            }
          >
            <PortField
              port={settings.controlPort}
              onChange={(controlPort) => {
                update({ controlPort })
              }}
              onProblem={setPortProblem}
            />
          </SettingRow>
          <p className={styles.note}>Glade&apos;s own tasks get these tools too, from their next session.</p>
        </>
      )}
      {error !== null && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </>
  )
}

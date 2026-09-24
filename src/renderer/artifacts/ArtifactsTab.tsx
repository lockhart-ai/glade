import { useCallback, useEffect, useState } from 'react'
import { FileInfoKind, UiStateKey, type Artifact, type EpochMs, type FileInfo } from '../../shared/domain'
import { Button, ButtonSize, ButtonVariant } from '../components'
import { classNames } from '../components/classNames'
import {
  artifactMenu,
  ContextMenu,
  useContextMenu,
  useMenuCommands,
  type ContextMenuTargetProps,
} from '../context-menus'
import { absolutePath } from '../files/FilesTab'
import { PanelTab } from '../right-panel/panelModel'
import { useGladeStore } from '../store/react'
import { describeFile } from './artifactsModel'
import styles from './ArtifactsTab.module.css'

/** What the tab shows while the agent has declared no artifacts. */
export const NO_ARTIFACTS = 'No artifacts yet.'

const NO_ARTIFACT_LIST: readonly Artifact[] = []

/** The document icon beside each artifact's title, from 10-artifacts.html. */
function FileIcon(): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  )
}

interface ArtifactCardProps {
  readonly artifact: Artifact
  readonly now: EpochMs
  /** Changes whenever the agent may have changed the file, so the card looks at it again. */
  readonly revision: number
  /** What opens its context menu: a right-click, or ⇧F10 while it (or one of its buttons) has the focus. */
  readonly menuTarget: ContextMenuTargetProps
}

/**
 * One artifact: its title, path, and its file's type, lines and age, with Open (in the Files tab), Copy (its contents)
 * and Reveal in folder. A file that isn't there any more shows muted, as missing, and can't be opened, copied or
 * revealed.
 */
function ArtifactCard({ artifact, now, revision, menuTarget }: ArtifactCardProps): React.JSX.Element {
  const { taskId, path, title } = artifact
  const fileInfo = useGladeStore((state) => state.fileInfo)
  const openFile = useGladeStore((state) => state.openFile)
  const copyFile = useGladeStore((state) => state.copyFile)
  const revealFile = useGladeStore((state) => state.revealFile)
  const setUiState = useGladeStore((state) => state.setUiState)
  const [info, setInfo] = useState<FileInfo>()
  const [looks, setLooks] = useState(0)

  // Look at the file (again) when the card shows, when the agent may have changed it, and after an action failed.
  useEffect(() => {
    let current = true
    void fileInfo(taskId, path).then(
      (next) => {
        if (current) setInfo(next)
      },
      () => {
        if (current) setInfo({ kind: FileInfoKind.Missing })
      },
    )
    return () => {
      current = false
    }
  }, [fileInfo, taskId, path, artifact.updatedAt, revision, looks])

  const lookAgain = useCallback(() => {
    setLooks((count) => count + 1)
  }, [])

  const missing = info?.kind === FileInfoKind.Missing
  const unavailable = info === undefined || missing

  const open = (): void => {
    void openFile(taskId, path).then(
      () => setUiState({ key: UiStateKey.RightPanelTab, value: PanelTab.Files }),
      lookAgain,
    )
  }

  return (
    <li className={classNames(styles.card, missing && styles.missing)} aria-label={title} {...menuTarget}>
      <div className={styles.head}>
        <span className={styles.icon}>
          <FileIcon />
        </span>
        <div className={styles.text}>
          <span className={styles.title}>{title}</span>
          <span className={styles.path}>{path}</span>
          <span className={styles.meta}>{describeFile(path, info, now)}</span>
        </div>
      </div>
      <div className={styles.actions}>
        <Button size={ButtonSize.Small} className={styles.action} disabled={unavailable} onClick={open}>
          Open
        </Button>
        <Button
          variant={ButtonVariant.Ghost}
          size={ButtonSize.Small}
          className={styles.action}
          // Only text can go on the clipboard.
          disabled={unavailable || info.kind !== FileInfoKind.Text}
          onClick={() => void copyFile(taskId, path).catch(lookAgain)}
        >
          Copy
        </Button>
        <Button
          variant={ButtonVariant.Ghost}
          size={ButtonSize.Small}
          className={styles.action}
          disabled={unavailable}
          onClick={() => void revealFile(taskId, path).catch(lookAgain)}
        >
          Reveal in folder
        </Button>
      </div>
    </li>
  )
}

export interface ArtifactsTabProps {
  readonly taskId: string
  readonly now: EpochMs
}

/**
 * The right panel's Artifacts tab (`docs/design/html/10-artifacts.html`): a card for each file the agent declared as a
 * deliverable of the task (`add_artifact`), in the order it declared them. They stay after the task is done. A card's
 * context menu has its buttons and more: Open in editor, Copy path, and Remove from artifacts, which leaves the file.
 */
export function ArtifactsTab({ taskId, now }: ArtifactsTabProps): React.JSX.Element {
  const artifacts = useGladeStore((state) => state.artifacts[taskId]) ?? NO_ARTIFACT_LIST
  // Each tool call the agent makes may change a file: the cards look at theirs again as the log grows.
  const revision = useGladeStore((state) => state.toolEvents[taskId]?.length ?? 0)
  const rootPath = useGladeStore(
    (state) => state.workspaces.find((workspace) => workspace.id === state.tasks[taskId]?.workspaceId)?.rootPath,
  )
  const showFile = useGladeStore((state) => state.showFile)
  const openInEditor = useGladeStore((state) => state.openInEditor)
  const copyFile = useGladeStore((state) => state.copyFile)
  const revealFile = useGladeStore((state) => state.revealFile)
  const removeArtifact = useGladeStore((state) => state.removeArtifact)
  const menu = useContextMenu<string>()
  const { run, copy, hints } = useMenuCommands()
  if (artifacts.length === 0) return <p className={styles.empty}>{NO_ARTIFACTS}</p>

  const entries = (path: string) =>
    artifactMenu(
      {
        open: () => {
          run(() => showFile(taskId, path))
        },
        openInEditor: () => {
          run(() => openInEditor(taskId, path))
        },
        copyContents: () => {
          run(() => copyFile(taskId, path))
        },
        copyPath: () => {
          copy(rootPath === undefined ? path : absolutePath(rootPath, path))
        },
        reveal: () => {
          run(() => revealFile(taskId, path))
        },
        remove: () => {
          run(() => removeArtifact(taskId, path))
        },
      },
      hints,
    )

  return (
    <ul className={styles.artifacts} aria-label="Artifacts">
      {artifacts.map((artifact) => (
        <ArtifactCard
          key={artifact.path}
          artifact={artifact}
          now={now}
          revision={revision}
          menuTarget={menu.targetProps(artifact.path)}
        />
      ))}
      <ContextMenu label="Artifact actions" state={menu} entries={entries} />
    </ul>
  )
}

import { createContext, useContext, type ReactNode } from 'react'
import type { ToolCallEvent } from '../../shared/domain'
import {
  ContextMenu,
  toolCallMenu,
  useContextMenu,
  useMenuCommands,
  type ContextMenuTargetProps,
  type ToolCallMenuTarget,
} from '../context-menus'
import { fileOfCall } from '../files/filesModel'
import { useGladeStore } from '../store/react'

/** What a tool call's menu acts on (`toolCallMenu`): its Bash command, its output and the file it worked on. */
export function toolCallMenuTarget(call: ToolCallEvent, rootPath: string | undefined): ToolCallMenuTarget {
  const command = call.name === 'Bash' ? call.input.command : undefined
  return {
    command: typeof command === 'string' ? command : null,
    output: call.output,
    file: rootPath === undefined ? null : fileOfCall(call, rootPath),
  }
}

/** What makes a tool call's row open its menu; nothing outside a `ToolCallMenu`. */
type ToolCallMenuTargets = (call: ToolCallEvent) => ContextMenuTargetProps | undefined

const ToolCallMenuContext = createContext<ToolCallMenuTargets>(() => undefined)

/** The props that make a tool call's row open its context menu, from the `ToolCallMenu` around it. */
export function useToolCallMenuTarget(call: ToolCallEvent): ContextMenuTargetProps | undefined {
  return useContext(ToolCallMenuContext)(call)
}

export interface ToolCallMenuProps {
  readonly taskId: string
  /** The workspace root, which Open file's path is relative to. */
  readonly rootPath: string | undefined
  readonly children: ReactNode
}

/**
 * The context menu of the tool calls inside it, one for them all: in the tool log, and in the Subagents tab's logs.
 * Copy command and Copy output put the call's command or output on the clipboard, and Open file shows its file in the
 * Files tab.
 */
export function ToolCallMenu({ taskId, rootPath, children }: ToolCallMenuProps): React.JSX.Element {
  const menu = useContextMenu<ToolCallEvent>()
  const showFile = useGladeStore((state) => state.showFile)
  const { run, copy } = useMenuCommands()
  const entries = (call: ToolCallEvent) => {
    const target = toolCallMenuTarget(call, rootPath)
    return toolCallMenu(target, {
      copyCommand: () => {
        copy(target.command ?? '')
      },
      copyOutput: () => {
        copy(target.output ?? '')
      },
      openFile: () => {
        const { file } = target
        if (file !== null) run(() => showFile(taskId, file))
      },
    })
  }
  return (
    <ToolCallMenuContext value={menu.targetProps}>
      {children}
      <ContextMenu label="Tool call actions" state={menu} entries={entries} />
    </ToolCallMenuContext>
  )
}

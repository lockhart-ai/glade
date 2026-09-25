/**
 * The `glade-control` MCP server's name and its tools' names (`docs/control-api.md`), and which of them only read: what
 * the agent runner and the permission classifier need to know of it, without the rest of the control service.
 */
import { CONTROL_SERVER_NAME } from '../../shared/control'

/** The server's name: the `glade-control` in `mcp__glade-control__list_tasks`. */
export const CONTROL_SERVER = CONTROL_SERVER_NAME

/** The tools, by the names clients call them by. */
export enum ControlToolName {
  ListWorkspaces = 'list_workspaces',
  ListTasks = 'list_tasks',
  GetTask = 'get_task',
  GetChat = 'get_chat',
  CreateTask = 'create_task',
  UpdateTask = 'update_task',
  SendMessage = 'send_message',
  StopTask = 'stop_task',
  MarkDone = 'mark_done',
  ReopenTask = 'reopen_task',
  DeleteTask = 'delete_task',
}

/**
 * Whether a tool only reads or changes something. Reads never ask for permission in the ask mode, and are rate limited
 * apart from changes.
 */
export enum ControlAccess {
  Read = 'read',
  Change = 'change',
}

/** Each tool's access. A tool missing here fails the typecheck. */
export const CONTROL_TOOL_ACCESS: Readonly<Record<ControlToolName, ControlAccess>> = {
  [ControlToolName.ListWorkspaces]: ControlAccess.Read,
  [ControlToolName.ListTasks]: ControlAccess.Read,
  [ControlToolName.GetTask]: ControlAccess.Read,
  [ControlToolName.GetChat]: ControlAccess.Read,
  [ControlToolName.CreateTask]: ControlAccess.Change,
  [ControlToolName.UpdateTask]: ControlAccess.Change,
  [ControlToolName.SendMessage]: ControlAccess.Change,
  [ControlToolName.StopTask]: ControlAccess.Change,
  [ControlToolName.MarkDone]: ControlAccess.Change,
  [ControlToolName.ReopenTask]: ControlAccess.Change,
  [ControlToolName.DeleteTask]: ControlAccess.Change,
}

const TOOL_NAMES: ReadonlySet<string> = new Set(Object.values(ControlToolName))

/** Whether `name` is one of the tools'. */
export function isControlToolName(name: string): name is ControlToolName {
  return TOOL_NAMES.has(name)
}

/** Whether `name` is a `glade-control` tool that only reads. */
export function isControlRead(name: string): boolean {
  return isControlToolName(name) && CONTROL_TOOL_ACCESS[name] === ControlAccess.Read
}

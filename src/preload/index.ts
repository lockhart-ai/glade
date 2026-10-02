import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { BRIDGE_KEY } from '../shared/bridge'
import { createBridge } from './bridge'

// The only place `ipcRenderer` is used: the renderer talks to main through `window.glade` alone. A file dropped or pasted
// into the window is named by its path on disk (`webUtils`), for main to copy it: the page never reads the disk itself.
contextBridge.exposeInMainWorld(
  BRIDGE_KEY,
  createBridge(ipcRenderer, (file) => webUtils.getPathForFile(file)),
)

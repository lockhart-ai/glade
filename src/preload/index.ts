import { contextBridge, ipcRenderer } from 'electron'
import { BRIDGE_KEY } from '../shared/bridge'
import { createBridge } from './bridge'

// The only place `ipcRenderer` is used: the renderer talks to main through `window.glade` alone.
contextBridge.exposeInMainWorld(BRIDGE_KEY, createBridge(ipcRenderer))

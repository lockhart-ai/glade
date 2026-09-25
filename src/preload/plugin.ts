import { contextBridge, ipcRenderer } from 'electron'
import { PLUGIN_BRIDGE_KEY } from '../shared/plugin-api'
import { createPluginBridge, type PluginWindow } from './plugin-bridge'

// The page's window: the preload's lib is Node's, which has no DOM.
declare const window: PluginWindow

// A plugin page's only preload. The page gets `window.glade.post`, and Glade's messages as `message` events; it can't
// reach `ipcRenderer` or anything else in Glade.
contextBridge.exposeInMainWorld(PLUGIN_BRIDGE_KEY, createPluginBridge(ipcRenderer, window))

import { contextBridge } from 'electron'
import { BRIDGE_KEY, type GladeBridge } from '../shared/bridge'

const bridge: GladeBridge = {}

contextBridge.exposeInMainWorld(BRIDGE_KEY, bridge)

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  terminal: {
    create: (options?: { cols?: number; rows?: number; cwd?: string }) =>
      ipcRenderer.invoke('terminal:create', options),
    write: (id: string, data: string) => ipcRenderer.send('terminal:write', { id, data }),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.send('terminal:resize', { id, cols, rows }),
    dispose: (id: string) => ipcRenderer.send('terminal:dispose', id),
    onData: (callback: (payload: { id: string; data: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { id: string; data: string }) =>
        callback(payload)
      ipcRenderer.on('terminal:data', listener)
      return () => ipcRenderer.removeListener('terminal:data', listener)
    },
    onExit: (callback: (payload: { id: string; exitCode: number }) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: { id: string; exitCode: number }
      ) => callback(payload)
      ipcRenderer.on('terminal:exit', listener)
      return () => ipcRenderer.removeListener('terminal:exit', listener)
    }
  },
  files: {
    list: (options?: { knownVersion?: number }) => ipcRenderer.invoke('files:list', options),
    read: (path: string) => ipcRenderer.invoke('files:read', path),
    write: (path: string, content: string) => ipcRenderer.invoke('files:write', path, content),
    getPathForFile: (file: File) => webUtils.getPathForFile(file)
  },
  review: {
    diff: () => ipcRenderer.invoke('review:diff')
  },
  workspace: {
    get: () => ipcRenderer.invoke('workspace:get'),
    openFolder: (options?: { newWindow?: boolean }) =>
      ipcRenderer.invoke('workspace:openFolder', options),
    onChanged: (callback: (payload: { root: string; version: number }) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: { root: string; version: number }
      ) => callback(payload)
      ipcRenderer.on('workspace:changed', listener)
      return () => ipcRenderer.removeListener('workspace:changed', listener)
    }
  },
  window: {
    onCommand: (callback: (command: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, command: string) => callback(command)
      ipcRenderer.on('app:command', listener)
      return () => ipcRenderer.removeListener('app:command', listener)
    },
    onFullScreen: (callback: (fullscreen: boolean) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, fullscreen: boolean) =>
        callback(fullscreen)
      ipcRenderer.on('window:fullscreen', listener)
      return () => ipcRenderer.removeListener('window:fullscreen', listener)
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}

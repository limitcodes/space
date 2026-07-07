import { contextBridge, ipcRenderer } from 'electron'
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
    list: () => ipcRenderer.invoke('files:list'),
    read: (path: string) => ipcRenderer.invoke('files:read', path)
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

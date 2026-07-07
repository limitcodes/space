import { ElectronAPI } from '@electron-toolkit/preload'

export interface TerminalApi {
  create(options?: { cols?: number; rows?: number; cwd?: string }): Promise<{
    id: string
    cwd: string
    title: string
  }>
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  dispose(id: string): void
  onData(callback: (payload: { id: string; data: string }) => void): () => void
  onExit(callback: (payload: { id: string; exitCode: number }) => void): () => void
}

export type GitStatus = 'added' | 'deleted' | 'ignored' | 'modified' | 'renamed' | 'untracked'

export type GitStatusEntry = {
  path: string
  status: GitStatus
}

export interface FilesApi {
  list(): Promise<{
    root: string
    paths: string[]
    gitStatus: GitStatusEntry[]
    truncated: boolean
  }>
  read(path: string): Promise<{
    path: string
    content: string
    size: number
    kind: 'text' | 'binary' | 'too-large' | 'directory'
  }>
}

export interface AppApi {
  terminal: TerminalApi
  files: FilesApi
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: AppApi
  }
}

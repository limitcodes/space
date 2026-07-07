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
  list(options?: { knownVersion?: number }): Promise<{
    root: string
    paths: string[] | null
    gitStatus: GitStatusEntry[]
    version: number
    truncated: boolean
    unchanged: boolean
  }>
  read(path: string): Promise<{
    path: string
    content: string
    size: number
    kind: 'text' | 'binary' | 'too-large' | 'directory'
  }>
}

export interface ReviewApi {
  diff(): Promise<{ patch: string }>
}

export interface WindowApi {
  onCommand(callback: (command: string) => void): () => void
  onFullScreen(callback: (fullscreen: boolean) => void): () => void
}

export interface WorkspaceApi {
  get(): Promise<{ root: string; version: number }>
  openFolder(options?: {
    newWindow?: boolean
  }): Promise<{ canceled: true } | { canceled: false; root: string; newWindow: boolean }>
  onChanged(callback: (payload: { root: string; version: number }) => void): () => void
}

export interface AppApi {
  terminal: TerminalApi
  files: FilesApi
  review: ReviewApi
  workspace: WorkspaceApi
  window: WindowApi
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: AppApi
  }
}

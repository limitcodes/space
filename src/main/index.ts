import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join, relative, sep } from 'path'
import os from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { opendir, readFile, stat } from 'fs/promises'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import pty from 'node-pty'

const execFileAsync = promisify(execFile)
const terminals = new Map<string, pty.IPty>()
const workspaceRoot = process.cwd()
const fileListCache = new Map<string, { paths: string[]; createdAt: number }>()
const skippedDirectoryNames = new Set([
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.vite',
  '.idea',
  '.vscode',
  'coverage',
  'dist',
  'out',
  'build'
])
const maxFilePaths = 75000
const maxTextFileBytes = 1024 * 1024

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function toTreePath(path: string): string {
  return path.split(sep).join('/')
}

function shouldSkipDirectory(name: string, parentRelativePath: string): boolean {
  if (skippedDirectoryNames.has(name)) return true
  if (parentRelativePath === 'node_modules' && name === '.cache') return true
  return false
}

type GitStatus = 'added' | 'deleted' | 'ignored' | 'modified' | 'renamed' | 'untracked'

type GitStatusEntry = {
  path: string
  status: GitStatus
}

async function getWorkspaceGitStatus(root: string): Promise<GitStatusEntry[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '--ignored', '--untracked-files=all'],
      {
        cwd: root,
        maxBuffer: 1024 * 1024 * 8
      }
    )

    const statuses: GitStatusEntry[] = []
    for (const line of stdout.split('\n')) {
      if (line.length < 4) continue
      const indexStatus = line[0]
      const worktreeStatus = line[1]
      const rawPath = line.slice(3)
      const path = rawPath.includes(' -> ')
        ? rawPath.slice(rawPath.lastIndexOf(' -> ') + 4)
        : rawPath
      const statusCode = indexStatus === ' ' ? worktreeStatus : indexStatus
      let status: GitStatus | null = null

      if (indexStatus === '?' && worktreeStatus === '?') status = 'untracked'
      else if (indexStatus === '!' && worktreeStatus === '!') status = 'ignored'
      else if (statusCode === 'A') status = 'added'
      else if (statusCode === 'D') status = 'deleted'
      else if (statusCode === 'R') status = 'renamed'
      else if (statusCode === 'M' || statusCode === 'T' || statusCode === 'U') status = 'modified'

      if (status) statuses.push({ path: toTreePath(path), status })
    }

    return statuses
  } catch {
    return []
  }
}

async function scanWorkspacePaths(root: string): Promise<string[]> {
  const cached = fileListCache.get(root)
  if (cached && Date.now() - cached.createdAt < 30_000) return cached.paths

  const paths: string[] = []
  const pendingDirectories = ['']

  while (pendingDirectories.length > 0 && paths.length < maxFilePaths) {
    const relativeDirectory = pendingDirectories.pop() ?? ''
    const absoluteDirectory = join(root, relativeDirectory)
    let directory

    try {
      directory = await opendir(absoluteDirectory)
    } catch {
      continue
    }

    for await (const entry of directory) {
      const relativePath = relativeDirectory ? join(relativeDirectory, entry.name) : entry.name
      const treePath = toTreePath(relativePath)

      if (entry.isDirectory()) {
        if (!shouldSkipDirectory(entry.name, toTreePath(relativeDirectory))) {
          pendingDirectories.push(relativePath)
        }
        continue
      }

      if (entry.isFile() || entry.isSymbolicLink()) {
        paths.push(treePath)
      }

      if (paths.length >= maxFilePaths) break
    }
  }

  paths.sort((a, b) => a.localeCompare(b))
  fileListCache.set(root, { paths, createdAt: Date.now() })
  return paths
}

function registerTerminalIpc(): void {
  ipcMain.handle(
    'terminal:create',
    (event, options?: { cols?: number; rows?: number; cwd?: string }) => {
      const id = crypto.randomUUID()
      const shellPath =
        process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : 'zsh')
      const term = pty.spawn(shellPath, [], {
        name: 'xterm-256color',
        cols: options?.cols ?? 120,
        rows: options?.rows ?? 32,
        cwd: options?.cwd || workspaceRoot,
        env: { ...process.env, TERM: 'xterm-256color' }
      })

      terminals.set(id, term)

      term.onData((data) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('terminal:data', { id, data })
        }
      })

      term.onExit(({ exitCode }) => {
        terminals.delete(id)
        if (!event.sender.isDestroyed()) {
          event.sender.send('terminal:exit', { id, exitCode })
        }
      })

      return { id, cwd: options?.cwd || workspaceRoot, title: os.userInfo().username }
    }
  )

  ipcMain.on('terminal:write', (_event, payload: { id: string; data: string }) => {
    terminals.get(payload.id)?.write(payload.data)
  })

  ipcMain.on('terminal:resize', (_event, payload: { id: string; cols: number; rows: number }) => {
    terminals.get(payload.id)?.resize(Math.max(2, payload.cols), Math.max(1, payload.rows))
  })

  ipcMain.on('terminal:dispose', (_event, id: string) => {
    const term = terminals.get(id)
    terminals.delete(id)
    term?.kill()
  })
}

function registerFileIpc(): void {
  ipcMain.handle('files:list', async () => {
    const [paths, gitStatus] = await Promise.all([
      scanWorkspacePaths(workspaceRoot),
      getWorkspaceGitStatus(workspaceRoot)
    ])
    return { root: workspaceRoot, paths, gitStatus, truncated: paths.length >= maxFilePaths }
  })

  ipcMain.handle('files:read', async (_event, path: string) => {
    const absolutePath = join(workspaceRoot, path)
    const relativePath = relative(workspaceRoot, absolutePath)

    if (relativePath.startsWith('..') || relativePath === '') {
      throw new Error('Cannot read file outside workspace')
    }

    const fileStat = await stat(absolutePath)
    if (!fileStat.isFile()) {
      return { path, content: '', size: fileStat.size, kind: 'directory' }
    }

    if (fileStat.size > maxTextFileBytes) {
      return { path, content: '', size: fileStat.size, kind: 'too-large' }
    }

    const buffer = await readFile(absolutePath)
    if (buffer.includes(0)) {
      return { path, content: '', size: fileStat.size, kind: 'binary' }
    }

    return { path, content: buffer.toString('utf8'), size: fileStat.size, kind: 'text' }
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerTerminalIpc()
  registerFileIpc()
  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  for (const term of terminals.values()) term.kill()
  terminals.clear()

  if (process.platform !== 'darwin') {
    app.quit()
  }
})

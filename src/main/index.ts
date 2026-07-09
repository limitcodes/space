import { app, shell, BrowserWindow, ipcMain, dialog, Menu } from 'electron'
import { join, relative, sep } from 'path'
import os from 'os'
import { watch, type FSWatcher } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { opendir, readFile, stat, writeFile } from 'fs/promises'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import pty from 'node-pty'

const execFileAsync = promisify(execFile)
const terminals = new Map<string, { term: pty.IPty; windowId: number }>()
const workspaces = new Map<
  number,
  {
    root: string
    paths: string[]
    version: number
    dirty: boolean
    watcher: FSWatcher | null
  }
>()
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
const appName = 'Space'
const maxFilePaths = 75000
const maxTextFileBytes = 1024 * 1024

app.setName(appName)

function createWorkspaceState(root = app.getPath('home')): {
  root: string
  paths: string[]
  version: number
  dirty: boolean
  watcher: FSWatcher | null
} {
  const state = {
    root,
    paths: [] as string[],
    version: 0,
    dirty: true,
    watcher: null as FSWatcher | null
  }
  watchWorkspace(state)
  return state
}

function watchWorkspace(state: { root: string; dirty: boolean; watcher: FSWatcher | null }): void {
  state.watcher?.close()
  state.watcher = null

  try {
    state.watcher = watch(
      state.root,
      { recursive: process.platform === 'darwin' || process.platform === 'win32' },
      () => {
        state.dirty = true
      }
    )
    state.watcher.on('error', () => {
      state.dirty = true
    })
  } catch {
    state.dirty = true
  }
}

function getWindow(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): BrowserWindow {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window) throw new Error('Window not found')
  return window
}

function getWorkspace(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): {
  root: string
  paths: string[]
  version: number
  dirty: boolean
  watcher: FSWatcher | null
} {
  const window = getWindow(event)
  let workspace = workspaces.get(window.id)
  if (!workspace) {
    workspace = createWorkspaceState()
    workspaces.set(window.id, workspace)
  }
  return workspace
}

function setWindowWorkspace(window: BrowserWindow, root: string): void {
  const previous = workspaces.get(window.id)
  previous?.watcher?.close()

  const workspace = createWorkspaceState(root)
  workspaces.set(window.id, workspace)
  window.webContents.send('workspace:changed', { root, version: workspace.version })
}

function sendAppCommand(command: string): void {
  BrowserWindow.getFocusedWindow()?.webContents.send('app:command', command)
}

function terminalFontCommandForInput(input: Electron.Input): string | null {
  if (input.type !== 'keyDown' || !(input.meta || input.control)) return null

  const key = input.key.toLowerCase()
  if (input.code === 'Equal' || input.code === 'NumpadAdd' || key === '=' || key === '+') {
    return 'terminal-font-increase'
  }
  if (input.code === 'Minus' || input.code === 'NumpadSubtract' || key === '-' || key === '_') {
    return 'terminal-font-decrease'
  }
  if (input.code === 'Digit0' || input.code === 'Numpad0' || key === '0' || key === ')') {
    return 'terminal-font-reset'
  }

  return null
}

function buildApplicationMenu(): Menu {
  const appMenu: Electron.MenuItemConstructorOptions[] =
    process.platform === 'darwin'
      ? [
          {
            label: appName,
            submenu: [
              { label: `About ${appName}`, role: 'about' },
              { type: 'separator' },
              {
                label: 'Settings…',
                accelerator: 'CommandOrControl+,',
                click: () => sendAppCommand('settings')
              },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          }
        ]
      : []

  return Menu.buildFromTemplate([
    ...appMenu,
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Folder…',
          accelerator: 'CommandOrControl+O',
          click: () => sendAppCommand('open-workspace')
        },
        {
          label: 'Open Folder in New Window…',
          accelerator: 'CommandOrControl+Shift+O',
          click: () => sendAppCommand('open-workspace-new-window')
        },
        { type: 'separator' },
        {
          label: 'New Terminal',
          accelerator: 'CommandOrControl+J',
          click: () => sendAppCommand('new-terminal')
        },
        ...(process.platform === 'darwin'
          ? []
          : ([
              { type: 'separator' },
              {
                label: 'Settings…',
                accelerator: 'CommandOrControl+,',
                click: () => sendAppCommand('settings')
              },
              { type: 'separator' },
              { role: 'quit' }
            ] as Electron.MenuItemConstructorOptions[]))
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Files',
          accelerator: 'CommandOrControl+G',
          click: () => sendAppCommand('toggle-files')
        },
        {
          label: 'Review Changes',
          accelerator: 'CommandOrControl+E',
          click: () => sendAppCommand('toggle-review')
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        {
          label: 'Reset Terminal Size',
          accelerator: 'CommandOrControl+0',
          click: () => sendAppCommand('terminal-font-reset')
        },
        {
          label: 'Increase Terminal Size',
          accelerator: 'CommandOrControl+=',
          click: () => sendAppCommand('terminal-font-increase')
        },
        {
          label: 'Decrease Terminal Size',
          accelerator: 'CommandOrControl+-',
          click: () => sendAppCommand('terminal-font-decrease')
        },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(process.platform === 'darwin'
          ? ([{ type: 'separator' }, { role: 'front' }] as Electron.MenuItemConstructorOptions[])
          : ([{ role: 'close' }] as Electron.MenuItemConstructorOptions[]))
      ]
    },
    {
      label: 'Help',
      submenu: [{ label: appName, enabled: false }]
    }
  ])
}

function createWindow(root = app.getPath('home')): void {
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    show: false,
    title: appName,
    autoHideMenuBar: process.platform !== 'darwin',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 12, y: 12 } }
      : {}),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  workspaces.set(mainWindow.id, createWorkspaceState(root))

  mainWindow.on('closed', () => {
    const workspace = workspaces.get(mainWindow.id)
    workspace?.watcher?.close()
    workspaces.delete(mainWindow.id)

    for (const [id, terminal] of terminals) {
      if (terminal.windowId !== mainWindow.id) continue
      terminals.delete(id)
      terminal.term.kill()
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault()
    mainWindow.setTitle(appName)
  })

  mainWindow.on('enter-full-screen', () => {
    mainWindow.webContents.send('window:fullscreen', true)
  })

  mainWindow.on('leave-full-screen', () => {
    mainWindow.webContents.send('window:fullscreen', false)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('before-input-event', (event, input) => {
    const command = terminalFontCommandForInput(input)
    if (!command) return

    event.preventDefault()
    mainWindow.webContents.send('app:command', command)
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

function compareTreePaths(a: string, b: string, directoryPaths: Set<string>): number {
  const aParts = a.split('/')
  const bParts = b.split('/')
  const maxLength = Math.max(aParts.length, bParts.length)

  for (let index = 0; index < maxLength; index += 1) {
    const aPart = aParts[index]
    const bPart = bParts[index]
    if (aPart === bPart) continue
    if (aPart == null) return -1
    if (bPart == null) return 1

    const parent = aParts.slice(0, index).join('/')
    const aPath = parent ? `${parent}/${aPart}` : aPart
    const bPath = parent ? `${parent}/${bPart}` : bPart
    const aIsDirectory = directoryPaths.has(aPath)
    const bIsDirectory = directoryPaths.has(bPath)

    if (aIsDirectory !== bIsDirectory) return aIsDirectory ? -1 : 1
    return aPart.localeCompare(bPart)
  }

  return 0
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

  const directoryPaths = new Set<string>()
  for (const path of paths) {
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index += 1) {
      directoryPaths.add(parts.slice(0, index).join('/'))
    }
  }

  paths.sort((a, b) => compareTreePaths(a, b, directoryPaths))
  return paths
}

function samePaths(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false
  }
  return true
}

function safeJoin(root: string, path: string): string {
  const absolutePath = join(root, path)
  const relativePath = relative(root, absolutePath)

  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || relativePath === '') {
    throw new Error('Cannot read file outside workspace')
  }

  return absolutePath
}

function registerWorkspaceIpc(): void {
  ipcMain.handle('workspace:get', (event) => {
    const workspace = getWorkspace(event)
    return { root: workspace.root, version: workspace.version }
  })

  ipcMain.handle('workspace:openFolder', async (event, options?: { newWindow?: boolean }) => {
    const window = getWindow(event)
    const workspace = getWorkspace(event)
    const result = await dialog.showOpenDialog(window, {
      defaultPath: workspace.root,
      properties: ['openDirectory']
    })

    if (result.canceled || !result.filePaths[0]) {
      return { canceled: true as const }
    }

    const root = result.filePaths[0]
    if (options?.newWindow) {
      createWindow(root)
      return { canceled: false as const, root, newWindow: true }
    }

    setWindowWorkspace(window, root)
    return { canceled: false as const, root, newWindow: false }
  })
}

function registerTerminalIpc(): void {
  ipcMain.handle(
    'terminal:create',
    (event, options?: { cols?: number; rows?: number; cwd?: string }) => {
      const window = getWindow(event)
      const workspace = getWorkspace(event)
      const id = crypto.randomUUID()
      const cwd = options?.cwd || workspace.root
      const shellPath =
        process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : 'zsh')
      const term = pty.spawn(shellPath, [], {
        name: 'xterm-256color',
        cols: options?.cols ?? 120,
        rows: options?.rows ?? 32,
        cwd,
        env: { ...process.env, TERM: 'xterm-256color' }
      })

      terminals.set(id, { term, windowId: window.id })

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

      return { id, cwd, title: os.userInfo().username }
    }
  )

  ipcMain.on('terminal:write', (_event, payload: { id: string; data: string }) => {
    terminals.get(payload.id)?.term.write(payload.data)
  })

  ipcMain.on('terminal:resize', (_event, payload: { id: string; cols: number; rows: number }) => {
    terminals.get(payload.id)?.term.resize(Math.max(2, payload.cols), Math.max(1, payload.rows))
  })

  ipcMain.on('terminal:dispose', (_event, id: string) => {
    const terminal = terminals.get(id)
    terminals.delete(id)
    terminal?.term.kill()
  })
}

function registerReviewIpc(): void {
  ipcMain.handle('review:diff', async (event) => {
    const { root } = getWorkspace(event)
    try {
      const [{ stdout: trackedDiff }, { stdout: untrackedFiles }] = await Promise.all([
        execFileAsync('git', ['diff', '--no-ext-diff', 'HEAD', '--'], {
          cwd: root,
          maxBuffer: 1024 * 1024 * 32
        }),
        execFileAsync('git', ['ls-files', '--others', '--exclude-standard'], {
          cwd: root,
          maxBuffer: 1024 * 1024 * 8
        })
      ])
      const untrackedDiffs = await Promise.all(
        untrackedFiles
          .split('\n')
          .filter(Boolean)
          .map(async (path) => {
            try {
              const { stdout } = await execFileAsync(
                'git',
                ['diff', '--no-index', '--', '/dev/null', path],
                {
                  cwd: root,
                  maxBuffer: 1024 * 1024 * 8
                }
              )
              return stdout
            } catch (error) {
              if (error && typeof error === 'object' && 'stdout' in error) {
                return String(error.stdout)
              }
              return ''
            }
          })
      )

      return { patch: [trackedDiff, ...untrackedDiffs].filter(Boolean).join('\n') }
    } catch {
      return { patch: '' }
    }
  })
}

function registerFileIpc(): void {
  ipcMain.handle('files:list', async (event, options?: { knownVersion?: number }) => {
    const workspace = getWorkspace(event)
    let pathsChanged = false

    if (workspace.dirty || workspace.paths.length === 0) {
      const paths = await scanWorkspacePaths(workspace.root)
      workspace.dirty = false

      if (!samePaths(workspace.paths, paths)) {
        workspace.paths = paths
        workspace.version += 1
        pathsChanged = true
      }
    }

    const gitStatus = await getWorkspaceGitStatus(workspace.root)
    const unchanged = options?.knownVersion === workspace.version && !pathsChanged

    return {
      root: workspace.root,
      paths: unchanged ? null : workspace.paths,
      gitStatus,
      version: workspace.version,
      truncated: workspace.paths.length >= maxFilePaths,
      unchanged
    }
  })

  ipcMain.handle('files:read', async (event, path: string) => {
    const { root } = getWorkspace(event)
    const absolutePath = safeJoin(root, path)

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

  ipcMain.handle('files:write', async (event, path: string, content: string) => {
    const { root } = getWorkspace(event)
    const absolutePath = safeJoin(root, path)
    const size = Buffer.byteLength(content, 'utf8')

    if (size > maxTextFileBytes) {
      throw new Error('File is too large to save')
    }

    await writeFile(absolutePath, content, 'utf8')
    return { path, size, kind: 'text' as const }
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.limitcodes.space')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  Menu.setApplicationMenu(buildApplicationMenu())
  registerWorkspaceIpc()
  registerTerminalIpc()
  registerFileIpc()
  registerReviewIpc()
  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  for (const terminal of terminals.values()) terminal.term.kill()
  terminals.clear()
  for (const workspace of workspaces.values()) workspace.watcher?.close()
  workspaces.clear()

  if (process.platform !== 'darwin') {
    app.quit()
  }
})

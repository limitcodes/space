import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useReducer,
  useRef,
  useState
} from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import {
  CaretDownIcon,
  CaretRightIcon,
  FileIcon,
  FolderOpenIcon,
  GitDiffIcon,
  PlusIcon,
  TerminalIcon,
  XIcon
} from '@phosphor-icons/react'
import { tinykeys } from 'tinykeys'
import { parsePatchFiles, type CodeViewItem } from '@pierre/diffs'
import { CodeView } from '@pierre/diffs/react'
import { preparePresortedFileTreeInput, type GitStatusEntry } from '@pierre/trees'
import { FileTree, useFileTree } from '@pierre/trees/react'
import remarkGfm from 'remark-gfm'

const ReactMarkdown = lazy(() => import('react-markdown'))
const maxHighlightedBytes = 300 * 1024
const maxRenderedMarkdownBytes = 500 * 1024
const highlightedLanguages = [
  'bash',
  'css',
  'html',
  'javascript',
  'json',
  'jsx',
  'markdown',
  'python',
  'rust',
  'tsx',
  'typescript',
  'yaml'
] as const

type ShikiHighlighter = {
  codeToTokens: (
    code: string,
    options: { lang: never; theme: 'github-dark-default' }
  ) => {
    tokens: HighlightedToken[][]
  }
}

let highlighterPromise: Promise<ShikiHighlighter> | null = null

function getHighlighter(): Promise<ShikiHighlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then(
      ({ createHighlighter }) =>
        createHighlighter({
          langs: [...highlightedLanguages],
          themes: ['github-dark-default']
        }) as Promise<ShikiHighlighter>
    )
  }
  return highlighterPromise
}

type AppMode = 'terminal' | 'files' | 'review'

type TerminalTab = {
  id: string
  title: string
  cwd: string
}

type TerminalRuntime = {
  term: Terminal
  fit: FitAddon
}

type FileReadResult = Awaited<ReturnType<typeof window.api.files.read>>

type FilesPanelProps = {
  paths: string[]
  selectedPath: string | null
  selectedFile: FileReadResult | null
  loading: boolean
  gitStatus: GitStatusEntry[]
  truncated: boolean
  onSelectPath: (path: string) => void
}

type ViewerMode = 'preview' | 'source'

type ReviewSummary = {
  files: number
  additions: number
  deletions: number
}

type ReviewPanelProps = {
  items: CodeViewItem[]
  loading: boolean
  summary: ReviewSummary
  onToggleItem: (id: string) => void
}

type HighlightedToken = {
  content: string
  color?: string
  fontStyle?: number
}

type ViewState = {
  mode: AppMode
  filePaths: string[]
  filesLoading: boolean
  filesTruncated: boolean
  fileGitStatus: GitStatusEntry[]
  reviewItems: CodeViewItem[]
  reviewLoading: boolean
  selectedPath: string | null
  selectedFile: FileReadResult | null
  settingsOpen: boolean
  workspaceRoot: string
}

type ViewAction =
  | { type: 'setMode'; mode: AppMode }
  | { type: 'setWorkspace'; root: string; version?: number }
  | { type: 'filesLoading'; loading: boolean }
  | {
      type: 'filesLoaded'
      root: string
      paths: string[] | null
      gitStatus: GitStatusEntry[]
      truncated: boolean
    }
  | { type: 'reviewLoading'; loading: boolean }
  | { type: 'reviewLoaded'; items: CodeViewItem[] }
  | { type: 'toggleReviewItem'; id: string }
  | { type: 'selectFile'; path: string }
  | { type: 'fileLoaded'; file: FileReadResult }
  | { type: 'setSettingsOpen'; open: boolean }

const initialViewState: ViewState = {
  mode: 'terminal',
  filePaths: [],
  filesLoading: false,
  filesTruncated: false,
  fileGitStatus: [],
  reviewItems: [],
  reviewLoading: false,
  selectedPath: null,
  selectedFile: null,
  settingsOpen: false,
  workspaceRoot: ''
}

function viewReducer(state: ViewState, action: ViewAction): ViewState {
  switch (action.type) {
    case 'setMode':
      return { ...state, mode: action.mode }
    case 'setWorkspace':
      return {
        ...state,
        mode: 'terminal',
        workspaceRoot: action.root,
        filePaths: [],
        filesLoading: false,
        filesTruncated: false,
        fileGitStatus: [],
        reviewItems: [],
        reviewLoading: false,
        settingsOpen: false,
        selectedPath: null,
        selectedFile: null
      }
    case 'filesLoading':
      return { ...state, filesLoading: action.loading }
    case 'filesLoaded':
      return {
        ...state,
        workspaceRoot: action.root,
        filePaths: action.paths ?? state.filePaths,
        fileGitStatus: action.gitStatus,
        filesTruncated: action.truncated,
        filesLoading: false
      }
    case 'reviewLoading':
      return { ...state, reviewLoading: action.loading }
    case 'reviewLoaded':
      return { ...state, reviewItems: action.items, reviewLoading: false }
    case 'toggleReviewItem':
      return {
        ...state,
        reviewItems: state.reviewItems.map((item) =>
          item.id === action.id
            ? { ...item, collapsed: !item.collapsed, version: (item.version ?? 0) + 1 }
            : item
        )
      }
    case 'selectFile':
      return { ...state, selectedPath: action.path, selectedFile: null }
    case 'fileLoaded':
      return { ...state, selectedFile: action.file }
    case 'setSettingsOpen':
      return { ...state, settingsOpen: action.open }
  }
}

function getLanguage(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  const languages: Record<string, (typeof highlightedLanguages)[number]> = {
    cjs: 'javascript',
    css: 'css',
    html: 'html',
    js: 'javascript',
    json: 'json',
    jsx: 'jsx',
    md: 'markdown',
    mjs: 'javascript',
    py: 'python',
    rs: 'rust',
    ts: 'typescript',
    tsx: 'tsx',
    yaml: 'yaml',
    yml: 'yaml'
  }
  return languages[extension] ?? 'typescript'
}

function isMarkdown(path: string): boolean {
  return /\.mdx?$/i.test(path)
}

function getWorkspaceName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}

function CodeWithLineNumbers({
  content,
  highlightedLines
}: {
  content?: string
  highlightedLines?: HighlightedToken[][]
}): React.JSX.Element {
  const plainLines = useMemo(() => content?.split('\n') ?? [], [content])
  const lines = highlightedLines ?? plainLines

  return (
    <div className="code-lines">
      {lines.map((line, index) => (
        <div className="code-line" key={index}>
          <span className="code-line-number">{index + 1}</span>
          <span className="code-line-content">
            {Array.isArray(line)
              ? line.map((token, tokenIndex) => (
                  <span
                    key={tokenIndex}
                    style={{
                      color: token.color,
                      fontStyle: token.fontStyle === 1 ? 'italic' : undefined,
                      fontWeight: token.fontStyle === 2 ? 700 : undefined
                    }}
                  >
                    {token.content}
                  </span>
                ))
              : line}
          </span>
        </div>
      ))}
    </div>
  )
}

function FilePreview({ file }: { file: FileReadResult }): React.JSX.Element {
  const [viewerMode, setViewerMode] = useState<ViewerMode>('preview')
  const [highlightState, setHighlightState] = useState<{
    lines: HighlightedToken[][] | null
    loading: boolean
    failed: boolean
  }>({ lines: null, loading: false, failed: false })
  const markdown = isMarkdown(file.path)
  const canRenderMarkdown = markdown && file.size <= maxRenderedMarkdownBytes
  const canHighlight = file.size <= maxHighlightedBytes

  useEffect(() => {
    let canceled = false
    setHighlightState({ lines: null, loading: file.kind === 'text' && canHighlight, failed: false })

    if (file.kind !== 'text' || !canHighlight) return

    void getHighlighter()
      .then((highlighter) =>
        highlighter.codeToTokens(file.content, {
          lang: getLanguage(file.path) as never,
          theme: 'github-dark-default'
        })
      )
      .then((result) => {
        if (!canceled) {
          setHighlightState({
            lines: result.tokens as HighlightedToken[][],
            loading: false,
            failed: false
          })
        }
      })
      .catch((error) => {
        console.warn('Failed to highlight file', file.path, error)
        if (!canceled) setHighlightState({ lines: null, loading: false, failed: true })
      })

    return () => {
      canceled = true
    }
  }, [canHighlight, file])

  if (file.kind === 'directory') return <div className="file-empty">{file.path}</div>
  if (file.kind === 'binary') return <div className="file-empty">Binary file</div>
  if (file.kind === 'too-large') {
    return <div className="file-empty">File is too large to preview ({file.size} bytes)</div>
  }

  return (
    <>
      <div className="file-viewer-header">
        <span className="file-viewer-path">{file.path}</span>
        {markdown ? (
          <div className="file-viewer-toggle" aria-label="Markdown view mode">
            <button
              className={viewerMode === 'preview' ? 'is-active' : ''}
              disabled={!canRenderMarkdown}
              onClick={() => setViewerMode('preview')}
              type="button"
            >
              Preview
            </button>
            <button
              className={viewerMode === 'source' ? 'is-active' : ''}
              onClick={() => setViewerMode('source')}
              type="button"
            >
              Source
            </button>
          </div>
        ) : null}
      </div>

      <div className="file-viewer-body">
        {markdown && viewerMode === 'preview' && canRenderMarkdown ? (
          <Suspense fallback={<div className="file-empty">Rendering markdown…</div>}>
            <article className="markdown-preview">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{file.content}</ReactMarkdown>
            </article>
          </Suspense>
        ) : null}

        {markdown && viewerMode === 'preview' && !canRenderMarkdown ? (
          <div className="file-empty">Markdown is too large to render. Use Source.</div>
        ) : null}

        {(!markdown || viewerMode === 'source') && highlightState.lines ? (
          <CodeWithLineNumbers highlightedLines={highlightState.lines} />
        ) : null}

        {(!markdown || viewerMode === 'source') &&
        !highlightState.lines &&
        highlightState.loading ? (
          <div className="file-empty">Highlighting…</div>
        ) : null}

        {(!markdown || viewerMode === 'source') &&
        !highlightState.lines &&
        !highlightState.loading ? (
          <CodeWithLineNumbers content={file.content} />
        ) : null}

        {highlightState.failed ? (
          <div className="file-highlight-warning">Plain text fallback</div>
        ) : null}
      </div>
    </>
  )
}

function summarizeReviewItems(items: CodeViewItem[]): ReviewSummary {
  return items.reduce(
    (summary, item) => {
      if (item.type !== 'diff') return summary

      summary.files += 1
      for (const hunk of item.fileDiff.hunks) {
        summary.additions += hunk.additionCount
        summary.deletions += hunk.deletionCount
      }
      return summary
    },
    { files: 0, additions: 0, deletions: 0 }
  )
}

function ReviewPanel({
  items,
  loading,
  summary,
  onToggleItem
}: ReviewPanelProps): React.JSX.Element {
  return (
    <section className="review-panel" aria-label="Review changes">
      <div className="review-header">
        <span>{summary.files} Changes</span>
        <span className="review-added">+{summary.additions}</span>
        <span className="review-deleted">-{summary.deletions}</span>
      </div>

      {loading ? <div className="file-empty">Loading changes…</div> : null}
      {!loading && items.length === 0 ? <div className="file-empty">No active changes</div> : null}
      {!loading && items.length > 0 ? (
        <CodeView
          items={items}
          className="review-code-view"
          options={{
            theme: { dark: 'pierre-dark', light: 'pierre-light' },
            themeType: 'dark',
            preferredHighlighter: 'shiki-js',
            diffStyle: 'split',
            stickyHeaders: true,
            layout: { paddingTop: 12, paddingBottom: 24, gap: 12 }
          }}
          renderHeaderPrefix={(item) => (
            <button
              className="review-collapse"
              onClick={() => onToggleItem(item.id)}
              type="button"
              aria-label={item.collapsed ? 'Expand file diff' : 'Collapse file diff'}
            >
              {item.collapsed ? (
                <CaretRightIcon size={14} weight="regular" />
              ) : (
                <CaretDownIcon size={14} weight="regular" />
              )}
            </button>
          )}
        />
      ) : null}
    </section>
  )
}

const keyboardShortcuts = [
  ['Cmd+,', 'Open settings'],
  ['Cmd+O', 'Change workspace in this window'],
  ['Cmd+Shift+O', 'Open workspace in new window'],
  ['Cmd+J', 'New terminal'],
  ['Cmd+G', 'Toggle files'],
  ['Cmd+E', 'Toggle review changes'],
  ['Cmd+W', 'Close active view or terminal']
] as const

function SettingsDialog({
  dialogRef,
  onClose
}: {
  dialogRef: { current: HTMLDialogElement | null }
  onClose: () => void
}): React.JSX.Element {
  return (
    <dialog
      aria-label="Settings"
      className="settings-dialog"
      onCancel={onClose}
      onClose={onClose}
      ref={dialogRef}
    >
      <header className="settings-header">
        <div>
          <h2>Settings</h2>
          <p>Space shortcuts</p>
        </div>
        <button
          className="settings-close"
          onClick={onClose}
          type="button"
          aria-label="Close settings"
        >
          <XIcon size={14} weight="regular" />
        </button>
      </header>

      <div className="settings-body">
        <h3>Keyboard Shortcuts</h3>
        <div className="shortcut-list">
          {keyboardShortcuts.map(([keys, label]) => (
            <div className="shortcut-row" key={keys}>
              <span>{label}</span>
              <kbd>{keys}</kbd>
            </div>
          ))}
        </div>
      </div>
    </dialog>
  )
}

function FilesPanel({
  paths,
  selectedPath,
  selectedFile,
  loading,
  gitStatus,
  truncated,
  onSelectPath
}: FilesPanelProps): React.JSX.Element {
  const preparedInput = useMemo(() => preparePresortedFileTreeInput(paths), [paths])
  const { model } = useFileTree({
    preparedInput,
    density: 'compact',
    icons: { set: 'standard', colored: true },
    gitStatus,
    initialVisibleRowCount: 32,
    overscan: 8,
    onSelectionChange: (selectedPaths) => {
      const nextPath = selectedPaths[0]
      if (nextPath) onSelectPath(nextPath)
    }
  })

  return (
    <section className="files-panel" aria-label="Files">
      <aside className="files-sidebar">
        <div className="files-sidebar-header">
          <span>Files</span>
          {truncated ? <span className="files-warning">truncated</span> : null}
        </div>
        <FileTree model={model} className="files-tree" />
      </aside>
      <main className="file-viewer" aria-label={selectedPath ?? 'File viewer'}>
        {loading ? <div className="file-empty">Loading files…</div> : null}
        {!loading && paths.length === 0 ? (
          <div className="file-empty">No files in workspace</div>
        ) : null}
        {!loading && paths.length > 0 && !selectedFile ? (
          <div className="file-empty">Select a file</div>
        ) : null}
        {selectedFile ? <FilePreview key={selectedFile.path} file={selectedFile} /> : null}
      </main>
    </section>
  )
}

function App(): React.JSX.Element {
  const [view, dispatchView] = useReducer(viewReducer, initialViewState)
  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const {
    mode,
    filePaths,
    filesLoading,
    filesTruncated,
    fileGitStatus,
    reviewItems,
    reviewLoading,
    selectedPath,
    selectedFile,
    workspaceRoot
  } = view
  const runtimes = useMemo(() => new Map<string, TerminalRuntime>(), [])
  const containers = useMemo(() => new Map<string, HTMLDivElement>(), [])
  const settingsDialogRef = useRef<HTMLDialogElement>(null)
  const creating = useRef(false)
  const fileListVersion = useRef<number | undefined>(undefined)
  const shortcutHandlers = useRef({
    closeActiveView: () => {},
    createTerminal: () => {},
    openSettings: () => {},
    closeSettings: () => {},
    openWorkspace: () => {},
    openWorkspaceInNewWindow: () => {},
    toggleFiles: () => {},
    toggleReview: () => {}
  })

  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeId) ?? null, [activeId, tabs])
  const reviewSummary = useMemo(() => summarizeReviewItems(reviewItems), [reviewItems])

  const fitTerminal = useCallback(
    (id: string) => {
      const runtime = runtimes.get(id)
      if (!runtime) return

      requestAnimationFrame(() => {
        runtime.fit.fit()
        window.api.terminal.resize(id, runtime.term.cols, runtime.term.rows)
      })
    },
    [runtimes]
  )

  const attachTerminal = useCallback(
    (id: string, element: HTMLDivElement | null) => {
      if (!element) {
        containers.delete(id)
        return
      }

      containers.set(id, element)
      const runtime = runtimes.get(id)
      if (!runtime || runtime.term.element) return

      runtime.term.open(element)
      fitTerminal(id)
      runtime.term.focus()
    },
    [containers, fitTerminal, runtimes]
  )

  const createTerminal = useCallback(async () => {
    if (creating.current) return
    creating.current = true

    try {
      const term = new Terminal({
        cursorBlink: true,
        cursorStyle: 'bar',
        fontFamily:
          'MesloLGS NF, Symbols Nerd Font Mono, Hack Nerd Font, JetBrainsMono Nerd Font, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        fontSize: 13,
        lineHeight: 1.2,
        convertEol: true,
        allowProposedApi: false,
        theme: {
          background: '#181818',
          foreground: '#d7d7d7',
          cursor: '#e4e4e4',
          selectionBackground: '#3a3a3a',
          black: '#181818',
          brightBlack: '#686868',
          red: '#e34671',
          green: '#3fa266',
          yellow: '#f1b467',
          blue: '#81a1c1',
          magenta: '#b48ead',
          cyan: '#82d2ce',
          white: '#e4e4e4'
        }
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.loadAddon(new WebLinksAddon())
      term.attachCustomKeyEventHandler((event) => {
        if (event.type !== 'keydown' || !(event.metaKey || event.ctrlKey)) return true

        if (event.code === 'KeyG') {
          event.preventDefault()
          shortcutHandlers.current.toggleFiles()
          return false
        }

        if (event.code === 'KeyE') {
          event.preventDefault()
          shortcutHandlers.current.toggleReview()
          return false
        }

        if (event.code === 'KeyW') {
          event.preventDefault()
          shortcutHandlers.current.closeActiveView()
          return false
        }

        if (event.code === 'KeyJ') {
          event.preventDefault()
          shortcutHandlers.current.createTerminal()
          return false
        }

        if (event.code === 'KeyO') {
          event.preventDefault()
          if (event.shiftKey) shortcutHandlers.current.openWorkspaceInNewWindow()
          else shortcutHandlers.current.openWorkspace()
          return false
        }

        if (event.code === 'Comma') {
          event.preventDefault()
          shortcutHandlers.current.openSettings()
          return false
        }

        return true
      })

      const created = await window.api.terminal.create({ cols: 120, rows: 32 })
      runtimes.set(created.id, { term, fit })

      term.onData((data) => window.api.terminal.write(created.id, data))
      term.onResize(({ cols, rows }) => window.api.terminal.resize(created.id, cols, rows))
      term.onTitleChange((title) => {
        const trimmedTitle = title.trim()
        if (!trimmedTitle) return
        setTabs((current) =>
          current.map((tab) => (tab.id === created.id ? { ...tab, title: trimmedTitle } : tab))
        )
      })

      setTabs((current) => [
        ...current,
        { id: created.id, title: `terminal ${current.length + 1}`, cwd: created.cwd }
      ])
      setActiveId(created.id)
    } finally {
      creating.current = false
    }
  }, [runtimes])

  const closeTerminal = useCallback(
    (id: string) => {
      const index = tabs.findIndex((tab) => tab.id === id)
      const runtime = runtimes.get(id)
      runtime?.term.dispose()
      runtimes.delete(id)
      containers.delete(id)
      window.api.terminal.dispose(id)

      setTabs((current) => current.filter((tab) => tab.id !== id))
      setActiveId((current) => {
        if (current !== id) return current
        const next = tabs[index + 1] ?? tabs[index - 1]
        return next?.id ?? null
      })
    },
    [containers, runtimes, tabs]
  )

  const openFiles = useCallback(async () => {
    dispatchView({ type: 'setMode', mode: 'files' })
    dispatchView({ type: 'filesLoading', loading: true })
    try {
      const result = await window.api.files.list({ knownVersion: fileListVersion.current })
      fileListVersion.current = result.version
      dispatchView({
        type: 'filesLoaded',
        root: result.root,
        paths: result.paths,
        gitStatus: result.gitStatus,
        truncated: result.truncated
      })
    } finally {
      dispatchView({ type: 'filesLoading', loading: false })
    }
  }, [])

  const toggleFiles = useCallback(() => {
    if (mode === 'files') {
      dispatchView({ type: 'setMode', mode: 'terminal' })
      return
    }

    void openFiles()
  }, [mode, openFiles])

  const openReview = useCallback(async () => {
    dispatchView({ type: 'setMode', mode: 'review' })
    dispatchView({ type: 'reviewLoading', loading: true })
    try {
      const { patch } = await window.api.review.diff()
      if (!patch.trim()) {
        dispatchView({ type: 'reviewLoaded', items: [] })
        return
      }

      const patches = parsePatchFiles(patch, `workspace-${Date.now()}`)
      dispatchView({
        type: 'reviewLoaded',
        items: patches.flatMap((parsedPatch, patchIndex) =>
          parsedPatch.files.map((fileDiff, fileIndex) => ({
            id: `diff:${patchIndex}:${fileIndex}:${fileDiff.name}`,
            type: 'diff' as const,
            fileDiff
          }))
        )
      })
    } finally {
      dispatchView({ type: 'reviewLoading', loading: false })
    }
  }, [])

  const toggleReview = useCallback(() => {
    if (mode === 'review') {
      dispatchView({ type: 'setMode', mode: 'terminal' })
      return
    }

    void openReview()
  }, [mode, openReview])

  const resetWorkspaceViews = useCallback((root: string) => {
    fileListVersion.current = undefined
    dispatchView({ type: 'setWorkspace', root })
  }, [])

  const openWorkspace = useCallback(async () => {
    const result = await window.api.workspace.openFolder()
    if (!result.canceled) {
      resetWorkspaceViews(result.root)
      void createTerminal()
    }
  }, [createTerminal, resetWorkspaceViews])

  const openWorkspaceInNewWindow = useCallback(async () => {
    await window.api.workspace.openFolder({ newWindow: true })
  }, [])

  const openSettings = useCallback(() => {
    if (settingsDialogRef.current?.open) {
      dispatchView({ type: 'setSettingsOpen', open: false })
      settingsDialogRef.current.close()
      return
    }

    dispatchView({ type: 'setSettingsOpen', open: true })
    settingsDialogRef.current?.showModal()
  }, [])

  const closeSettings = useCallback(() => {
    dispatchView({ type: 'setSettingsOpen', open: false })
    settingsDialogRef.current?.close()
  }, [])

  const toggleReviewItem = useCallback((id: string) => {
    dispatchView({ type: 'toggleReviewItem', id })
  }, [])

  const closeActiveView = useCallback(() => {
    if (mode === 'files' || mode === 'review') {
      dispatchView({ type: 'setMode', mode: 'terminal' })
      return
    }

    if (activeId) closeTerminal(activeId)
  }, [activeId, closeTerminal, mode])

  const selectFilePath = useCallback(async (path: string) => {
    dispatchView({ type: 'selectFile', path })
    const result = await window.api.files.read(path)
    dispatchView({ type: 'fileLoaded', file: result })
  }, [])

  useEffect(() => {
    shortcutHandlers.current = {
      closeActiveView,
      closeSettings,
      createTerminal,
      openSettings,
      openWorkspace,
      openWorkspaceInNewWindow,
      toggleFiles,
      toggleReview
    }
  }, [
    closeActiveView,
    closeSettings,
    createTerminal,
    openSettings,
    openWorkspace,
    openWorkspaceInNewWindow,
    toggleFiles,
    toggleReview
  ])

  useEffect(() => {
    void window.api.workspace.get().then(({ root, version }) => {
      fileListVersion.current = version
      dispatchView({ type: 'setWorkspace', root, version })
    })

    return window.api.workspace.onChanged(({ root }) => {
      resetWorkspaceViews(root)
    })
  }, [resetWorkspaceViews])

  useEffect(() => {
    void createTerminal()
  }, [createTerminal])

  useEffect(() => {
    const removeDataListener = window.api.terminal.onData(({ id, data }) => {
      runtimes.get(id)?.term.write(data)
    })
    const removeExitListener = window.api.terminal.onExit(({ id }) => {
      setTabs((current) => current.filter((tab) => tab.id !== id))
      setActiveId((current) => (current === id ? null : current))
      runtimes.get(id)?.term.dispose()
      runtimes.delete(id)
    })

    return () => {
      removeDataListener()
      removeExitListener()
      for (const [id, runtime] of runtimes) {
        runtime.term.dispose()
        window.api.terminal.dispose(id)
      }
      runtimes.clear()
    }
  }, [runtimes])

  useEffect(() => {
    if (mode !== 'terminal' || !activeId) return
    fitTerminal(activeId)
    runtimes.get(activeId)?.term.focus()
  }, [activeId, fitTerminal, mode, runtimes])

  const fitActiveTerminal = useEffectEvent(() => {
    if (mode === 'terminal' && activeId) fitTerminal(activeId)
  })

  useEffect(() => {
    const onResize = () => fitActiveTerminal()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    return window.api.window.onFullScreen((fullscreen) => {
      document.body.classList.toggle('is-fullscreen', fullscreen)
    })
  }, [])

  useEffect(() => {
    return window.api.window.onCommand((command) => {
      if (command === 'new-terminal') void createTerminal()
      else if (command === 'open-workspace') void openWorkspace()
      else if (command === 'open-workspace-new-window') void openWorkspaceInNewWindow()
      else if (command === 'settings') openSettings()
      else if (command === 'toggle-files') toggleFiles()
      else if (command === 'toggle-review') toggleReview()
    })
  }, [
    createTerminal,
    openSettings,
    openWorkspace,
    openWorkspaceInNewWindow,
    toggleFiles,
    toggleReview
  ])

  useEffect(() => {
    return tinykeys(window, {
      '$mod+KeyG': (event) => {
        event.preventDefault()
        toggleFiles()
      },
      '$mod+KeyE': (event) => {
        event.preventDefault()
        toggleReview()
      },
      '$mod+KeyW': (event) => {
        event.preventDefault()
        closeActiveView()
      },
      '$mod+KeyJ': (event) => {
        event.preventDefault()
        void createTerminal()
      },
      '$mod+KeyO': (event) => {
        if (event.shiftKey) return
        event.preventDefault()
        void openWorkspace()
      },
      '$mod+Shift+KeyO': (event) => {
        event.preventDefault()
        void openWorkspaceInNewWindow()
      },
      '$mod+Comma': (event) => {
        event.preventDefault()
        openSettings()
      },
      Escape: () => closeSettings()
    })
  }, [
    closeActiveView,
    closeSettings,
    createTerminal,
    openSettings,
    openWorkspace,
    openWorkspaceInNewWindow,
    toggleFiles,
    toggleReview
  ])

  return (
    <main className="app-shell">
      <nav className="terminal-navbar" aria-label="Application">
        <div className="terminal-tabs">
          {tabs.map((tab) => (
            <div className={`terminal-tab${tab.id === activeId ? ' is-active' : ''}`} key={tab.id}>
              <button
                className="terminal-tab-main"
                onClick={() => {
                  dispatchView({ type: 'setMode', mode: 'terminal' })
                  setActiveId(tab.id)
                }}
                title={tab.cwd}
                type="button"
              >
                <TerminalIcon className="terminal-tab-icon" size={16} weight="regular" />
                <span className="terminal-tab-title">{tab.title}</span>
              </button>
              <button
                className="terminal-tab-close"
                onClick={() => closeTerminal(tab.id)}
                type="button"
                aria-label={`Close ${tab.title}`}
              >
                <XIcon size={13} weight="regular" />
              </button>
            </div>
          ))}
        </div>
        <button
          className="terminal-new"
          onClick={createTerminal}
          type="button"
          aria-label="New terminal"
          title="New terminal (Cmd+J)"
        >
          <PlusIcon size={14} weight="regular" />
        </button>
        <div className="topbar-spacer" />
        {workspaceRoot ? (
          <button
            className="topbar-workspace"
            onClick={openWorkspace}
            type="button"
            title={`${workspaceRoot}\nCmd+O: change workspace\nCmd+Shift+O: open workspace in new window`}
            aria-label="Open workspace"
          >
            <FolderOpenIcon size={15} weight="regular" />
            <span>{getWorkspaceName(workspaceRoot)}</span>
          </button>
        ) : null}
        <button
          className={`topbar-file${mode === 'review' ? ' is-active' : ''}`}
          onClick={toggleReview}
          type="button"
          aria-label="Open review"
          title="Open review (Cmd+E)"
        >
          <GitDiffIcon size={16} weight="regular" />
        </button>
        <button
          className={`topbar-file${mode === 'files' ? ' is-active' : ''}`}
          onClick={toggleFiles}
          type="button"
          aria-label="Open files"
          title="Open files (Cmd+G)"
        >
          <FileIcon size={16} weight="regular" />
        </button>
      </nav>

      <section
        className={`terminal-stage${mode === 'terminal' ? ' is-active' : ''}`}
        aria-label={activeTab?.title ?? 'Terminal'}
      >
        {tabs.map((tab) => (
          <div
            className={`terminal-container${tab.id === activeId ? ' is-active' : ''}`}
            key={tab.id}
            ref={(element) => attachTerminal(tab.id, element)}
          />
        ))}
      </section>

      {mode === 'review' ? (
        <ReviewPanel
          items={reviewItems}
          loading={reviewLoading}
          summary={reviewSummary}
          onToggleItem={toggleReviewItem}
        />
      ) : null}

      <SettingsDialog dialogRef={settingsDialogRef} onClose={closeSettings} />

      {mode === 'files' ? (
        <FilesPanel
          key={filesLoading ? 'loading' : `files-${filePaths.length}`}
          paths={filePaths}
          selectedPath={selectedPath}
          selectedFile={selectedFile}
          loading={filesLoading}
          gitStatus={fileGitStatus}
          truncated={filesTruncated}
          onSelectPath={selectFilePath}
        />
      ) : null}
    </main>
  )
}

export default App

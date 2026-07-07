import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState
} from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { FileIcon, PlusIcon, TerminalIcon, XIcon } from '@phosphor-icons/react'
import { tinykeys } from 'tinykeys'
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

type AppMode = 'terminal' | 'files'

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

type HighlightedToken = {
  content: string
  color?: string
  fontStyle?: number
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
  const [highlightedLines, setHighlightedLines] = useState<HighlightedToken[][] | null>(null)
  const [highlighting, setHighlighting] = useState(false)
  const markdown = isMarkdown(file.path)
  const canRenderMarkdown = markdown && file.size <= maxRenderedMarkdownBytes
  const canHighlight = file.size <= maxHighlightedBytes

  useEffect(() => {
    let canceled = false
    setHighlightedLines(null)

    if (file.kind !== 'text' || !canHighlight) return

    setHighlighting(true)
    void import('shiki')
      .then(({ createHighlighter }) =>
        createHighlighter({
          langs: [...highlightedLanguages],
          themes: ['github-dark-default']
        })
      )
      .then((highlighter) =>
        highlighter.codeToTokens(file.content, {
          lang: getLanguage(file.path) as never,
          theme: 'github-dark-default'
        })
      )
      .then((result) => {
        if (!canceled) setHighlightedLines(result.tokens as HighlightedToken[][])
      })
      .catch((error) => {
        console.warn('Failed to highlight file', file.path, error)
        if (!canceled) setHighlightedLines(null)
      })
      .finally(() => {
        if (!canceled) setHighlighting(false)
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

      {(!markdown || viewerMode === 'source') && highlightedLines ? (
        <CodeWithLineNumbers highlightedLines={highlightedLines} />
      ) : null}

      {(!markdown || viewerMode === 'source') && !highlightedLines ? (
        <CodeWithLineNumbers
          content={highlighting ? `Highlighting…\n\n${file.content}` : file.content}
        />
      ) : null}
    </>
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
        {!loading && !selectedFile ? <div className="file-empty">Select a file</div> : null}
        {selectedFile ? <FilePreview key={selectedFile.path} file={selectedFile} /> : null}
      </main>
    </section>
  )
}

function App(): React.JSX.Element {
  const [mode, setMode] = useState<AppMode>('terminal')
  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [filePaths, setFilePaths] = useState<string[]>([])
  const [filesLoading, setFilesLoading] = useState(false)
  const [filesTruncated, setFilesTruncated] = useState(false)
  const [fileGitStatus, setFileGitStatus] = useState<GitStatusEntry[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [selectedFile, setSelectedFile] = useState<FileReadResult | null>(null)
  const runtimes = useMemo(() => new Map<string, TerminalRuntime>(), [])
  const containers = useMemo(() => new Map<string, HTMLDivElement>(), [])
  const creating = useRef(false)
  const loadedFiles = useRef(false)

  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeId) ?? null, [activeId, tabs])

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
    setMode('files')
    if (loadedFiles.current) return

    loadedFiles.current = true
    setFilesLoading(true)
    try {
      const result = await window.api.files.list()
      setFilePaths(result.paths)
      setFileGitStatus(result.gitStatus)
      setFilesTruncated(result.truncated)
    } finally {
      setFilesLoading(false)
    }
  }, [])

  const selectFilePath = useCallback(async (path: string) => {
    setSelectedPath(path)
    const result = await window.api.files.read(path)
    setSelectedFile(result)
  }, [])

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
    return tinykeys(window, {
      '$mod+KeyG': (event) => {
        event.preventDefault()
        void openFiles()
      }
    })
  }, [openFiles])

  return (
    <main className="app-shell">
      <nav className="terminal-navbar" aria-label="Application">
        <div className="terminal-tabs">
          {tabs.map((tab) => (
            <div className={`terminal-tab${tab.id === activeId ? ' is-active' : ''}`} key={tab.id}>
              <button
                className="terminal-tab-main"
                onClick={() => {
                  setMode('terminal')
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
        >
          <PlusIcon size={14} weight="regular" />
        </button>
        <div className="topbar-spacer" />
        <button
          className={`topbar-file${mode === 'files' ? ' is-active' : ''}`}
          onClick={() => void openFiles()}
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

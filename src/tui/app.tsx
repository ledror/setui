import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BuildTarget } from '../core/build.js'
import { openProject, type Project } from '../core/project.js'
import { parseSln, type SlnDocument } from '../core/sln.js'
import { startBuild, wrapLines, type RunningBuild } from './build.js'
import { CONFIG_PATH, DEFAULT_LOG_LINES, loadConfig, type Config } from './config.js'
import { findSolutions } from './discover.js'
import { GLYPH, iconFor } from './icons.js'
import { edit, forRender, start } from './textInput.js'
import { buildRows, isExpandable, windowOf, type Row } from './tree.js'

const ACCENT = 'cyan'
const SELECT_ROWS = 12
const CHEVRON_OPEN = '▾'
const CHEVRON_CLOSED = '▸'

/** Paths inside project files hold backslashes; the local filesystem may not. */
const toLocal = (p: string) => p.split('\\').join(sep)

/**
 * Keeps the visible window anchored: it only moves when the cursor would leave it,
 * so scrolling up puts the cursor on the top line the same way scrolling down puts
 * it on the bottom one. Recomputing from zero every render is what made it
 * asymmetrical.
 */
function useWindow(total: number, height: number, cursor: number): number {
  const [scrollTop, setScrollTop] = useState(0)
  const top = windowOf(total, height, cursor, scrollTop)
  useEffect(() => {
    if (top !== scrollTop) setScrollTop(top)
  }, [top, scrollTop])
  return top
}

function useTerminalSize() {
  const { stdout } = useStdout()
  const [size, setSize] = useState({ rows: stdout.rows || 30, columns: stdout.columns || 100 })
  useEffect(() => {
    const onResize = () => setSize({ rows: stdout.rows || 30, columns: stdout.columns || 100 })
    stdout.on('resize', onResize)
    return () => {
      stdout.off('resize', onResize)
    }
  }, [stdout])
  return size
}

// ----------------------------------------------------------------- text input

function TextPrompt({
  label,
  initial,
  onSubmit,
  onCancel,
}: {
  label: string
  initial: string
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  const [state, setState] = useState(() => start(initial))
  useInput((input, key) => {
    if (key.escape) return onCancel()
    if (key.return) return onSubmit(state.value.trim())
    setState((previous) => edit(previous, input, key))
  })
  const { before, at, after } = forRender(state)
  return (
    <Box borderStyle="round" borderColor={ACCENT} paddingX={1}>
      <Text>{label} </Text>
      <Text color={ACCENT}>{before}</Text>
      <Text inverse>{at}</Text>
      <Text color={ACCENT}>{after}</Text>
    </Box>
  )
}

// --------------------------------------------------------------------- select

interface Choice {
  label: string
  value: string
}

function SelectList({
  title,
  items,
  onPick,
  onCancel,
}: {
  title: string
  items: Choice[]
  onPick: (value: string) => void
  onCancel: () => void
}) {
  const [cursor, setCursor] = useState(0)
  const [state, setState] = useState(() => start(''))
  const query = state.value
  const shown = useMemo(
    () => (query ? items.filter((i) => i.label.toLowerCase().includes(query.toLowerCase())) : items),
    [items, query],
  )
  useInput((input, key) => {
    if (key.escape) return onCancel()
    if (key.downArrow) return setCursor((c) => Math.min(c + 1, shown.length - 1))
    if (key.upArrow) return setCursor((c) => Math.max(c - 1, 0))
    if (key.return) {
      const item = shown[cursor]
      if (item) onPick(item.value)
      return
    }
    setCursor(0)
    setState((previous) => edit(previous, input, { ...key, upArrow: false, downArrow: false }))
  })

  const height = SELECT_ROWS
  const top = useWindow(shown.length, height, Math.min(cursor, Math.max(0, shown.length - 1)))
  return (
    <Box borderStyle="round" borderColor={ACCENT} flexDirection="column" paddingX={1}>
      <Text bold>
        {title} <Text dimColor>({shown.length})</Text>
      </Text>
      {shown.slice(top, top + height).map((item, i) => (
        <Text key={item.value} inverse={top + i === cursor} wrap="truncate-middle">
          {item.label}
        </Text>
      ))}
      <Text color={ACCENT}>
        {'>'} {forRender(state).before}
        <Text inverse>{forRender(state).at}</Text>
        {forRender(state).after}
      </Text>
    </Box>
  )
}

// ------------------------------------------------------------------- overlays

type Overlay =
  | { type: 'prompt'; label: string; initial: string; submit: (value: string) => void }
  | { type: 'select'; title: string; items: Choice[]; pick: (value: string) => void }
  | { type: 'confirm'; message: string; confirm: () => void }
  | { type: 'help' }

const HELP: [string, string][] = [
  ['j k up down', 'move'],
  ['h l left right', 'collapse / expand'],
  ['enter', 'expand, or open a file'],
  ['g G', 'top / bottom'],
  ['ctrl+u ctrl+d', 'half page up / down'],
  ['PgUp PgDn', 'page'],
  ['/', 'search'],
  ['-  backspace', 'back to the solution list'],
  ['a', 'add a file, or a reference on References'],
  ['A', 'add a file that already exists'],
  ['d', 'remove from the project'],
  ['D', 'remove and delete from disk'],
  ['f', 'new filter'],
  ['r', 'rename'],
  ['m', 'move to filter'],
  ['b B c', 'build / rebuild / clean'],
  ['p', 'configuration | platform'],
  ['o', 'toggle the full build log'],
  ['e', 'open: a file, or the .vcxproj on a project'],
  [',', 'open ~/.setui.json'],
  ['R', 'reload from disk'],
  ['esc', 'cancel build, then hide its output, then search'],
  ['? q', 'help / quit'],
]

/** Rows an overlay occupies, so the tree can give up exactly that much room. */
function overlayHeight(overlay: Overlay | null): number {
  if (!overlay) return 0
  switch (overlay.type) {
    case 'prompt':
    case 'confirm':
      return 3 // one line inside a round border
    case 'select':
      return Math.min(overlay.items.length, SELECT_ROWS) + 4 // border, title, filter
    case 'help':
      return HELP.length + 2
  }
}

function Confirm({
  message,
  onConfirm,
  onCancel,
}: {
  message: string
  onConfirm: () => void
  onCancel: () => void
}) {
  useInput((input, key) => {
    if (input === 'y' || input === 'Y') return onConfirm()
    if (key.escape || input === 'n' || input === 'N' || input === 'q') return onCancel()
  })
  return (
    <Box borderStyle="round" borderColor="red" paddingX={1}>
      <Text>{message} </Text>
      <Text dimColor>y/N</Text>
    </Box>
  )
}

function Help({ onClose }: { onClose: () => void }) {
  useInput(() => onClose())
  return (
    <Box borderStyle="round" borderColor={ACCENT} flexDirection="column" paddingX={1}>
      {HELP.map(([keys, what]) => (
        <Text key={keys}>
          <Text color={ACCENT}>{keys.padEnd(16)}</Text>
          {what}
        </Text>
      ))}
    </Box>
  )
}

// ------------------------------------------------------------------- the tree

function decorate(row: Row, open: boolean): { glyph: string; color: string } {
  switch (row.kind) {
    case 'folder':
      return { glyph: open ? GLYPH.filterOpen : GLYPH.filterClosed, color: 'yellow' }
    case 'project':
      return { glyph: GLYPH.project, color: ACCENT }
    case 'references':
      return { glyph: GLYPH.references, color: 'magenta' }
    case 'reference':
      return { glyph: GLYPH.reference, color: 'magenta' }
    case 'filter':
      return { glyph: open ? GLYPH.filterOpen : GLYPH.filterClosed, color: 'yellow' }
    case 'file': {
      const icon = iconFor(row.path)
      return { glyph: icon.glyph, color: icon.color }
    }
  }
}

function TreeRow({ row, selected, open }: { row: Row; selected: boolean; open: boolean }) {
  const chevron = isExpandable(row) ? (open ? CHEVRON_OPEN : CHEVRON_CLOSED) : ' '
  const { glyph, color } = decorate(row, open)
  return (
    <Text inverse={selected} wrap="truncate-end">
      {'  '.repeat(row.depth)}
      {chevron} <Text color={color}>{glyph}</Text> {row.label}
      {row.kind === 'file' && row.readOnly ? <Text dimColor> (shared Include)</Text> : null}
    </Text>
  )
}

// --------------------------------------------------------------------- the app

export function App({ start, configPath }: { start: string; configPath?: string }) {
  const { exit } = useApp()
  const { rows: termRows, columns: termColumns } = useTerminalSize()

  const [config, setConfig] = useState<Config | null>(null)
  const [solutions, setSolutions] = useState<string[] | null>(null)
  const [solutionPath, setSolutionPath] = useState<string | null>(null)
  const [solution, setSolution] = useState<SlnDocument | null>(null)
  const [projects, setProjects] = useState<Map<string, Project>>(new Map())
  const [version, setVersion] = useState(0) // Projects are mutable; this forces a repaint.
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [cursor, setCursor] = useState(0)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  const [status, setStatus] = useState<{ text: string; error: boolean }>({ text: '', error: false })
  const [configuration, setConfiguration] = useState('')
  const [platform, setPlatform] = useState('')
  const [log, setLog] = useState<string[]>([])
  const [logOpen, setLogOpen] = useState(false)
  const [logScroll, setLogScroll] = useState(0)
  /** While true the full-screen log stays pinned to the newest output. */
  const [logFollow, setLogFollow] = useState(true)
  const [building, setBuilding] = useState<string | null>(null)
  const running = useRef<RunningBuild | null>(null)
  /** Set when the user kills a build, so its exit is not reported as a failure. */
  const cancelled = useRef(false)

  const say = (text: string, error = false) => setStatus({ text, error })
  const fail = (e: unknown) => say(e instanceof Error ? e.message : String(e), true)

  useEffect(() => {
    void (async () => {
      try {
        setConfig(await loadConfig(configPath))
        if (start.toLowerCase().endsWith('.sln')) setSolutionPath(start)
        else setSolutions(await findSolutions(start))
      } catch (e) {
        fail(e)
      }
    })()
  }, [start, configPath])

  const openSolution = useCallback(async (path: string) => {
    try {
      const doc = parseSln(await readFile(path, 'utf8'))
      const preferred = doc.defaultConfigPlatform()
      setSolution(doc)
      setProjects(new Map())
      setExpanded(new Set())
      setCursor(0)
      setConfiguration(preferred.configuration)
      setPlatform(preferred.platform)
      say(`${doc.projects.filter((p) => !p.isFolder).length} projects`)
    } catch (e) {
      fail(e)
    }
  }, [])

  useEffect(() => {
    if (solutionPath) void openSolution(solutionPath)
  }, [solutionPath, openSolution])

  const rows = useMemo(
    () => (solution ? buildRows({ solution, projects, expanded, query }) : []),
    // `version` is a deliberate dependency: Project instances mutate in place.
    [solution, projects, expanded, query, version],
  )
  const current = rows[Math.min(cursor, rows.length - 1)]
  const project = current ? projects.get(current.guid) : undefined

  const paneWidth = Math.max(20, termColumns - 2) // inside the pane's border
  const paneRows = useMemo(() => wrapLines(log, paneWidth), [log, paneWidth])
  const fullRows = useMemo(() => wrapLines(log, termColumns), [log, termColumns])
  const logHeight = Math.max(1, termRows - 2)
  const maxLogScroll = Math.max(0, fullRows.length - logHeight)

  const paneHeight = building !== null || log.length > 0 ? (config?.logLines ?? DEFAULT_LOG_LINES) + 2 : 0
  const treeHeight = Math.max(3, termRows - 3 - paneHeight - overlayHeight(overlay))
  const top = useWindow(rows.length, treeHeight, Math.min(cursor, Math.max(0, rows.length - 1)))

  useEffect(() => {
    if (logOpen && logFollow) setLogScroll(maxLogScroll)
  }, [logOpen, logFollow, maxLogScroll])

  const loadProject = useCallback(
    async (guid: string) => {
      if (!solution || !solutionPath || projects.has(guid)) return
      const entry = solution.projects.find((p) => p.guid === guid)
      if (!entry) return
      try {
        const loaded = await openProject(join(dirname(solutionPath), toLocal(entry.path)))
        setProjects((previous) => new Map(previous).set(guid, loaded))
      } catch (e) {
        fail(e)
      }
    },
    [solution, solutionPath, projects],
  )

  const touch = () => setVersion((v) => v + 1)

  /** Runs an edit, saves it, and repaints. Errors land in the status line. */
  const commit = (work: () => void | Promise<void>) => {
    void (async () => {
      if (!project) return
      try {
        await work()
        await project.save()
        touch()
      } catch (e) {
        fail(e)
      }
    })()
  }

  /** The filter a new item should land in, based on where the cursor is. */
  const filterAt = (row: Row | undefined): string | undefined => {
    if (!row || !project) return undefined
    if (row.kind === 'filter') return row.path
    if (row.kind === 'file') return project.files.find((f) => f.path === row.path)?.filter ?? undefined
    return undefined
  }

  /** What `e` opens for a row: the file, the .vcxproj itself, or the referenced one. */
  const editTargetFor = (row: Row | undefined): string | null => {
    if (!row || !solution || !solutionPath) return null
    if (row.kind === 'file' && project) return join(project.dir, toLocal(row.path))
    if (row.kind === 'reference' && project) return join(project.dir, toLocal(row.include))
    if (row.kind === 'project' || row.kind === 'references') {
      const entry = solution.projects.find((p) => p.guid === row.guid)
      return entry ? join(dirname(solutionPath), toLocal(entry.path)) : null
    }
    return null
  }

  const openInEditor = (target: string) => {
    if (!config) return
    const [command, ...args] = config.editor.split(/\s+/)
    if (!command) return say('no editor configured', true)
    // A terminal editor needs the raw terminal to itself; spawnSync blocks Ink until
    // it exits, which is all the suspend/resume this needs.
    process.stdin.setRawMode?.(false)
    spawnSync(command, [...args, target], { stdio: 'inherit' })
    process.stdin.setRawMode?.(true)
    touch()
  }

  const runBuild = (target: BuildTarget) => {
    if (!solution || !solutionPath || !current || !config) return
    if (running.current) return say('a build is already running')
    if (!config.msbuild) return say(`set "msbuild" in ${configPath ?? CONFIG_PATH} first (press ,)`, true)
    const entry = solution.projects.find((p) => p.guid === current.guid)
    if (!entry || entry.isFolder) return say('select a project first')
    setLog([])
    setBuilding(`${target} ${entry.name}`)
    running.current = startBuild(
      config.msbuild,
      {
        solutionPath,
        virtualPath: solution.virtualPath(entry.guid),
        target,
        configuration,
        platform,
      },
      (chunk) => setLog((previous) => [...previous, ...chunk.split(/\r?\n/).filter((l) => l !== '')]),
      (code) => {
        running.current = null
        setBuilding(null)
        if (cancelled.current) {
          cancelled.current = false
          return say('build cancelled')
        }
        say(code === 0 ? `${target} succeeded` : `${target} failed (exit ${code ?? 'killed'})`, code !== 0)
      },
    )
  }

  /** Returns to the solution list, discovering one if we opened a .sln directly. */
  const backToSolutions = () => {
    const from = solutionPath
    running.current?.kill()
    setSolution(null)
    setSolutionPath(null)
    setProjects(new Map())
    setExpanded(new Set())
    setLog([])
    setQuery('')
    setCursor(0)
    if (!solutions && from) {
      void (async () => {
        try {
          setSolutions(await findSolutions(dirname(from)))
        } catch (e) {
          fail(e)
        }
      })()
    }
  }

  const collapse = (id: string) =>
    setExpanded((previous) => {
      const next = new Set(previous)
      next.delete(id)
      return next
    })

  // ------------------------------------------------------------ key handling

  useInput(
    (input, key) => {
      if (logOpen) {
        // ponytail: keyboard scrolling only. Mouse wheel needs terminal mouse
        // tracking and an SGR parser; add it if reading logs by keyboard grates.
        const page = Math.max(1, logHeight - 1)
        // Scrolling up detaches from the tail; getting back to the bottom re-attaches,
        // so a build you are watching keeps streaming with no extra keypress.
        const scrollTo = (next: number) => {
          const at = Math.max(0, Math.min(next, maxLogScroll))
          setLogScroll(at)
          setLogFollow(at >= maxLogScroll)
        }
        if (input === 'o' || key.escape || input === 'q') return setLogOpen(false)
        if (key.downArrow || input === 'j') return scrollTo(logScroll + 1)
        if (key.upArrow || input === 'k') return scrollTo(logScroll - 1)
        if (key.pageDown || (key.ctrl && input === 'd')) return scrollTo(logScroll + page)
        if (key.pageUp || (key.ctrl && input === 'u')) return scrollTo(logScroll - page)
        if (input === 'G') return scrollTo(maxLogScroll)
        if (input === 'g') return scrollTo(0)
        return
      }

      if (searching) {
        if (key.escape) {
          setQuery('')
          return setSearching(false)
        }
        if (key.return) return setSearching(false)
        if (key.backspace || key.delete) return setQuery((q) => q.slice(0, -1))
        if (input && !key.ctrl && !key.meta) {
          setCursor(0)
          setQuery((q) => q + input)
        }
        return
      }

      if (!solution) return

      const page = Math.max(1, treeHeight - 1)
      if (key.downArrow || input === 'j') return setCursor((c) => Math.min(c + 1, rows.length - 1))
      if (key.upArrow || input === 'k') return setCursor((c) => Math.max(c - 1, 0))
      if (input === 'g') return setCursor(0)
      if (input === 'G') return setCursor(Math.max(0, rows.length - 1))
      if (key.pageDown || (key.ctrl && input === 'd')) {
        return setCursor((c) => Math.min(c + page, rows.length - 1))
      }
      if (key.pageUp || (key.ctrl && input === 'u')) return setCursor((c) => Math.max(c - page, 0))
      if (input === '/') return setSearching(true)
      if (input === '?') return setOverlay({ type: 'help' })
      if (input === 'q') {
        cancelled.current = true
        running.current?.kill()
        return exit()
      }
      if (input === 'o') {
        setLogFollow(true)
        setLogScroll(maxLogScroll)
        return setLogOpen(true)
      }
      if (key.escape) {
        // Escape unwinds one thing at a time: stop the build, then put the output
        // pane away, then drop the search.
        if (running.current) {
          cancelled.current = true
          running.current.kill()
          return say('cancelling the build...')
        }
        if (log.length > 0) {
          setLog([])
          setLogOpen(false)
          return say('output cleared')
        }
        if (query) return setQuery('')
        return
      }
      if (input === ',') return openInEditor(configPath ?? CONFIG_PATH)
      if (input === '-' || key.backspace) return backToSolutions()
      if (input === 'R') {
        if (solutionPath) void openSolution(solutionPath)
        return say('reloaded')
      }
      if (input === 'b') return runBuild('Build')
      if (input === 'B') return runBuild('Rebuild')
      if (input === 'c') return runBuild('Clean')
      if (input === 'p') {
        return setOverlay({
          type: 'select',
          title: 'Configuration | Platform',
          items: solution.configurations.flatMap((c) =>
            solution.platforms.map((p) => ({ label: `${c}|${p}`, value: `${c}|${p}` })),
          ),
          pick: (value) => {
            const [c, p] = value.split('|')
            setConfiguration(c ?? '')
            setPlatform(p ?? '')
            setOverlay(null)
          },
        })
      }

      if (!current) return

      if (key.rightArrow || input === 'l' || key.return) {
        if (!isExpandable(current)) {
          const target = editTargetFor(current)
          if (target) openInEditor(target)
          return
        }
        if (current.kind === 'project') void loadProject(current.guid)
        return setExpanded((previous) => new Set(previous).add(current.id))
      }
      if (key.leftArrow || input === 'h') {
        if (expanded.has(current.id)) return collapse(current.id)
        const parent = rows
          .slice(0, cursor)
          .reverse()
          .find((r) => r.depth < current.depth)
        if (parent) setCursor(rows.indexOf(parent))
        return
      }
      if (input === 'e') {
        const target = editTargetFor(current)
        if (target) return openInEditor(target)
        return say('nothing to open here')
      }

      if (!project) return say('expand the project first')

      if ((input === 'a' || input === 'A') && (current.kind === 'references' || current.kind === 'reference')) {
        const already = new Set(project.references.map((r) => r.include.toLowerCase()))
        const candidates = solution.projects
          .filter((p) => !p.isFolder && p.guid !== current.guid)
          .map((p) => ({ entry: p, path: join(dirname(solutionPath ?? ''), toLocal(p.path)) }))
          .filter(({ path }) => !already.has(relative(project.dir, path).split('/').join('\\').toLowerCase()))
        if (candidates.length === 0) return say('every other project is already referenced')
        return setOverlay({
          type: 'select',
          title: 'Add a reference to',
          items: candidates.map(({ entry, path }) => ({ label: entry.name, value: path })),
          pick: (value) => {
            setOverlay(null)
            commit(async () => {
              await project.addReference(value)
              say(`referenced ${basename(value, '.vcxproj')}`)
            })
          },
        })
      }

      if (input === 'a' || input === 'A') {
        const create = input === 'a'
        const filter = filterAt(current)
        return setOverlay({
          type: 'prompt',
          label: create ? 'New file:' : 'Existing file:',
          initial: '',
          submit: (value) => {
            setOverlay(null)
            if (!value) return
            commit(async () => {
              const target = join(project.dir, toLocal(value))
              if (create) {
                await mkdir(dirname(target), { recursive: true })
                if (!existsSync(target)) await writeFile(target, '', 'utf8')
              } else if (!existsSync(target)) {
                throw new Error(`${value} does not exist`)
              }
              project.addFile(value, filter)
              say(`added ${value}${filter ? ` to ${filter}` : ''}`)
            })
          },
        })
      }

      if (input === 'f') {
        const parent = current.kind === 'filter' ? current.path : filterAt(current)
        return setOverlay({
          type: 'prompt',
          label: parent ? `New filter under ${parent}:` : 'New filter:',
          initial: '',
          submit: (value) => {
            setOverlay(null)
            if (!value) return
            commit(() => {
              project.addFilter(parent ? `${parent}\\${value}` : value)
              say(`added filter ${value}`)
            })
          },
        })
      }

      if (input === 'r') {
        if (current.kind === 'file') {
          return setOverlay({
            type: 'prompt',
            label: 'Rename to:',
            initial: current.path,
            submit: (value) => {
              setOverlay(null)
              if (!value || value === current.path) return
              commit(async () => {
                const from = join(project.dir, toLocal(current.path))
                const to = join(project.dir, toLocal(value))
                if (existsSync(to)) throw new Error(`${value} already exists`)
                await mkdir(dirname(to), { recursive: true })
                if (existsSync(from)) await rename(from, to)
                project.renameFile(current.path, value)
                say(`renamed to ${value}`)
              })
            },
          })
        }
        if (current.kind === 'filter') {
          return setOverlay({
            type: 'prompt',
            label: 'Rename filter to:',
            initial: current.label,
            submit: (value) => {
              setOverlay(null)
              if (!value || value === current.label) return
              commit(() => {
                project.renameFilter(current.path, value)
                say(`renamed filter to ${value}`)
              })
            },
          })
        }
        return say('nothing renameable here')
      }

      if (input === 'm') {
        if (current.kind !== 'file') return say('select a file to move')
        return setOverlay({
          type: 'select',
          title: `Move ${current.label} to`,
          items: [
            { label: '(no filter)', value: ' ' },
            ...project.filters.map((f) => ({ label: f.path, value: f.path })),
          ],
          pick: (value) => {
            setOverlay(null)
            commit(() => {
              project.moveToFilter(current.path, value === ' ' ? null : value)
              say('moved')
            })
          },
        })
      }

      if (input === 'd' || input === 'D') {
        const alsoDelete = input === 'D'
        // Every removal is confirmed, including the ones that only touch the
        // project file: a stray keypress must never cost someone their work.
        const ask = (message: string, act: () => void) =>
          setOverlay({
            type: 'confirm',
            message,
            confirm: () => {
              setOverlay(null)
              act()
            },
          })

        if (current.kind === 'reference') {
          return ask(`Remove the reference to ${current.label}?`, () =>
            commit(() => {
              project.removeReference(current.include)
              say('reference removed')
            }),
          )
        }
        if (current.kind === 'file') {
          const message = alsoDelete
            ? `Remove ${current.path} from the project AND delete it from disk?`
            : `Remove ${current.path} from the project? (the file stays on disk)`
          return ask(message, () =>
            commit(async () => {
              project.removeFile(current.path)
              if (alsoDelete) {
                const target = join(project.dir, toLocal(current.path))
                if (existsSync(target)) await unlink(target)
              }
              say(alsoDelete ? `deleted ${current.path}` : `removed ${current.path}`)
            }),
          )
        }
        if (current.kind === 'filter') {
          return ask(`Remove filter ${current.path} and everything under it?`, () =>
            commit(() => {
              project.removeFilter(current.path, { reparentTo: null })
              say('filter removed')
            }),
          )
        }
        return say('nothing removable here')
      }
    },
    { isActive: overlay === null },
  )

  // ------------------------------------------------------------------ render

  if (!config) return <Text>loading...</Text>

  if (!solution) {
    if (!solutions) return <Text>searching for solutions...</Text>
    if (solutions.length === 0) {
      return <Text color="red">no .sln files found under {start}</Text>
    }
    return (
      <SelectList
        title="Solutions"
        items={solutions.map((p) => ({ label: p.startsWith(start) ? p.slice(start.length + 1) : p, value: p }))}
        onPick={setSolutionPath}
        onCancel={exit}
      />
    )
  }

  if (logOpen) {
    return (
      <Box flexDirection="column">
        <Text backgroundColor={ACCENT} color="black">
          {` build log - ${log.length} lines - ${logFollow ? 'following' : 'G to follow'} - o or esc to close `}
        </Text>
        {fullRows.slice(logScroll, logScroll + logHeight).map((line, i) => (
          <Text key={`${logScroll + i}`}>{line || ' '}</Text>
        ))}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={ACCENT}>{GLYPH.solution} </Text>
        <Text bold>{basename(solutionPath ?? '')}</Text>
        <Text dimColor> - </Text>
        <Text color="magenta">
          {configuration}|{platform}
        </Text>
        {building ? <Text color="yellow"> - {building}...</Text> : null}
      </Text>

      <Box flexDirection="column" height={treeHeight}>
        {rows.slice(top, top + treeHeight).map((row, i) => (
          <TreeRow
            key={row.id}
            row={row}
            selected={top + i === cursor}
            open={expanded.has(row.id) || query !== ''}
          />
        ))}
      </Box>

      {paneHeight > 0 ? (
        <Box flexDirection="column" height={paneHeight} borderStyle="single" borderColor="gray">
          {paneRows.slice(-(paneHeight - 2)).map((line, i) => (
            <Text key={`log-${i}`}>{line || ' '}</Text>
          ))}
        </Box>
      ) : null}

      {searching ? (
        <Text>
          <Text color={ACCENT}>/</Text>
          {query}
          <Text inverse> </Text>
        </Text>
      ) : (
        <Text color={status.error ? 'red' : 'gray'} wrap="truncate-end">
          {status.text || `${rows.length} rows - ? for help`}
          {query ? <Text color={ACCENT}>{`  /${query}`}</Text> : null}
        </Text>
      )}

      {overlay?.type === 'prompt' ? (
        <TextPrompt
          label={overlay.label}
          initial={overlay.initial}
          onSubmit={overlay.submit}
          onCancel={() => setOverlay(null)}
        />
      ) : null}
      {overlay?.type === 'select' ? (
        <SelectList
          title={overlay.title}
          items={overlay.items}
          onPick={overlay.pick}
          onCancel={() => setOverlay(null)}
        />
      ) : null}
      {overlay?.type === 'confirm' ? (
        <Confirm message={overlay.message} onConfirm={overlay.confirm} onCancel={() => setOverlay(null)} />
      ) : null}
      {overlay?.type === 'help' ? <Help onClose={() => setOverlay(null)} /> : null}
    </Box>
  )
}

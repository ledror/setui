import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'

export interface Config {
  /** Full path to MSBuild.exe. Empty until the user fills it in. */
  msbuild: string
  /** Command used to open files; may include arguments, e.g. "code -w". */
  editor: string
  /** Lines of build output kept on screen. `o` opens the whole log full-screen. */
  logLines: number
  /** Extra msbuild arguments, appended verbatim to every build. */
  msbuildArgs: string[]
}

export const DEFAULT_LOG_LINES = 15
const MIN_LOG_LINES = 3
const MAX_LOG_LINES = 60

export const CONFIG_PATH = join(homedir(), '.setui.json')

const defaultEditor = () => process.env['VISUAL'] ?? process.env['EDITOR'] ?? (platform() === 'win32' ? 'notepad' : 'vim')

const blank = (): Config => ({
  msbuild: '',
  editor: defaultEditor(),
  logLines: DEFAULT_LOG_LINES,
  msbuildArgs: [],
})

/**
 * Reads `~/.setui.json`, creating it with empty values on first run. Invalid JSON is
 * reported rather than silently replaced: the file is the user's, and we would be
 * overwriting a typo in a path they just typed.
 */
export async function loadConfig(path = CONFIG_PATH): Promise<Config> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    const created = blank()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(created, null, 2) + '\n', 'utf8')
    return created
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${(e as Error).message}`)
  }
  const record = (parsed ?? {}) as Partial<Config>
  return {
    msbuild: typeof record.msbuild === 'string' ? record.msbuild : '',
    editor: typeof record.editor === 'string' && record.editor ? record.editor : defaultEditor(),
    logLines: clampLines(record.logLines),
    msbuildArgs: parseArgs((parsed as { msbuildArgs?: unknown }).msbuildArgs),
  }
}

/**
 * Accepts either form:
 *
 *   "msbuildArgs": "/v:m /nodeReuse:false"
 *   "msbuildArgs": ["/v:m", "/p:Banner=Hello World"]
 *
 * The string is split on whitespace, which is what almost everyone wants. An
 * argument that must contain a space goes in the array form, where it is passed
 * through verbatim -- there are no quoting rules to learn because the spawn takes
 * an argv array and never touches a shell.
 */
function parseArgs(value: unknown): string[] {
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean)
  if (Array.isArray(value)) return value.filter((a): a is string => typeof a === 'string' && a !== '')
  return []
}

/** Out-of-range values are clamped rather than rejected: it is only a pane height. */
function clampLines(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LOG_LINES
  return Math.max(MIN_LOG_LINES, Math.min(MAX_LOG_LINES, Math.round(value)))
}

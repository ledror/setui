import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'

export interface Config {
  /** Full path to MSBuild.exe. Empty until the user fills it in. */
  msbuild: string
  /** Command used to open files; may include arguments, e.g. "code -w". */
  editor: string
}

export const CONFIG_PATH = join(homedir(), '.setui.json')

const defaultEditor = () => process.env['VISUAL'] ?? process.env['EDITOR'] ?? (platform() === 'win32' ? 'notepad' : 'vim')

const blank = (): Config => ({ msbuild: '', editor: defaultEditor() })

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
  }
}

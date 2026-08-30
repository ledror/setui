import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join, normalize, relative } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const SKIP = new Set([
  '.git', '.svn', '.hg', 'node_modules', '.vs', 'bin', 'obj', 'Debug', 'Release',
  'x64', 'ARM64', 'Win32', 'packages', '.venv', 'dist', 'build',
])

/** Finds .sln files beneath `root`. */
export const findSolutions = (root: string): Promise<string[]> => findFiles(root, '*.sln')

/**
 * Finds files matching `pattern` beneath `root`. Delegates to fd or ripgrep when
 * either is on PATH — reimplementing a fast recursive walk is not our job — and
 * falls back to a plain readdir walk, which is the path that always works on
 * Windows.
 *
 * `pattern` is either `*.ext` or an exact filename. That covers both callers and
 * is the whole of the glob syntax the fallback walk understands; anything more
 * would mean shipping a glob engine to match what fd and rg already do.
 */
export async function findFiles(root: string, pattern: string): Promise<string[]> {
  for (const [command, args] of [
    ['fd', ['--type', 'f', '--glob', '--absolute-path', pattern, root]],
    ['fdfind', ['--type', 'f', '--glob', '--absolute-path', pattern, root]],
    ['rg', ['--files', '--glob', pattern, root]],
  ] as const) {
    try {
      const { stdout } = await run(command, [...args], { maxBuffer: 32 * 1024 * 1024 })
      return sort(stdout.split('\n').filter(Boolean), root)
    } catch {
      // Not installed, or it failed; try the next one, then walk it ourselves.
    }
  }
  return sort(await walk(root, matcher(pattern)), root)
}

const matcher = (pattern: string): ((name: string) => boolean) => {
  const lower = pattern.toLowerCase()
  if (lower.startsWith('*.')) {
    const suffix = lower.slice(1)
    return (name) => name.toLowerCase().endsWith(suffix)
  }
  return (name) => name.toLowerCase() === lower
}

async function walk(dir: string, matches: (name: string) => boolean): Promise<string[]> {
  const found: string[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return found // unreadable directory; nothing to see
  }
  const subdirectories: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) subdirectories.push(join(dir, entry.name))
    } else if (matches(entry.name)) {
      found.push(join(dir, entry.name))
    }
  }
  for (const batch of await Promise.all(subdirectories.map((d) => walk(d, matches)))) {
    found.push(...batch)
  }
  return found
}

/**
 * Normalizes before deduplicating: on Windows fd and rg print forward slashes
 * while the readdir walk builds backslashes, so without this the same file has
 * two spellings and which one you get depends on whether fd happens to be
 * installed.
 */
const sort = (paths: string[], root: string) =>
  [...new Set(paths.map((p) => normalize(p)))].sort((a, b) =>
    relative(root, a).localeCompare(relative(root, b)),
  )

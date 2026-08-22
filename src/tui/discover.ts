import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const SKIP = new Set([
  '.git', '.svn', '.hg', 'node_modules', '.vs', 'bin', 'obj', 'Debug', 'Release',
  'x64', 'ARM64', 'Win32', 'packages', '.venv', 'dist', 'build',
])

/**
 * Finds .sln files beneath `root`. Delegates to fd or ripgrep when either is on
 * PATH — reimplementing a fast recursive walk is not our job — and falls back to a
 * plain readdir walk, which is the path that always works on Windows.
 */
export async function findSolutions(root: string): Promise<string[]> {
  for (const [command, args] of [
    ['fd', ['--type', 'f', '--extension', 'sln', '--absolute-path', '.', root]],
    ['fdfind', ['--type', 'f', '--extension', 'sln', '--absolute-path', '.', root]],
    ['rg', ['--files', '--glob', '*.sln', root]],
  ] as const) {
    try {
      const { stdout } = await run(command, [...args], { maxBuffer: 32 * 1024 * 1024 })
      return sort(stdout.split('\n').filter(Boolean), root)
    } catch {
      // Not installed, or it failed; try the next one, then walk it ourselves.
    }
  }
  return sort(await walk(root), root)
}

async function walk(dir: string): Promise<string[]> {
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
    } else if (entry.name.toLowerCase().endsWith('.sln')) {
      found.push(join(dir, entry.name))
    }
  }
  for (const batch of await Promise.all(subdirectories.map(walk))) found.push(...batch)
  return found
}

const sort = (paths: string[], root: string) =>
  [...new Set(paths)].sort((a, b) => relative(root, a).localeCompare(relative(root, b)))

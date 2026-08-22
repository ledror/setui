import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CORPUS = fileURLToPath(new URL('../../sample-projects', import.meta.url))

/**
 * Lists corpus files by suffix. Read-only: nothing here ever writes to the
 * submodule, and no test may either — a test run must leave `git status` clean.
 */
export function corpusFiles(...suffixes: string[]): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (suffixes.some((s) => entry.name.endsWith(s))) out.push(full)
    }
  }
  if (statSync(CORPUS, { throwIfNoEntry: false })) walk(CORPUS)
  return out.sort()
}

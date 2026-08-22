import { readdirSync } from 'node:fs'
import { basename, dirname, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openProject } from '../src/core/project.js'
import { CORPUS, corpusFiles } from './helpers/corpus.js'
import { fakeGuids } from './helpers/fixture.js'

/**
 * Every edit is exercised against real projects and then undone. Nothing is ever
 * saved: `openProject` reads, and `save()` is never called, so the submodule is
 * untouched by design, not by luck.
 */

/** Case-insensitive, because 239 corpus projects spell it `.vcxproj.Filters`. */
const hasFiltersFile = (vcxproj: string) => {
  const wanted = `${basename(vcxproj)}.filters`.toLowerCase()
  return readdirSync(dirname(vcxproj)).some((n) => n.toLowerCase() === wanted)
}

const withFilters = corpusFiles('.vcxproj').filter(hasFiltersFile)

describe('project edits over the sample corpus', () => {
  it('found projects with filters to test against', () => {
    // Most of the corpus has one; if this drops, the filters lookup regressed.
    expect(withFilters.length).toBeGreaterThan(200)
  })

  it('opens the filters file whatever its casing', async () => {
    const oddlyCased = withFilters.find((f) =>
      readdirSync(dirname(f)).some((n) => n.endsWith('.Filters')),
    )
    expect(oddlyCased).toBeDefined()
    const project = await openProject(oddlyCased!, { newGuid: fakeGuids() })
    expect(project.hasFilters).toBe(true)
    expect(project.filters.length).toBeGreaterThan(0)
  })

  it('adds and removes a file in every filter without changing the files', async () => {
    const damaged: string[] = []
    for (const path of withFilters) {
      const project = await openProject(path, { newGuid: fakeGuids() })
      const before = { vcxproj: project.vcxprojText, filters: project.filtersText }
      for (const filter of project.filters) {
        project.addFile('setui_probe.c', filter.path)
        expect(project.files.some((f) => f.path === 'setui_probe.c')).toBe(true)
        project.removeFile('setui_probe.c')
        if (project.vcxprojText !== before.vcxproj || project.filtersText !== before.filters) {
          damaged.push(`${relative(CORPUS, path)} @ ${filter.path}`)
          break
        }
      }
    }
    expect(damaged).toEqual([])
  })

  it('adds and removes a filter without changing the files', async () => {
    const damaged: string[] = []
    for (const path of withFilters) {
      const project = await openProject(path, { newGuid: fakeGuids() })
      const before = project.filtersText
      project.addFilter('Setui Probe\\Deep')
      expect(project.filters.map((f) => f.path)).toContain('Setui Probe\\Deep')
      project.removeFilter('Setui Probe', { reparentTo: null })
      if (project.filtersText !== before) damaged.push(relative(CORPUS, path))
    }
    expect(damaged).toEqual([])
  })

  it('renames every filter and renames it back', async () => {
    const damaged: string[] = []
    for (const path of withFilters) {
      const project = await openProject(path, { newGuid: fakeGuids() })
      const before = project.filtersText
      for (const filter of project.filters) {
        const leaf = filter.path.split('\\').at(-1)!
        const renamed = filter.path.replace(/[^\\]+$/, 'SetuiProbeName')
        project.renameFilter(filter.path, 'SetuiProbeName')
        expect(project.filters.map((f) => f.path)).toContain(renamed)
        project.renameFilter(renamed, leaf)
      }
      if (project.filtersText !== before) damaged.push(relative(CORPUS, path))
    }
    expect(damaged).toEqual([])
  })

  it('never presents a wildcard, macro or item list as a plain file', async () => {
    let computed = 0
    let shared = 0
    for (const path of corpusFiles('.vcxproj')) {
      const project = await openProject(path, { newGuid: fakeGuids() })
      for (const file of project.files) {
        if (file.kind === 'computed') computed++
        if (file.kind === 'shared') shared++
        if (file.kind !== 'file') continue
        expect(file.path, `${relative(CORPUS, path)}: ${file.path}`).not.toMatch(/[;*?]/)
        expect(file.path).not.toContain('$(')
      }
    }
    // The corpus really does contain both, so this test is not vacuous:
    // 251 FilesToPackage Include="$(TargetPath)" and a handful of semicolon lists.
    expect(computed).toBeGreaterThan(200)
    expect(shared).toBeGreaterThan(0)
  })

  it('refuses to edit anything that is not a plain file', async () => {
    for (const path of corpusFiles('.vcxproj')) {
      const project = await openProject(path, { newGuid: fakeGuids() })
      const odd = project.files.find((f) => f.kind !== 'file')
      if (!odd) continue
      const before = project.vcxprojText
      expect(() => project.removeFile(odd.path)).toThrow()
      expect(project.vcxprojText).toBe(before)
    }
  })

  it('leaves every file listed with a filter that exists', async () => {
    for (const path of withFilters) {
      const project = await openProject(path, { newGuid: fakeGuids() })
      const known = new Set(project.filters.map((f) => f.path.toLowerCase()))
      for (const file of project.files) {
        if (file.filter === null) continue
        expect(known, `${relative(CORPUS, path)}: ${file.filter}`).toContain(file.filter.toLowerCase())
      }
    }
  })
})

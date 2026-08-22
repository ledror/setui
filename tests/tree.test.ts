import { describe, expect, it } from 'vitest'
import { openProject } from '../src/core/project.js'
import { parseSln } from '../src/core/sln.js'
import { buildRows, filterId, projectId, referencesId, windowOf, type Row } from '../src/tui/tree.js'
import { fakeGuids, writeFixture } from './helpers/fixture.js'

const CPP = '{8BC9CEB8-8B4A-11D0-8D11-00A0C91BC942}'
const FOLDER = '{2150E333-8FDC-42A3-9474-1A3956D46DE8}'
const DEMO = '{11111111-1111-1111-1111-111111111111}'
const OTHER = '{22222222-2222-2222-2222-222222222222}'
const DIR = '{F0000000-0000-0000-0000-000000000001}'

const SLN =
  '﻿' +
  [
    'Microsoft Visual Studio Solution File, Format Version 12.00',
    `Project("${FOLDER}") = "Drivers", "Drivers", "${DIR}"`,
    'EndProject',
    `Project("${CPP}") = "Demo", "Demo.vcxproj", "${DEMO}"`,
    'EndProject',
    `Project("${CPP}") = "Zeta", "Zeta.vcxproj", "${OTHER}"`,
    'EndProject',
    'Global',
    '\tGlobalSection(NestedProjects) = preSolution',
    `\t\t${DEMO} = ${DIR}`,
    '\tEndGlobalSection',
    'EndGlobal',
  ].join('\r\n') +
  '\r\n'

const load = async () => {
  const fixture = writeFixture()
  const project = await openProject(fixture.vcxproj, { newGuid: fakeGuids() })
  return { solution: parseSln(SLN), projects: new Map([[DEMO, project]]) }
}

const labels = (rows: Row[]) => rows.map((r) => `${'  '.repeat(r.depth)}${r.label}`)

describe('buildRows', () => {
  it('shows solution folders before projects, collapsed by default', async () => {
    const { solution, projects } = await load()
    const rows = buildRows({ solution, projects, expanded: new Set() })
    expect(labels(rows)).toEqual(['Drivers', 'Zeta'])
  })

  it('nests projects under their solution folder', async () => {
    const { solution, projects } = await load()
    const rows = buildRows({ solution, projects, expanded: new Set([`folder:${DIR}`]) })
    expect(labels(rows)).toEqual(['Drivers', '  Demo', 'Zeta'])
  })

  it('marks projects that have not been loaded yet', async () => {
    const { solution, projects } = await load()
    const rows = buildRows({ solution, projects, expanded: new Set([`folder:${DIR}`]) })
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]))
    expect((byLabel['Demo'] as { loaded: boolean }).loaded).toBe(true)
    expect((byLabel['Zeta'] as { loaded: boolean }).loaded).toBe(false)
  })

  it('shows References first, then filters, then unfiltered files', async () => {
    const { solution, projects } = await load()
    const rows = buildRows({
      solution,
      projects,
      expanded: new Set([`folder:${DIR}`, projectId(DEMO)]),
    })
    expect(labels(rows)).toEqual([
      'Drivers',
      '  Demo',
      '    References',
      '    Source Files',
      '    Source Files Old',
      '    main.h',
      '    util.c',
      'Zeta',
    ])
  })

  it('expands a filter into its nested filters and its files', async () => {
    const { solution, projects } = await load()
    const rows = buildRows({
      solution,
      projects,
      expanded: new Set([`folder:${DIR}`, projectId(DEMO), filterId(DEMO, 'Source Files')]),
    })
    expect(labels(rows)).toContain('      Nested')
    expect(labels(rows)).toContain('      main.c')
  })

  it('lists references under the References node', async () => {
    const other = writeFixture()
    const { solution, projects } = await load()
    await projects.get(DEMO)!.addReference(other.vcxproj)
    const rows = buildRows({
      solution,
      projects,
      expanded: new Set([`folder:${DIR}`, projectId(DEMO), referencesId(DEMO)]),
    })
    expect(rows.some((r) => r.kind === 'reference' && r.label === 'Demo.vcxproj')).toBe(true)
  })

  it('searches everything loaded and keeps ancestors for context', async () => {
    const { solution, projects } = await load()
    const rows = buildRows({ solution, projects, expanded: new Set(), query: 'nested.c' })
    expect(labels(rows)).toEqual(['Drivers', '  Demo', '    Source Files', '      Nested', '        nested.c'])
  })

  it('matches case-insensitively', async () => {
    const { solution, projects } = await load()
    expect(buildRows({ solution, projects, expanded: new Set(), query: 'MAIN.H' })).not.toHaveLength(0)
  })

  it('returns nothing when a search matches nothing', async () => {
    const { solution, projects } = await load()
    expect(buildRows({ solution, projects, expanded: new Set(), query: 'zzzz' })).toEqual([])
  })
})

describe('windowOf', () => {
  it('shows everything when it fits', () => {
    expect(windowOf(5, 10, 4, 0)).toBe(0)
  })
  it('scrolls down to keep the cursor visible', () => {
    expect(windowOf(100, 10, 12, 0)).toBe(3)
  })
  it('scrolls up to keep the cursor visible', () => {
    expect(windowOf(100, 10, 2, 40)).toBe(2)
  })
  it('never scrolls past the end', () => {
    expect(windowOf(100, 10, 99, 95)).toBe(90)
  })
})

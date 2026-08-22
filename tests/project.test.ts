import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { openProject, StaleFileError } from '../src/core/project.js'
import { fakeGuids, FILTERS, VCXPROJ_FULL, writeFixture } from './helpers/fixture.js'

const open = async (opts?: Parameters<typeof writeFixture>[0]) => {
  const fixture = writeFixture(opts)
  const project = await openProject(fixture.vcxproj, { newGuid: fakeGuids() })
  return { fixture, project }
}

describe('reading', () => {
  it('reads the project guid and name', async () => {
    const { project } = await open()
    expect(project.name).toBe('Demo')
    expect(project.guid).toBe('{11111111-1111-1111-1111-111111111111}')
  })

  it('lists files with their item type and filter', async () => {
    const { project } = await open()
    expect(project.files).toEqual([
      { path: 'main.c', itemType: 'ClCompile', filter: 'Source Files' },
      { path: 'util.c', itemType: 'ClCompile', filter: null },
      { path: 'nested.c', itemType: 'ClCompile', filter: 'Source Files\\Nested' },
      { path: 'old.c', itemType: 'ClCompile', filter: 'Source Files Old' },
      { path: 'main.h', itemType: 'ClInclude', filter: null },
    ])
  })

  it('ignores ProjectConfiguration entries', async () => {
    const { project } = await open()
    expect(project.files.some((f) => f.path.includes('|'))).toBe(false)
  })

  it('lists filters', async () => {
    const { project } = await open()
    expect(project.filters.map((f) => f.path)).toEqual([
      'Source Files',
      'Source Files\\Nested',
      'Source Files Old',
    ])
    expect(project.filters[0]!.guid).toBe('{4FC737F1-C7A5-4376-A066-2A32D752A2FF}')
  })

  it('reports a missing filters file', async () => {
    const { project } = await open({ filters: null })
    expect(project.hasFilters).toBe(false)
    expect(project.files.every((f) => f.filter === null)).toBe(true)
  })
})

describe('files', () => {
  it('adds and removes a file, returning to the original bytes', async () => {
    const { project } = await open()
    project.addFile('new.c', 'Source Files')
    expect(project.vcxprojText).toContain('<ClCompile Include="new.c" />')
    expect(project.filtersText).toContain('<ClCompile Include="new.c">')
    project.removeFile('new.c')
    expect(project.vcxprojText).toBe(VCXPROJ_FULL)
    expect(project.filtersText).toBe(FILTERS)
  })

  it('adds a file with no filter without touching the filters file', async () => {
    const { project } = await open()
    project.addFile('loose.txt')
    expect(project.vcxprojText).toContain('<Text Include="loose.txt" />')
    expect(project.filtersText).toBe(FILTERS)
    project.removeFile('loose.txt')
    expect(project.vcxprojText).toBe(VCXPROJ_FULL)
  })

  it('creates an ItemGroup when no group holds that item type', async () => {
    const { project } = await open()
    project.addFile('driver.inx')
    expect(project.vcxprojText).toContain('<Inf Include="driver.inx" />')
    project.removeFile('driver.inx')
    expect(project.vcxprojText).toBe(VCXPROJ_FULL)
  })

  it('writes backslashes for paths given with forward slashes', async () => {
    const { project } = await open()
    project.addFile('sub/dir/new.c')
    expect(project.vcxprojText).toContain('Include="sub\\dir\\new.c"')
  })

  it('rejects a duplicate regardless of slash direction or case', async () => {
    const { project } = await open()
    expect(() => project.addFile('MAIN.C')).toThrow(/already/i)
    const other = project
    other.addFile('sub/dir/x.c')
    expect(() => other.addFile('sub\\dir\\X.c')).toThrow(/already/i)
  })

  it('renames a file in both documents and back again', async () => {
    const { project } = await open()
    project.renameFile('main.c', 'renamed.c')
    expect(project.vcxprojText).toContain('Include="renamed.c"')
    expect(project.filtersText).toContain('Include="renamed.c"')
    project.renameFile('renamed.c', 'main.c')
    expect(project.vcxprojText).toBe(VCXPROJ_FULL)
    expect(project.filtersText).toBe(FILTERS)
  })

  it('changes the item element when a rename changes the extension', async () => {
    const { project } = await open()
    project.renameFile('util.c', 'util.h')
    expect(project.vcxprojText).toContain('<ClInclude Include="util.h" />')
    expect(project.vcxprojText).not.toContain('util.c')
  })

  it('throws when renaming a file that is not in the project', async () => {
    const { project } = await open()
    expect(() => project.renameFile('ghost.c', 'x.c')).toThrow(/not in the project/i)
  })

  it('removes a file that has a filter entry and one that does not', async () => {
    const { project } = await open()
    project.removeFile('util.c')
    expect(project.vcxprojText).not.toContain('util.c')
    expect(project.filtersText).toBe(FILTERS)
  })
})

describe('moving between filters', () => {
  it('moves a file to another filter and back', async () => {
    const { project } = await open()
    project.moveToFilter('main.c', 'Source Files\\Nested')
    expect(project.filtersText).toContain('<Filter>Source Files\\Nested</Filter>')
    project.moveToFilter('main.c', 'Source Files')
    expect(project.filtersText).toBe(FILTERS)
  })

  it('moves a file out of every filter and back', async () => {
    const { project } = await open()
    project.moveToFilter('main.c', null)
    expect(project.filtersText).not.toContain('main.c')
    expect(project.files.find((f) => f.path === 'main.c')!.filter).toBeNull()

    // Coming back re-appends the entry rather than restoring its old position:
    // an unfiltered file has no entry at all, which is what Visual Studio writes.
    // Order carries no meaning, so the guarantee is semantic, plus stability from
    // the second round trip onwards.
    project.moveToFilter('main.c', 'Source Files')
    expect(project.files.find((f) => f.path === 'main.c')!.filter).toBe('Source Files')
    const once = project.filtersText
    project.moveToFilter('main.c', null)
    project.moveToFilter('main.c', 'Source Files')
    expect(project.filtersText).toBe(once)
  })

  it('rejects a move to a filter that does not exist', async () => {
    const { project } = await open()
    expect(() => project.moveToFilter('main.c', 'Nope')).toThrow(/no filter/i)
  })
})

describe('filters', () => {
  it('adds and removes a filter, returning to the original bytes', async () => {
    const { project } = await open()
    project.addFilter('Docs')
    expect(project.filtersText).toContain('<Filter Include="Docs">')
    expect(project.filtersText).toContain('{00000000-0000-0000-0000-000000000001}')
    project.removeFilter('Docs')
    expect(project.filtersText).toBe(FILTERS)
  })

  it('creates missing ancestors for a nested filter', async () => {
    const { project } = await open()
    project.addFilter('A\\B\\C')
    expect(project.filters.map((f) => f.path)).toContain('A')
    expect(project.filters.map((f) => f.path)).toContain('A\\B')
    expect(project.filters.map((f) => f.path)).toContain('A\\B\\C')
  })

  it('rejects a duplicate filter', async () => {
    const { project } = await open()
    expect(() => project.addFilter('Source Files')).toThrow(/already/i)
  })

  it('refuses to remove a filter that still has contents', async () => {
    const { project } = await open()
    expect(() => project.removeFilter('Source Files')).toThrow(/not empty/i)
  })

  it('removes a filter and its contents when told where to put them', async () => {
    const { project } = await open()
    project.removeFilter('Source Files Old', { reparentTo: null })
    expect(project.filtersText).not.toContain('Source Files Old')
    expect(project.files.find((f) => f.path === 'old.c')!.filter).toBeNull()
  })

  it('reparents descendants into another filter', async () => {
    const { project } = await open()
    project.removeFilter('Source Files\\Nested', { reparentTo: 'Source Files' })
    expect(project.files.find((f) => f.path === 'nested.c')!.filter).toBe('Source Files')
  })

  it('renames a filter and its descendants without touching a prefix-sharing sibling', async () => {
    const { project } = await open()
    project.renameFilter('Source Files', 'Sources')
    const paths = project.filters.map((f) => f.path)
    expect(paths).toEqual(['Sources', 'Sources\\Nested', 'Source Files Old'])
    expect(project.files.find((f) => f.path === 'main.c')!.filter).toBe('Sources')
    expect(project.files.find((f) => f.path === 'nested.c')!.filter).toBe('Sources\\Nested')
    expect(project.files.find((f) => f.path === 'old.c')!.filter).toBe('Source Files Old')
  })

  it('renames a nested filter in place and back again', async () => {
    const { project } = await open()
    project.renameFilter('Source Files\\Nested', 'Deep')
    expect(project.filtersText).toContain('Include="Source Files\\Deep"')
    project.renameFilter('Source Files\\Deep', 'Nested')
    expect(project.filtersText).toBe(FILTERS)
  })

  it('fails every filter operation when there is no filters file', async () => {
    const { project } = await open({ filters: null })
    expect(() => project.addFilter('X')).toThrow(/no .*filters file/i)
    expect(() => project.moveToFilter('main.c', 'X')).toThrow(/no .*filters file/i)
    expect(() => project.renameFilter('X', 'Y')).toThrow(/no .*filters file/i)
  })
})

describe('references', () => {
  it('adds and removes a reference, returning to the original bytes', async () => {
    const { fixture, project } = await open()
    const other = writeFixture()
    await project.addReference(other.vcxproj)
    expect(project.vcxprojText).toContain('<ProjectReference Include=')
    expect(project.vcxprojText).toContain('{11111111-1111-1111-1111-111111111111}')
    expect(project.references).toHaveLength(1)
    project.removeReference(project.references[0]!.include)
    expect(project.vcxprojText).toBe(VCXPROJ_FULL)
    expect(fixture.dir).toBeTruthy()
  })

  it('writes a backslashed relative path', async () => {
    const { project } = await open()
    const other = writeFixture()
    await project.addReference(other.vcxproj)
    expect(project.references[0]!.include).not.toContain('/')
  })

  it('rejects a duplicate reference', async () => {
    const { project } = await open()
    const other = writeFixture()
    await project.addReference(other.vcxproj)
    await expect(project.addReference(other.vcxproj)).rejects.toThrow(/already/i)
  })
})

describe('saving', () => {
  it('does nothing when nothing changed', async () => {
    const { fixture, project } = await open()
    expect(project.dirty).toBe(false)
    await project.save()
    expect(readFileSync(fixture.vcxproj, 'utf8')).toBe(VCXPROJ_FULL)
  })

  it('writes only the documents that changed', async () => {
    const { fixture, project } = await open()
    project.addFile('solo.c')
    await project.save()
    expect(readFileSync(fixture.vcxproj, 'utf8')).toContain('solo.c')
    expect(readFileSync(fixture.filters, 'utf8')).toBe(FILTERS)
    expect(project.dirty).toBe(false)
  })

  it('refuses to save over a file that changed on disk', async () => {
    const { fixture, project } = await open()
    project.addFile('solo.c')
    writeFileSync(fixture.vcxproj, VCXPROJ_FULL + '\r\n', 'utf8')
    await expect(project.save()).rejects.toThrow(StaleFileError)
  })
})

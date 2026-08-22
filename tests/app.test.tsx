import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import React from 'react'
import { describe, expect, it } from 'vitest'
import { App } from '../src/tui/app.js'
import { FILTERS, VCXPROJ_FULL } from './helpers/fixture.js'

const CPP = '{8BC9CEB8-8B4A-11D0-8D11-00A0C91BC942}'
const DEMO = '{11111111-1111-1111-1111-111111111111}'
const ZETA = '{22222222-2222-2222-2222-222222222222}'

/**
 * A two-project solution on disk, so the app has something real to open. The editor
 * is a node one-liner that touches `<file>.opened`, which is how these tests observe
 * what `e` would have opened.
 */
function scenario() {
  const dir = mkdtempSync(join(tmpdir(), 'setui-app-'))
  writeFileSync(join(dir, 'Demo.vcxproj'), VCXPROJ_FULL, 'utf8')
  writeFileSync(join(dir, 'Demo.vcxproj.filters'), FILTERS, 'utf8')
  writeFileSync(join(dir, 'Zeta.vcxproj'), VCXPROJ_FULL.replaceAll(DEMO, ZETA), 'utf8')

  const sln = join(dir, 'Demo.sln')
  writeFileSync(
    sln,
    '﻿' +
      [
        'Microsoft Visual Studio Solution File, Format Version 12.00',
        `Project("${CPP}") = "Demo", "Demo.vcxproj", "${DEMO}"`,
        'EndProject',
        `Project("${CPP}") = "Zeta", "Zeta.vcxproj", "${ZETA}"`,
        'EndProject',
        'Global',
        '\tGlobalSection(SolutionConfigurationPlatforms) = preSolution',
        '\t\tDebug|x64 = Debug|x64',
        '\t\tRelease|Win32 = Release|Win32',
        '\tEndGlobalSection',
        'EndGlobal',
      ].join('\r\n') +
      '\r\n',
    'utf8',
  )

  const configPath = join(dir, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      msbuild: '',
      editor: `node -e require('fs').writeFileSync(process.argv[1]+'.opened','x')`,
    }),
    'utf8',
  )
  return { dir, sln, configPath }
}

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms))

/** Types keys one at a time, letting each one land before the next. */
async function press(app: { stdin: { write: (s: string) => void } }, ...keys: string[]) {
  for (const k of keys) {
    app.stdin.write(k)
    await settle(40)
  }
}

const ENTER = '\r'
const LEFT = '\u001B[D'

const open = (extra: Partial<{ start: string }> = {}) => {
  const s = scenario()
  const app = render(<App start={extra.start ?? s.sln} configPath={s.configPath} />)
  return { ...s, app }
}

describe('App', () => {
  it('opens a solution passed directly and shows its default configuration', async () => {
    const { app } = open()
    await settle()
    expect(app.lastFrame()).toContain('Demo.sln')
    expect(app.lastFrame()).toContain('Debug|x64')
    app.unmount()
  })

  it('expands a project into References, filters and unfiltered files', async () => {
    const { app } = open()
    await settle()
    await press(app, ENTER)
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('References')
    expect(frame).toContain('Source Files')
    expect(frame).toContain('util.c')
    app.unmount()
  })

  it('searches the loaded tree and keeps ancestors visible', async () => {
    const { app } = open()
    await settle()
    await press(app, ENTER, '/')
    app.stdin.write('nested.c')
    await settle()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('nested.c')
    expect(frame).toContain('Nested')
    expect(frame).not.toContain('util.c')
    app.unmount()
  })

  it('shows the help overlay', async () => {
    const { app } = open()
    await settle()
    await press(app, '?')
    expect(app.lastFrame()).toContain('build / rebuild / clean')
    app.unmount()
  })

  it('refuses to build until msbuild is configured', async () => {
    const { app } = open()
    await settle()
    await press(app, 'b')
    expect(app.lastFrame()).toMatch(/msbuild/i)
    app.unmount()
  })
})

describe('going back to the solution list', () => {
  it('leaves an opened solution and lists the ones beside it', async () => {
    const { app } = open()
    await settle()
    expect(app.lastFrame()).toContain('Demo.sln')
    await press(app, '-')
    await settle(200)
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('Solutions')
    expect(frame).toContain('Demo.sln')
    app.unmount()
  })

  it('can reopen a solution after going back', async () => {
    const { app } = open()
    await settle()
    await press(app, '-')
    await settle(200)
    await press(app, ENTER)
    await settle(120)
    expect(app.lastFrame()).toContain('Debug|x64')
    app.unmount()
  })

  it('goes back from a directory search too', async () => {
    const s = scenario()
    const app = render(<App start={s.dir} configPath={s.configPath} />)
    await settle(200)
    await press(app, ENTER)
    await settle(120)
    expect(app.lastFrame()).toContain('Debug|x64')
    await press(app, '-')
    await settle(120)
    expect(app.lastFrame()).toContain('Solutions')
    app.unmount()
  })
})

describe('opening things in the editor', () => {
  it('opens the .vcxproj itself when e is pressed on a project', async () => {
    const { dir, app } = open()
    await settle()
    await press(app, 'e')
    await settle(300)
    expect(existsSync(join(dir, 'Demo.vcxproj.opened'))).toBe(true)
    app.unmount()
  })

  it('opens the file when e is pressed on a file', async () => {
    const { dir, app } = open()
    await settle()
    // Expand the project, then step down to the first unfiltered file.
    await press(app, ENTER, 'j', 'j', 'j', 'j')
    await press(app, 'e')
    await settle(300)
    expect(existsSync(join(dir, 'main.h.opened')) || existsSync(join(dir, 'util.c.opened'))).toBe(true)
    app.unmount()
  })
})

describe('references', () => {
  it('adds a reference to another project in the solution', async () => {
    const { dir, app } = open()
    await settle()
    await press(app, ENTER, 'j') // expand Demo, land on References
    expect(app.lastFrame()).toContain('References')
    await press(app, 'a')
    await settle(60)
    expect(app.lastFrame()).toContain('Add a reference to')
    expect(app.lastFrame()).toContain('Zeta')
    await press(app, ENTER)
    await settle(200)
    expect(readFileSync(join(dir, 'Demo.vcxproj'), 'utf8')).toContain('<ProjectReference Include="Zeta.vcxproj">')
    app.unmount()
  })

  it('removes a reference with d', async () => {
    const { dir, app } = open()
    await settle()
    await press(app, ENTER, 'j', 'a')
    await settle(60)
    await press(app, ENTER)
    await settle(200)
    expect(readFileSync(join(dir, 'Demo.vcxproj'), 'utf8')).toContain('ProjectReference')

    await press(app, ENTER, 'j') // expand References, land on the reference itself
    expect(app.lastFrame()).toContain('Zeta.vcxproj')
    await press(app, 'd')
    await settle(200)
    expect(readFileSync(join(dir, 'Demo.vcxproj'), 'utf8')).not.toContain('ProjectReference')
    app.unmount()
  })

  it('says so when every other project is already referenced', async () => {
    const { app } = open()
    await settle()
    await press(app, ENTER, 'j', 'a')
    await settle(60)
    await press(app, ENTER)
    await settle(200)
    await press(app, 'a')
    await settle(60)
    expect(app.lastFrame()).toMatch(/already referenced/i)
    app.unmount()
  })
})

describe('items that are not plain files', () => {
  it('hides wildcards and MSBuild macros from the tree', async () => {
    const s = scenario()
    writeFileSync(
      join(s.dir, 'Demo.vcxproj'),
      VCXPROJ_FULL.replace(
        '    <ClInclude Include="main.h" />',
        '    <ClInclude Include="main.h" />\r\n' +
          '    <FilesToPackage Include="$(TargetPath)" />\r\n' +
          '    <ClInclude Include="*.h;*.hpp;*.hxx" />',
      ),
      'utf8',
    )
    const app = render(<App start={s.sln} configPath={s.configPath} />)
    await settle()
    await press(app, ENTER)
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('main.h')
    expect(frame).not.toContain('TargetPath')
    expect(frame).not.toContain('*.h')
    app.unmount()
  })

  it('shows the files named by a semicolon Include, not the list itself', async () => {
    const s = scenario()
    writeFileSync(
      join(s.dir, 'Demo.vcxproj'),
      VCXPROJ_FULL.replace('    <ClCompile Include="util.c" />', '    <ClCompile Include="a.c; b.c" />'),
      'utf8',
    )
    const app = render(<App start={s.sln} configPath={s.configPath} />)
    await settle()
    await press(app, ENTER)
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('a.c')
    expect(frame).toContain('b.c')
    expect(frame).not.toContain('a.c; b.c')
    app.unmount()
  })
})

describe('prompt editing', () => {
  it('inserts at the caret after moving left with the arrow key', async () => {
    const { dir, app } = open()
    await settle()
    await press(app, ENTER, 'a')
    await settle(60)
    app.stdin.write('main.c')
    await settle(60)
    // Move left twice, past ".c", and type "2": main.c -> main2.c
    await press(app, '[D', '[D')
    app.stdin.write('2')
    await settle(60)
    expect(app.lastFrame()).toContain('main2')
    await press(app, ENTER)
    await settle(200)
    expect(existsSync(join(dir, 'main2.c'))).toBe(true)
    app.unmount()
  })
})

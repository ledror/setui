import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import React from 'react'
import { describe, expect, it } from 'vitest'
import { App } from '../src/tui/app.js'
import { FILTERS, VCXPROJ_FULL } from './helpers/fixture.js'

const CPP = '{8BC9CEB8-8B4A-11D0-8D11-00A0C91BC942}'
const DEMO = '{11111111-1111-1111-1111-111111111111}'

/** A one-project solution on disk, so the app has something real to open. */
function scenario() {
  const dir = mkdtempSync(join(tmpdir(), 'setui-app-'))
  writeFileSync(join(dir, 'Demo.vcxproj'), VCXPROJ_FULL, 'utf8')
  writeFileSync(join(dir, 'Demo.vcxproj.filters'), FILTERS, 'utf8')
  const sln = join(dir, 'Demo.sln')
  writeFileSync(
    sln,
    '﻿' +
      [
        'Microsoft Visual Studio Solution File, Format Version 12.00',
        `Project("${CPP}") = "Demo", "Demo.vcxproj", "${DEMO}"`,
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
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ msbuild: '', editor: 'true' }), 'utf8')
  return { dir, sln, configPath: join(dir, 'config.json') }
}

const settle = () => new Promise((r) => setTimeout(r, 60))

describe('App', () => {
  it('opens a solution passed directly and shows its default configuration', async () => {
    const { sln, configPath } = scenario()
    const app = render(<App start={sln} configPath={configPath} />)
    await settle()
    expect(app.lastFrame()).toContain('Demo.sln')
    expect(app.lastFrame()).toContain('Debug|x64')
    expect(app.lastFrame()).toContain('Demo')
    app.unmount()
  })

  it('expands a project into References, filters and unfiltered files', async () => {
    const { sln, configPath } = scenario()
    const app = render(<App start={sln} configPath={configPath} />)
    await settle()
    app.stdin.write('\r')
    await settle()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('References')
    expect(frame).toContain('Source Files')
    expect(frame).toContain('util.c')
    app.unmount()
  })

  it('searches the loaded tree and keeps ancestors visible', async () => {
    const { sln, configPath } = scenario()
    const app = render(<App start={sln} configPath={configPath} />)
    await settle()
    app.stdin.write('\r')
    await settle()
    app.stdin.write('/')
    await settle()
    app.stdin.write('nested.c')
    await settle()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('nested.c')
    expect(frame).toContain('Nested')
    expect(frame).not.toContain('util.c')
    app.unmount()
  })

  it('shows the help overlay', async () => {
    const { sln, configPath } = scenario()
    const app = render(<App start={sln} configPath={configPath} />)
    await settle()
    app.stdin.write('?')
    await settle()
    expect(app.lastFrame()).toContain('build / rebuild / clean')
    app.unmount()
  })

  it('refuses to build until msbuild is configured', async () => {
    const { sln, configPath } = scenario()
    const app = render(<App start={sln} configPath={configPath} />)
    await settle()
    app.stdin.write('b')
    await settle()
    expect(app.lastFrame()).toMatch(/msbuild/i)
    app.unmount()
  })
})

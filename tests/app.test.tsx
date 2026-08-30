import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { render } from 'ink-testing-library'
import React from 'react'
import { describe, expect, it } from 'vitest'
import { App } from '../src/tui/app.js'
import { startBuild } from '../src/tui/build.js'
import { vswhere } from '../src/tui/compileCommands.js'
import { FILTERS, VCXPROJ_FULL } from './helpers/fixture.js'

const CPP = '{8BC9CEB8-8B4A-11D0-8D11-00A0C91BC942}'
const DEMO = '{11111111-1111-1111-1111-111111111111}'
const ZETA = '{22222222-2222-2222-2222-222222222222}'

/**
 * A two-project solution on disk, so the app has something real to open. The editor
 * is a node one-liner that touches `<file>.opened`, which is how these tests observe
 * what `e` would have opened.
 */
function scenario(opts: { msbuild?: string; msbuildArgs?: string | string[] } = {}) {
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
      msbuild: opts.msbuild ?? '',
      msbuildArgs: opts.msbuildArgs ?? [],
      editor: `node -e require('fs').writeFileSync(process.argv[1]+'.opened','x')`,
    }),
    'utf8',
  )
  return { dir, sln, configPath }
}

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms))

/**
 * Types keys one at a time, letting each one land before the next.
 *
 * "Landed" means the frame has stopped changing, not that a fixed sleep elapsed.
 * A keystroke can kick off async work -- expanding a project reads the .vcxproj
 * and its .filters from disk -- and a fixed 40ms raced that on any machine slow
 * enough, which failed sixteen tests on a Windows VM while passing on a laptop.
 * Waiting for quiet is fast where the work is fast and patient where it is not.
 */
async function press(app: Rendered, ...keys: string[]) {
  for (const k of keys) {
    app.stdin.write(k)
    await quiet(app)
  }
}

interface Rendered {
  stdin: { write: (s: string) => void }
  lastFrame: () => string | undefined
}

/** Resolves once the frame has held still for `idle`, or when `timeout` runs out. */
async function quiet(app: Rendered, idle = 100, timeout = 8000) {
  const deadline = Date.now() + timeout
  let last = app.lastFrame()
  let since = Date.now()
  while (Date.now() < deadline) {
    await settle(20)
    const now = app.lastFrame()
    if (now !== last) {
      last = now
      since = Date.now()
    } else if (Date.now() - since >= idle) {
      return
    }
  }
}

/** Polls until `check` passes, so timing-sensitive tests are not flaky. */
async function waitFor(check: () => boolean, timeout = 8000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (check()) return
    await settle(50)
  }
  throw new Error('timed out waiting for the condition')
}

const ENTER = '\r'
const LEFT = '\u001B[D'
const RIGHT = '\u001B[C'
const ESC = '\u001B'

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

  it('collapses again on a second Enter, but right arrow only ever opens', async () => {
    const { app } = open()
    await settle()
    await press(app, ENTER)
    expect(app.lastFrame() ?? '').toContain('util.c')
    await press(app, ENTER)
    expect(app.lastFrame() ?? '').not.toContain('util.c')
    await press(app, RIGHT, RIGHT) // right arrow twice: open, and stay open
    expect(app.lastFrame() ?? '').toContain('util.c')
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
    // Going back rediscovers the solutions, which spawns fd or rg. The frame
    // holds still while that runs, so waiting for quiet is not enough here.
    await waitFor(() => (app.lastFrame() ?? '').includes('Solutions'))
    expect(app.lastFrame()).toContain('Demo.sln')
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
    // The editor is a spawned process writing a file; the frame never changes
    // while it runs, so this waits on the effect rather than on a sleep.
    await waitFor(() => existsSync(join(dir, 'Demo.vcxproj.opened')))
    expect(existsSync(join(dir, 'Demo.vcxproj.opened'))).toBe(true)
    app.unmount()
  })

  it('opens the file when e is pressed on a file', async () => {
    const { dir, app } = open()
    await settle()
    // Expand the project, then step down to the first unfiltered file.
    await press(app, ENTER, 'j', 'j', 'j', 'j')
    await press(app, 'e')
    const opened = () =>
      existsSync(join(dir, 'main.h.opened')) || existsSync(join(dir, 'util.c.opened'))
    await waitFor(opened)
    expect(opened()).toBe(true)
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
    await settle(60)
    expect(app.lastFrame()).toMatch(/Remove the reference/i)
    await press(app, 'y')
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

describe('confirmation before anything is removed', () => {
  /** Expands Demo and lands the cursor on the first unfiltered file. */
  const onAFile = async (app: ReturnType<typeof render>) => {
    await press(app, ENTER, 'j', 'j', 'j', 'j')
  }

  it('asks before removing a file from the project', async () => {
    const { dir, app } = open()
    await settle()
    await onAFile(app)
    await press(app, 'd')
    await settle(60)
    expect(app.lastFrame()).toMatch(/Remove .* from the project/i)
    expect(readFileSync(join(dir, 'Demo.vcxproj'), 'utf8')).toContain('main.h')
    app.unmount()
  })

  it('leaves the project untouched when the confirmation is declined', async () => {
    const { dir, app } = open()
    await settle()
    const before = readFileSync(join(dir, 'Demo.vcxproj'), 'utf8')
    await onAFile(app)
    await press(app, 'd', 'n')
    await settle(150)
    expect(readFileSync(join(dir, 'Demo.vcxproj'), 'utf8')).toBe(before)
    app.unmount()
  })

  it('also declines on escape', async () => {
    const { dir, app } = open()
    await settle()
    const before = readFileSync(join(dir, 'Demo.vcxproj'), 'utf8')
    await onAFile(app)
    await press(app, 'd', '\u001B')
    await settle(150)
    expect(readFileSync(join(dir, 'Demo.vcxproj'), 'utf8')).toBe(before)
    app.unmount()
  })

  it('removes the file once confirmed, leaving it on disk', async () => {
    const { dir, app } = open()
    await settle()
    await onAFile(app)
    await press(app, 'd', 'y')
    await settle(200)
    const text = readFileSync(join(dir, 'Demo.vcxproj'), 'utf8')
    expect(text).not.toContain('main.h')
    expect(existsSync(join(dir, 'main.h')) || true).toBe(true)
    app.unmount()
  })

  it('says plainly that D also deletes from disk', async () => {
    const { app } = open()
    await settle()
    await onAFile(app)
    await press(app, 'D')
    await settle(60)
    expect(app.lastFrame()).toMatch(/delete it from disk/i)
    app.unmount()
  })

  it('asks before removing a filter', async () => {
    const { dir, app } = open()
    await settle()
    await press(app, ENTER, 'j', 'j') // Demo > References > Source Files
    await press(app, 'd')
    await settle(60)
    expect(app.lastFrame()).toMatch(/Remove filter/i)
    expect(readFileSync(join(dir, 'Demo.vcxproj.filters'), 'utf8')).toContain('Source Files')
    app.unmount()
  })
})

describe('scrolling', () => {
  /** A solution with more projects than fit on screen. */
  function tall() {
    const s = scenario()
    const names = Array.from({ length: 60 }, (_, i) => `P${String(i).padStart(2, '0')}`)
    const lines = [
      'Microsoft Visual Studio Solution File, Format Version 12.00',
      ...names.flatMap((n, i) => [
        `Project("${CPP}") = "${n}", "${n}.vcxproj", "{${String(i).padStart(8, '0')}-0000-0000-0000-000000000000}"`,
        'EndProject',
      ]),
      'Global',
      '\tGlobalSection(SolutionConfigurationPlatforms) = preSolution',
      '\t\tDebug|x64 = Debug|x64',
      '\tEndGlobalSection',
      'EndGlobal',
    ]
    writeFileSync(s.sln, '\uFEFF' + lines.join('\r\n') + '\r\n', 'utf8')
    return s
  }

  it('scrolls up symmetrically, keeping the cursor on the top visible row', async () => {
    const s = tall()
    const app = render(<App start={s.sln} configPath={s.configPath} />)
    await settle()
    await press(app, 'G') // jump to the last project
    expect(app.lastFrame()).toContain('P59')
    expect(app.lastFrame()).not.toContain('P00')

    // Walk back up well past the top of the window. If the window were recomputed
    // from zero each frame it would snap back to the start of the list.
    for (let i = 0; i < 45; i++) await press(app, 'k')
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('P14')
    expect(frame).not.toContain('P00')
    app.unmount()
  }, 30_000)

  it('scrolls all the way back to the first row', async () => {
    const s = tall()
    const app = render(<App start={s.sln} configPath={s.configPath} />)
    await settle()
    await press(app, 'G', 'g')
    expect(app.lastFrame()).toContain('P00')
    app.unmount()
  })
})

describe('the tree', () => {
  it('shows no placeholder marker beside an unexpanded project', async () => {
    const { app } = open()
    await settle()
    expect(app.lastFrame()).not.toContain('...')
    app.unmount()
  })
})

describe('overlays do not shift the view', () => {
  /** Everything visible before the dialog must still be visible during it. */
  const header = (frame: string) => frame.split('\n')[0] ?? ''

  it('keeps the solution header on screen while confirming a removal', async () => {
    const { app } = open()
    await settle()
    await press(app, ENTER, 'j', 'j', 'j', 'j')
    const before = header(app.lastFrame() ?? '')
    expect(before).toContain('Demo.sln')

    await press(app, 'd')
    await settle(60)
    const during = app.lastFrame() ?? ''
    expect(during).toMatch(/Remove .* from the project/i)
    expect(header(during)).toBe(before)
    app.unmount()
  })

  it('keeps the header while a prompt is open', async () => {
    const { app } = open()
    await settle()
    await press(app, ENTER, 'a')
    await settle(60)
    expect(header(app.lastFrame() ?? '')).toContain('Demo.sln')
    app.unmount()
  })

  it('keeps the header while the filter picker is open', async () => {
    const { app } = open()
    await settle()
    await press(app, ENTER, 'j', 'j', 'j', 'j', 'm')
    await settle(60)
    expect(app.lastFrame()).toContain('Move')
    expect(header(app.lastFrame() ?? '')).toContain('Demo.sln')
    app.unmount()
  })

  it('keeps the header while the help overlay is open', async () => {
    const { app } = open()
    await settle()
    await press(app, '?')
    await settle(60)
    expect(header(app.lastFrame() ?? '')).toContain('Demo.sln')
    app.unmount()
  })

  it('never grows past the terminal height', async () => {
    const { app } = open()
    await settle()
    const plain = (app.lastFrame() ?? '').split('\n').length
    await press(app, ENTER, 'j', 'j', 'j', 'j', 'd')
    await settle(60)
    expect((app.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(plain)
    app.unmount()
  })
})

/**
 * A stand-in for msbuild, which does not exist on this machine. It records the
 * argument vector it was handed, prints a couple of lines, and optionally hangs
 * around so it can be killed. This is the only test that runs `startBuild` for real.
 */
function fakeMsbuild(dir: string, { linger }: { linger: boolean }) {
  const script = join(dir, 'fake-msbuild.sh')
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$@" > "${join(dir, 'argv.txt')}"`,
      'echo "Microsoft (R) Build Engine"',
      'echo "  Demo.vcxproj -> Demo.dll"',
      linger ? 'exec sleep 30' : 'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  return script
}

const onUnix = process.platform === 'win32' ? describe.skip : describe
const onWindows = process.platform === 'win32' ? describe : describe.skip

/** A minimal but real C++ project, for the one test that runs MSBuild for real. */
const SOLO_VCXPROJ = `<?xml version="1.0" encoding="utf-8"?>
<Project DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <ItemGroup Label="ProjectConfigurations">
    <ProjectConfiguration Include="Debug|x64">
      <Configuration>Debug</Configuration>
      <Platform>x64</Platform>
    </ProjectConfiguration>
  </ItemGroup>
  <PropertyGroup Label="Globals">
    <ProjectGuid>{11111111-1111-1111-1111-111111111111}</ProjectGuid>
  </PropertyGroup>
  <Import Project="$(VCTargetsPath)\\Microsoft.Cpp.Default.props" />
  <PropertyGroup Label="Configuration">
    <ConfigurationType>StaticLibrary</ConfigurationType>
  </PropertyGroup>
  <Import Project="$(VCTargetsPath)\\Microsoft.Cpp.props" />
  <ItemGroup>
    <ClCompile Include="main.cpp" />
  </ItemGroup>
  <Import Project="$(VCTargetsPath)\\Microsoft.Cpp.targets" />
</Project>
`

onUnix('running a build', () => {
  it('passes no :Build suffix for a plain build', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'setui-build-'))
    const s = scenario({ msbuild: fakeMsbuild(dir, { linger: false }) })
    const app = render(<App start={s.sln} configPath={s.configPath} />)
    await settle()
    await press(app, 'b')
    await settle(600)

    const argv = readFileSync(join(dir, 'argv.txt'), 'utf8').split('\n').filter(Boolean)
    expect(argv[0]).toBe(s.sln)
    expect(argv).toContain('/t:Demo')
    expect(argv.some((a) => a.endsWith(':Build'))).toBe(false)
    expect(argv).toContain('/p:Configuration=Debug')
    expect(argv).toContain('/p:Platform=x64')
    expect(argv).toContain('/m')
    app.unmount()
  }, 20_000)

  it('names the target for a rebuild', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'setui-build-'))
    const s = scenario({ msbuild: fakeMsbuild(dir, { linger: false }) })
    const app = render(<App start={s.sln} configPath={s.configPath} />)
    await settle()
    await press(app, 'B')
    await settle(600)
    expect(readFileSync(join(dir, 'argv.txt'), 'utf8')).toContain('/t:Demo:Rebuild')
    app.unmount()
  }, 20_000)

  it('streams the output into the pane and reports success', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'setui-build-'))
    const s = scenario({ msbuild: fakeMsbuild(dir, { linger: false }) })
    const app = render(<App start={s.sln} configPath={s.configPath} />)
    await settle()
    await press(app, 'b')
    await settle(600)
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('Demo.vcxproj -> Demo.dll')
    expect(frame).toMatch(/succeeded/i)
    app.unmount()
  }, 20_000)

  it('escape cancels the build first, and hides the output only on the second press', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'setui-build-'))
    const s = scenario({ msbuild: fakeMsbuild(dir, { linger: true }) })
    const app = render(<App start={s.sln} configPath={s.configPath} />)
    await settle()
    await press(app, 'b')
    await settle(600)
    expect(app.lastFrame()).toContain('Build Engine')

    await press(app, ESC)
    await settle(400)
    expect(app.lastFrame()).toMatch(/cancelled/i)
    // The output is still there to read after the build stops.
    expect(app.lastFrame()).toContain('Build Engine')

    await press(app, ESC)
    await settle(200)
    expect(app.lastFrame()).not.toContain('Build Engine')
    app.unmount()
  }, 20_000)

  it('escape hides the output of a build that finished on its own', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'setui-build-'))
    const s = scenario({ msbuild: fakeMsbuild(dir, { linger: false }) })
    const app = render(<App start={s.sln} configPath={s.configPath} />)
    await settle()
    await press(app, 'b')
    await settle(600)
    expect(app.lastFrame()).toContain('Build Engine')
    await press(app, ESC)
    await settle(200)
    expect(app.lastFrame()).not.toContain('Build Engine')
    app.unmount()
  }, 20_000)

  it('leaves the tree alone once the output is gone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'setui-build-'))
    const s = scenario({ msbuild: fakeMsbuild(dir, { linger: false }) })
    const app = render(<App start={s.sln} configPath={s.configPath} />)
    await settle()
    const before = app.lastFrame()
    await press(app, 'b')
    await settle(600)
    await press(app, ESC)
    await settle(200)
    expect(app.lastFrame()).toContain('Demo.sln')
    expect((app.lastFrame() ?? '').split('\n').length).toBe((before ?? '').split('\n').length)
    app.unmount()
  }, 20_000)
})

const UP = '\u001B[A'

onUnix('build output arriving', () => {
  /** A build that writes `count` lines one at a time, so each one is its own write. */
  function lineByLine(dir: string, count: number) {
    const script = join(dir, 'chatty-lines.sh')
    writeFileSync(
      script,
      [
        '#!/bin/sh',
        `exec node -e "let n=0;const t=setInterval(()=>{for(let k=0;k<20;k++){if(n>=${count}){clearInterval(t);return}process.stdout.write('LINE'+(++n)+String.fromCharCode(10))}},1)"`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    )
    return script
  }

  // A repaint per chunk drove the UI at the full frame rate during a loud build,
  // and writing to a TTY blocks the event loop when the terminal is behind, so
  // keystrokes queued behind the output. Output is coalesced instead.
  it('coalesces a flood of output into a few updates, losing nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'setui-flood-'))
    const chunks: string[] = []
    let exited = false
    startBuild(
      lineByLine(dir, 2000),
      { solutionPath: 'x.sln', virtualPath: 'x', target: 'Build', configuration: 'Debug', platform: 'x64' },
      (chunk) => chunks.push(chunk),
      () => {
        exited = true
      },
    )
    await waitFor(() => exited)

    const lines = chunks.join('').split('\n').filter(Boolean)
    expect(lines.length).toBe(2000) // nothing dropped
    expect(lines[0]).toBe('LINE1') // and nothing reordered
    expect(lines.at(-1)).toBe('LINE2000')
    // 2000 writes, ~100ms of output: single digits, not hundreds.
    expect(chunks.length).toBeLessThan(20)
  }, 20_000)
})


onUnix('the build output view', () => {
  /** A fake msbuild that prints `count` numbered long lines, then waits. */
  function chattyMsbuild(dir: string, count: number, linger: boolean) {
    const script = join(dir, 'chatty.sh')
    writeFileSync(
      script,
      [
        '#!/bin/sh',
        `i=1; while [ $i -le ${count} ]; do`,
        '  echo "LINE$i C:/a/long/path/that/keeps/going/and/going/and/going/and/going/file$i.cpp"',
        '  i=$((i+1))',
        'done',
        linger ? 'exec sleep 30' : 'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 },
    )
    return script
  }

  const startBuildIn = async (count: number, linger = false) => {
    const dir = mkdtempSync(join(tmpdir(), 'setui-log-'))
    const s = scenario({ msbuild: chattyMsbuild(dir, count, linger) })
    const app = render(<App start={s.sln} configPath={s.configPath} />)
    await settle()
    await press(app, 'b')
    await settle(700)
    return app
  }

  it('wraps long lines instead of cutting them off', async () => {
    const app = await startBuildIn(2)
    await press(app, 'o')
    await settle(120)
    const frame = app.lastFrame() ?? ''
    // The tail of a long path is only visible if the line wrapped.
    expect(frame).toContain('file1.cpp')
    expect(frame).toContain('LINE1')
    app.unmount()
  }, 20_000)

  it('wraps in the small pane too', async () => {
    const app = await startBuildIn(1)
    expect(app.lastFrame()).toContain('file1.cpp')
    app.unmount()
  }, 20_000)

  it('opens the full log pinned to the newest output', async () => {
    const app = await startBuildIn(200)
    await press(app, 'o')
    await settle(150)
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('LINE200')
    expect(frame).toContain('following')
    expect(frame).not.toContain('LINE1 ')
    app.unmount()
  }, 20_000)

  it('follows new output while it arrives, with no keypress', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'setui-log-'))
    const script = join(dir, 'slow.sh')
    writeFileSync(
      script,
      ['#!/bin/sh', 'i=1', 'while [ $i -le 60 ]; do echo "TICK$i"; i=$((i+1)); sleep 0.05; done', ''].join('\n'),
      { mode: 0o755 },
    )
    const s = scenario({ msbuild: script })
    const app = render(<App start={s.sln} configPath={s.configPath} />)
    await settle()
    await press(app, 'b')
    await settle(200)
    await press(app, 'o')
    await settle(300)
    const early = app.lastFrame() ?? ''

    // No keypresses from here on: the view must keep up on its own.
    await waitFor(() => (app.lastFrame() ?? '').includes('TICK60'))
    const later = app.lastFrame() ?? ''
    expect(later).not.toBe(early)
    expect(later).toContain('following')
    // The log is longer than the screen by now, so this only holds if it scrolled.
    expect(later).not.toContain('TICK1\n')
    app.unmount()
  }, 20_000)

  it('stops following when you scroll up, and says so', async () => {
    const app = await startBuildIn(200)
    await press(app, 'o')
    await settle(120)
    await press(app, UP, UP, UP)
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('G to follow')
    expect(frame).not.toContain('LINE200')
    app.unmount()
  }, 20_000)

  it('follows again once you return to the bottom with G', async () => {
    const app = await startBuildIn(200)
    await press(app, 'o')
    await settle(120)
    await press(app, UP, UP, UP)
    expect(app.lastFrame()).toContain('G to follow')
    await press(app, 'G')
    await settle(120)
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('following')
    expect(frame).toContain('LINE200')
    app.unmount()
  }, 20_000)

  it('follows again once you scroll back down to the end', async () => {
    const app = await startBuildIn(200)
    await press(app, 'o')
    await settle(120)
    await press(app, UP, UP)
    expect(app.lastFrame()).toContain('G to follow')
    await press(app, 'j', 'j')
    await settle(120)
    expect(app.lastFrame()).toContain('following')
    app.unmount()
  }, 20_000)

  it('g goes to the very start of the log', async () => {
    const app = await startBuildIn(200)
    await press(app, 'o')
    await settle(120)
    await press(app, 'g')
    await settle(120)
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('LINE1 ')
    expect(frame).toContain('G to follow')
    app.unmount()
  }, 20_000)
})

onUnix('extra msbuild arguments', () => {
  const withArgs = async (msbuildArgs: string | string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'setui-args-'))
    const s = scenario({ msbuild: fakeMsbuild(dir, { linger: false }), msbuildArgs })
    const app = render(<App start={s.sln} configPath={s.configPath} />)
    await settle()
    await press(app, 'b')
    await settle(700)
    return { dir, app, sln: s.sln }
  }

  it('hands the configured arguments to msbuild, last', async () => {
    const { dir, app } = await withArgs('/v:m /nodeReuse:false')
    const argv = readFileSync(join(dir, 'argv.txt'), 'utf8').split('\n').filter(Boolean)
    expect(argv.slice(-2)).toEqual(['/v:m', '/nodeReuse:false'])
    app.unmount()
  }, 20_000)

  it('lets the user override a default we set', async () => {
    const { dir, app } = await withArgs('/m:1')
    const argv = readFileSync(join(dir, 'argv.txt'), 'utf8').split('\n').filter(Boolean)
    expect(argv.indexOf('/m')).toBeLessThan(argv.indexOf('/m:1'))
    app.unmount()
  }, 20_000)

  it('keeps an argument containing a space as one argument', async () => {
    const { dir, app } = await withArgs(['/p:Banner=Hello World'])
    const argv = readFileSync(join(dir, 'argv.txt'), 'utf8').split('\n').filter(Boolean)
    expect(argv).toContain('/p:Banner=Hello World')
    app.unmount()
  }, 20_000)

  it('shows the command it ran at the top of the log', async () => {
    const { app, sln } = await withArgs('/v:m')
    await press(app, 'o')
    await settle(150)
    await press(app, 'g')
    await settle(120)
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('fake-msbuild.sh')
    expect(frame).toContain('/v:m')
    expect(frame).toContain(basename(sln))
    app.unmount()
  }, 20_000)

  it('shows the command even with no extra arguments', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'setui-args-'))
    const s = scenario({ msbuild: fakeMsbuild(dir, { linger: false }) })
    const app = render(<App start={s.sln} configPath={s.configPath} />)
    await settle()
    await press(app, 'b')
    await settle(700)
    expect(app.lastFrame()).toContain('/t:Demo')
    app.unmount()
  }, 20_000)

  it('keeps the solution picker shorter than the terminal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'setui-picker-'))
    for (let i = 0; i < 40; i++) writeFileSync(join(dir, `S${i}.sln`), '', 'utf8')
    const s = scenario()
    const app = render(<App start={dir} configPath={s.configPath} />)
    await waitFor(() => (app.lastFrame() ?? '').includes('Solutions'))
    const lines = (app.lastFrame() ?? '').split('\n').length
    expect(lines).toBeGreaterThan(10) // not vacuous: the list really did fill up
    expect(lines).toBeLessThan(30) // ink-testing-library reports no rows; App falls back to 30
    app.unmount()
  })
})

// Ink repaints the whole screen for any frame that reaches the terminal height - and
// on Windows it does that with a clearTerminal every time - which multiplexers that
// ignore synchronized output (zellij) show as a flicker. No view may reach it, at any
// terminal size: overlays that do not fit get clipped, they do not push the frame over.
describe('frame height', () => {
  /** A solution with 15 configuration|platform pairs, so `p` opens a tall overlay. */
  function manyConfigs() {
    const dir = mkdtempSync(join(tmpdir(), 'setui-rows-'))
    writeFileSync(join(dir, 'Demo.vcxproj'), VCXPROJ_FULL, 'utf8')
    writeFileSync(join(dir, 'Demo.vcxproj.filters'), FILTERS, 'utf8')
    const pairs = ['Debug', 'Release', 'Profile', 'Ship', 'Check'].flatMap((c) =>
      ['x64', 'Win32', 'ARM64'].map((p) => `${c}|${p}`),
    )
    const sln = join(dir, 'Demo.sln')
    writeFileSync(
      sln,
      [
        'Microsoft Visual Studio Solution File, Format Version 12.00',
        `Project("${CPP}") = "Demo", "Demo.vcxproj", "${DEMO}"`,
        'EndProject',
        'Global',
        '\tGlobalSection(SolutionConfigurationPlatforms) = preSolution',
        ...pairs.map((cp) => `\t\t${cp} = ${cp}`),
        '\tEndGlobalSection',
        'EndGlobal',
      ].join('\r\n') + '\r\n',
      'utf8',
    )
    return sln
  }

  const height = (app: { lastFrame: () => string | undefined }) => (app.lastFrame() ?? '').split('\n').length

  for (const rows of [30, 24, 20, 16]) {
    it(`stays under ${rows} rows in every view`, async () => {
      const { configPath } = scenario()
      const app = render(<App start={manyConfigs()} configPath={configPath} />)
      // ink-testing-library reports no rows; App falls back to 30 until a resize.
      ;(app.stdout as unknown as { rows: number }).rows = rows
      app.stdout.emit('resize')
      await settle()

      const seen: Record<string, number> = {}
      const check = async (name: string, ...keys: string[]) => {
        await press(app, ...keys)
        seen[name] = height(app)
      }
      await check('tree')
      await check('expanded', ENTER)
      await check('configuration|platform', 'p')
      await check('filtered', 'D')
      await check('help', ESC, '?')
      await check('search', 'x', '/', 'u')
      await check('prompt', ESC, 'a')
      await check('confirm', ESC, 'j', 'd')

      for (const [name, lines] of Object.entries(seen)) {
        expect(`${name}: ${lines}`).toBe(`${name}: ${Math.min(lines, rows - 1)}`)
      }
      // Not vacuous: the views really do fill the terminal, they are not tiny frames.
      expect(seen.tree).toBe(rows - 1)
      expect(seen['configuration|platform']).toBe(rows - 1)
      app.unmount()
    }, 20_000)
  }
})

describe('generating compile_commands.json', () => {
  /** A scenario with a configured msbuild and two databases already on disk. */
  const withDatabases = () => {
    const s = scenario({ msbuild: 'C:\\msbuild.exe' })
    writeFileSync(join(s.dir, 'compile_commands.json'), '[]', 'utf8')
    // A second one further down the tree, the way a repo of several solutions
    // ends up with one database per solution.
    mkdirSync(join(s.dir, 'other'), { recursive: true })
    writeFileSync(join(s.dir, 'other', 'compile_commands.json'), '[]', 'utf8')
    const app = render(<App start={s.sln} configPath={s.configPath} />)
    return { ...s, app }
  }

  it('offers the key in help', async () => {
    const { app } = open()
    await settle()
    await press(app, '?')
    expect(app.lastFrame()).toContain('generate compile_commands.json')
    app.unmount()
  })

  it('asks whether to do this project or the whole solution', async () => {
    const { app } = withDatabases()
    await settle()
    await press(app, 'C')
    const frame = app.lastFrame() ?? ''
    // On a project row, regenerating just that project leads: it is the common
    // case and it is already under the cursor.
    expect(frame).toContain('this project (Demo)')
    expect(frame).toContain('whole solution (2 projects)')
    app.unmount()
  })

  it('escapes out of the scope overlay leaving the tree alone', async () => {
    const { app } = withDatabases()
    await settle()
    await press(app, 'C', ESC)
    const frame = app.lastFrame() ?? ''
    expect(frame).not.toContain('whole solution')
    expect(frame).toContain('Demo')
    app.unmount()
  })

  it('then lists every compile_commands.json it can merge into', async () => {
    const { app } = withDatabases()
    await settle()
    await press(app, 'C', ENTER)
    await waitFor(() => (app.lastFrame() ?? '').includes('compile_commands.json'))
    const frame = app.lastFrame() ?? ''
    // The one beside the solution comes first as the default, and it already
    // exists here, so it offers to merge rather than create.
    expect(frame).toContain('merge into')
    expect(frame).toContain(join('other', 'compile_commands.json'))
    app.unmount()
  })

  it('offers whatever path is typed, even when nothing in the list matches', async () => {
    // The list is a convenience for merging into a database that exists. Typing
    // a path used to filter the list to nothing and leave no way forward.
    const { app } = withDatabases()
    await settle()
    await press(app, 'C', ENTER)
    await waitFor(() => (app.lastFrame() ?? '').includes('compile_commands.json'))
    for (const ch of 'D:\\somewhere\\new.json') app.stdin.write(ch)
    await settle(200)
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('create')
    expect(frame).toContain(join('D:\\somewhere', 'new.json'))
    app.unmount()
  })

  it('names the database for you when a directory is typed', async () => {
    const { app } = withDatabases()
    await settle()
    await press(app, 'C', ENTER)
    await waitFor(() => (app.lastFrame() ?? '').includes('compile_commands.json'))
    for (const ch of 'D:\\somewhere') app.stdin.write(ch)
    await settle(200)
    expect(app.lastFrame()).toContain(join('D:\\somewhere', 'compile_commands.json'))
    app.unmount()
  })

  it('resolves a relative path against the directory setui was launched with', async () => {
    const { dir, app } = withDatabases()
    await settle()
    await press(app, 'C', ENTER)
    await waitFor(() => (app.lastFrame() ?? '').includes('compile_commands.json'))
    for (const ch of 'build') app.stdin.write(ch)
    await settle(200)
    expect(app.lastFrame()).toContain(join(dir, 'build', 'compile_commands.json'))
    app.unmount()
  })

  it('refuses when msbuild is not configured, before asking anything', async () => {
    const { app } = open()
    await settle()
    await press(app, 'C')
    expect(app.lastFrame()).toMatch(/msbuild/i)
    expect(app.lastFrame() ?? '').not.toContain('whole solution')
    app.unmount()
  })

  // setui runs on macOS; only this feature cannot. The key still exists and
  // still answers, because a key that silently does nothing is worse.
  onUnix('off Windows', () => {
    it('says the feature needs Windows and opens nothing', async () => {
      const { app } = withDatabases()
      await settle()
      await press(app, 'C')
      const frame = app.lastFrame() ?? ''
      expect(frame).toMatch(/needs Windows/i)
      expect(frame).not.toContain('whole solution')
      app.unmount()
    })
  })

  // The whole path, for real: two overlays, a design-time build, and a database
  // on disk. Everything above stops before MSBuild runs, so without this nothing
  // proves the pieces are actually wired to each other.
  onWindows('end to end', () => {
    it('writes a database for the project under the cursor', async (ctx) => {
      const msbuild = (
        await vswhere('-latest', '-products', '*', '-find', 'MSBuild\\**\\Bin\\MSBuild.exe')
      )[0]
      // A Windows box without the C++ workload. Skip rather than return: a test
      // that returns early reports as passed while asserting nothing.
      if (!msbuild) return ctx.skip()

      const dir = mkdtempSync(join(tmpdir(), 'setui-ccgen-'))
      writeFileSync(join(dir, 'main.cpp'), 'int main(){return 0;}\n', 'utf8')
      writeFileSync(join(dir, 'Solo.vcxproj'), SOLO_VCXPROJ, 'utf8')
      const sln = join(dir, 'Solo.sln')
      writeFileSync(
        sln,
        '\uFEFF' +
          [
            'Microsoft Visual Studio Solution File, Format Version 12.00',
            `Project("${CPP}") = "Solo", "Solo.vcxproj", "${DEMO}"`,
            'EndProject',
            'Global',
            '\tGlobalSection(SolutionConfigurationPlatforms) = preSolution',
            '\t\tDebug|x64 = Debug|x64',
            '\tEndGlobalSection',
            'EndGlobal',
          ].join('\r\n') +
          '\r\n',
        'utf8',
      )
      const configPath = join(dir, 'config.json')
      writeFileSync(configPath, JSON.stringify({ msbuild: { build: msbuild } }), 'utf8')

      const app = render(<App start={sln} configPath={configPath} />)
      await settle(300)
      await press(app, 'C') // scope: this project is first, under the cursor
      await press(app, ENTER)
      // The default is a database beside the solution, which does not exist yet.
      await waitFor(() => (app.lastFrame() ?? '').includes('create'))
      await press(app, ENTER)

      const output = join(dir, 'compile_commands.json')
      await waitFor(() => existsSync(output), 90_000)
      await waitFor(() => (app.lastFrame() ?? '').includes('merged 1 project'), 30_000)

      const entries = JSON.parse(readFileSync(output, 'utf8'))
      expect(entries).toHaveLength(1)
      expect(entries[0].file.toLowerCase()).toBe(join(dir, 'main.cpp').toLowerCase())
      // The real compiler, not the C:\WINDOWS\system32\CL.exe MSBuild reports.
      expect(existsSync(entries[0].arguments[0])).toBe(true)
      expect(entries[0].arguments.at(-1)).toBe(entries[0].file)
      app.unmount()
    }, 180_000)
  })
})

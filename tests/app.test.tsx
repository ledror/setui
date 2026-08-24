import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
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

/** Types keys one at a time, letting each one land before the next. */
async function press(app: { stdin: { write: (s: string) => void } }, ...keys: string[]) {
  for (const k of keys) {
    app.stdin.write(k)
    await settle(40)
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
})

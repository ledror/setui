import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  merge,
  parse,
  serialize,
  toCompileCommands,
  tokenize,
  type ClCommandLine,
  type CompileCommand,
  type ProjectDirectories,
  type ToolchainInfo,
} from '../src/core/compileCommands.js'

/**
 * 57 real GetClCommandLines items captured from MSBuild 18.9 over 30 random
 * Windows-driver-samples projects. Regenerating it needs Windows and Visual Studio,
 * which is exactly why it is checked in: this whole file runs on macOS.
 */
const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/clCommandLines.json', import.meta.url)), 'utf8'),
) as {
  clCommandLines: ClCommandLine[]
  projectDirectories: { IncludePath: string; ExternalIncludePath: string; ProjectDir: string }
}

const VS_DIR = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\18\\BuildTools'

const TOOLCHAIN: ToolchainInfo = {
  clPath: `${VS_DIR}\\VC\\Tools\\MSVC\\14.51.36231\\bin\\HostX64\\x64\\cl.exe`,
  target: 'x86_64-pc-windows-msvc',
  vsInstallDir: VS_DIR,
}

const NO_DIRS: ProjectDirectories = { includePath: [], externalIncludePath: [], projectDir: '' }

const fixtureDirs = (): ProjectDirectories => ({
  includePath: FIXTURE.projectDirectories.IncludePath.split(';').filter(Boolean),
  externalIncludePath: FIXTURE.projectDirectories.ExternalIncludePath.split(';').filter(Boolean),
  projectDir: FIXTURE.projectDirectories.ProjectDir,
})

/** One item, so a test can state exactly the command line it is about. */
const item = (identity: string, files: string, cwd = 'C:\\proj\\sub'): ClCommandLine => ({
  Identity: identity,
  Files: files,
  WorkingDirectory: cwd,
  ToolPath: 'C:\\WINDOWS\\system32\\CL.exe',
})

/** The flags of the single entry produced by `identity`, without driver or source. */
const flagsOf = (identity: string, cwd = 'C:\\proj\\sub'): string[] => {
  const [entry] = toCompileCommands([item(identity, `${cwd}\\a.cpp`, cwd)], NO_DIRS, TOOLCHAIN)
  return entry!.arguments.slice(3, -1) // driver, --target, -ferror-limit
}

describe('tokenize', () => {
  it('splits on whitespace', () => {
    expect(tokenize('/c /W4 /TP')).toEqual(['/c', '/W4', '/TP'])
  })

  it('keeps a quoted path with spaces in one token, without its quotes', () => {
    // The output is an argv array handed to spawn, never a shell string, so the
    // quotes MSBuild used to survive its own command line are noise here.
    expect(tokenize('/I"C:\\a b\\inc" /W4')).toEqual(['/IC:\\a b\\inc', '/W4'])
  })

  it('leaves a detached flag and its value as two tokens', () => {
    expect(tokenize('/D FOO')).toEqual(['/D', 'FOO'])
  })

  it('unquotes an attached header name', () => {
    expect(tokenize('/Yu"precomp.h"')).toEqual(['/Yuprecomp.h'])
  })

  it('returns nothing for an empty command line', () => {
    expect(tokenize('')).toEqual([])
    expect(tokenize('   ')).toEqual([])
  })
})

describe('absolutization', () => {
  it('resolves a relative include against the working directory', () => {
    expect(flagsOf('/c /I..\\common')).toContain('/IC:\\proj\\common')
  })

  it('resolves a root-relative include against the working directory drive', () => {
    // `\ks` is real: it appears verbatim in the corpus. cl resolves it on the
    // current drive, and path.win32.resolve agrees.
    expect(flagsOf('/c /I\\ks')).toContain('/IC:\\ks')
  })

  it('leaves an already absolute include alone', () => {
    expect(flagsOf('/c /I"C:\\abs\\inc"')).toContain('/IC:\\abs\\inc')
  })

  it('resolves a detached include and attaches it', () => {
    expect(flagsOf('/c /I ..\\common')).toContain('/IC:\\proj\\common')
  })

  it('resolves /external:I and /FI, which are paths too', () => {
    const flags = flagsOf('/c /external:I ..\\ext /FI..\\forced.h')
    expect(flags).toContain('/external:IC:\\proj\\ext')
    expect(flags).toContain('/FIC:\\proj\\forced.h')
  })

  it('never touches /Yu or /Yc: those name a header, not a path', () => {
    // Resolving them against the working directory breaks PCH matching, because
    // cl looks the name up through the include path.
    const flags = flagsOf('/c /Yu"precomp.h" /Yc"precomp.h"')
    expect(flags).toContain('/Yuprecomp.h')
    expect(flags).toContain('/Ycprecomp.h')
  })

  it('uses win32 path semantics regardless of host platform', () => {
    // THIS TEST IS THE POINT OF path.win32. With the platform-default `path`,
    // macOS treats '..\\common' as a filename containing backslashes and every
    // absolutization test above passes vacuously. If this goes red, someone
    // swapped path.win32 back to path.
    const resolved = flagsOf('/c /I..\\common').find((f) => f.startsWith('/I'))!
    expect(resolved).toBe('/IC:\\proj\\common')
    // The value must be a win32 path: drive-rooted, backslash-separated. Under
    // posix semantics '..\common' stays one relative filename and this fails.
    expect(resolved.slice(2)).toMatch(/^[A-Za-z]:\\/)
    expect(resolved.slice(2)).not.toContain('/')
  })
})

describe('toCompileCommands', () => {
  it('expands a batched entry into one command per file', () => {
    const entries = toCompileCommands(
      [item('/c /W4', 'C:\\proj\\sub\\a.cpp;C:\\proj\\sub\\b.cpp')],
      NO_DIRS,
      TOOLCHAIN,
    )
    expect(entries.map((e) => e.file)).toEqual(['C:\\proj\\sub\\a.cpp', 'C:\\proj\\sub\\b.cpp'])
  })

  it('drops the defaults probe, which carries switches but no files', () => {
    expect(toCompileCommands([item('/c /W4', '')], NO_DIRS, TOOLCHAIN)).toEqual([])
  })

  it('uses the real cl.exe, not the path MSBuild reports', () => {
    // MSBuild reports C:\WINDOWS\system32\CL.exe, which does not exist.
    const [entry] = toCompileCommands([item('/c', 'C:\\proj\\sub\\a.cpp')], NO_DIRS, TOOLCHAIN)
    expect(entry!.arguments[0]).toBe(TOOLCHAIN.clPath)
    expect(entry!.arguments[0]).not.toMatch(/system32/i)
  })

  it('injects the clang target triple and lifts the error limit', () => {
    const [entry] = toCompileCommands([item('/c', 'C:\\proj\\sub\\a.cpp')], NO_DIRS, TOOLCHAIN)
    expect(entry!.arguments).toContain('--target=x86_64-pc-windows-msvc')
    expect(entry!.arguments).toContain('-ferror-limit=0')
  })

  it('ends every entry with its source file', () => {
    const [entry] = toCompileCommands([item('/c /W4', 'C:\\proj\\sub\\a.cpp')], NO_DIRS, TOOLCHAIN)
    expect(entry!.arguments.at(-1)).toBe('C:\\proj\\sub\\a.cpp')
  })

  it('strips build-output flags that mean nothing to a language server', () => {
    const flags = flagsOf('/c /Fo"x64\\Debug\\\\" /Fdvc143.pdb /Fp"x64\\Debug\\p.pch" /errorReport:prompt /W4')
    expect(flags).toEqual(['/c', '/W4'])
  })

  it('drops the toolset\'s own module scans but keeps a project .ixx', () => {
    const entries = toCompileCommands(
      [
        item('/c /scanModules', `${VS_DIR}\\VC\\Tools\\MSVC\\14.51.36231\\modules\\std.ixx`),
        item('/c /scanModules', 'C:\\proj\\sub\\mine.ixx'),
      ],
      NO_DIRS,
      TOOLCHAIN,
    )
    expect(entries.map((e) => e.file)).toEqual(['C:\\proj\\sub\\mine.ixx'])
  })

  it('drops HLSL entries, whose switches are fxc\'s and not cl\'s', () => {
    const entries = toCompileCommands(
      [
        item('/nologo /Emain', 'C:\\proj\\sub\\shader.hlsl;C:\\proj\\sub\\other.hlsli'),
        item('/c', 'C:\\proj\\sub\\a.cpp'),
      ],
      NO_DIRS,
      TOOLCHAIN,
    )
    expect(entries.map((e) => e.file)).toEqual(['C:\\proj\\sub\\a.cpp'])
  })

  it('adds the system include directories, without which <windows.h> is unfindable', () => {
    // They normally reach cl through the INCLUDE environment variable, which a
    // compilation database has no way to express.
    const dirs: ProjectDirectories = {
      includePath: ['C:\\WinKit\\um'],
      externalIncludePath: ['C:\\VC\\include'],
      projectDir: 'C:\\proj\\',
    }
    const [entry] = toCompileCommands([item('/c', 'C:\\proj\\sub\\a.cpp')], dirs, TOOLCHAIN)
    expect(entry!.arguments).toContain('/IC:\\WinKit\\um')
    expect(entry!.arguments).toContain('/IC:\\VC\\include')
  })

  it('searches project-tree includes before system ones, as cl does', () => {
    const dirs: ProjectDirectories = {
      includePath: ['C:\\proj\\generated', 'C:\\WinKit\\um'],
      externalIncludePath: [],
      projectDir: 'C:\\proj\\',
    }
    const [entry] = toCompileCommands([item('/c', 'C:\\proj\\sub\\a.cpp')], dirs, TOOLCHAIN)
    const args = entry!.arguments
    expect(args.indexOf('/IC:\\proj\\generated')).toBeLessThan(args.indexOf('/c'))
    expect(args.indexOf('/IC:\\WinKit\\um')).toBeGreaterThan(args.indexOf('/c'))
  })
})

describe('the real fixture', () => {
  it('produces one entry per source file, minus the toolset modules', () => {
    // Counted from the fixture: 154 file references, two of which are the
    // toolset's own std.ixx / std.compat.ixx. A filter that matched nothing
    // would look exactly like a passing test without this number.
    const entries = toCompileCommands(FIXTURE.clCommandLines, fixtureDirs(), TOOLCHAIN)
    expect(entries).toHaveLength(152)
  })

  it('leaves no relative include path anywhere in the output', () => {
    // 55 of 55 /I values in the corpus are relative. If absolutization regresses,
    // this is what catches it across every real project at once.
    const entries = toCompileCommands(FIXTURE.clCommandLines, fixtureDirs(), TOOLCHAIN)
    const includes = entries.flatMap((e) => e.arguments.filter((a) => a.startsWith('/I')))
    expect(includes.length).toBeGreaterThan(100)
    expect(includes.filter((i) => !/^\/I[A-Za-z]:\\/.test(i))).toEqual([])
  })

  it('leaves no build-output flag anywhere in the output', () => {
    const entries = toCompileCommands(FIXTURE.clCommandLines, fixtureDirs(), TOOLCHAIN)
    const junk = entries.flatMap((e) =>
      e.arguments.filter((a) => /^\/(Fo|Fd|Fp|errorReport)/i.test(a)),
    )
    expect(junk).toEqual([])
  })

  it('normalizes both /D spellings the corpus actually uses', () => {
    // One fixture entry carries "/D _WIN64" and "/D_ATL_NO_WIN_SUPPORT" at once.
    const entries = toCompileCommands(FIXTURE.clCommandLines, fixtureDirs(), TOOLCHAIN)
    const withAtl = entries.find((e) => e.arguments.includes('/D_ATL_NO_WIN_SUPPORT'))
    expect(withAtl).toBeDefined()
    expect(withAtl!.arguments).toContain('/D_WIN64')
    expect(withAtl!.arguments).not.toContain('/D')
  })
})

// --------------------------------------------------------------------- merging

const entry = (file: string, flags: string[]): CompileCommand => ({
  file,
  directory: 'C:\\proj',
  arguments: ['cl.exe', ...flags, file],
})

const SHARED = 'C:\\proj\\core\\shared.cpp'

describe('merge', () => {
  it('adds a file the database has never seen', () => {
    const merged = merge([], [entry(SHARED, ['/IC:\\a'])])
    expect(merged.map((e) => e.file)).toEqual([SHARED])
  })

  it('keeps one entry per file, matched case-insensitively', () => {
    // Windows filenames are case-insensitive, and MSBuild's casing is not stable.
    const merged = merge([entry(SHARED, ['/IC:\\a'])], [entry(SHARED.toUpperCase(), ['/IC:\\b'])])
    expect(merged).toHaveLength(1)
  })

  it('accumulates include directories from both projects', () => {
    // The whole reason this feature exists: 100 projects compile one core file,
    // and regenerating project 37 must not discard the other 99's include dirs.
    const merged = merge([entry(SHARED, ['/IC:\\p37'])], [entry(SHARED, ['/IC:\\p38'])])
    expect(merged[0]!.arguments).toContain('/IC:\\p37')
    expect(merged[0]!.arguments).toContain('/IC:\\p38')
  })

  it('accumulates defines from both projects', () => {
    const merged = merge([entry(SHARED, ['/DFEATURE_37'])], [entry(SHARED, ['/DFEATURE_38'])])
    expect(merged[0]!.arguments).toContain('/DFEATURE_37')
    expect(merged[0]!.arguments).toContain('/DFEATURE_38')
  })

  it('takes the newest value for a flag that cannot be accumulated', () => {
    const merged = merge([entry(SHARED, ['/std:c++17'])], [entry(SHARED, ['/std:c++20'])])
    expect(merged[0]!.arguments).toContain('/std:c++20')
    expect(merged[0]!.arguments).not.toContain('/std:c++17')
  })

  it('keeps one definition per macro name, first writer winning', () => {
    // Order-stability matters more than which value wins: the database must not
    // depend on the order projects happened to be generated in.
    const merged = merge([entry(SHARED, ['/DFOO=1'])], [entry(SHARED, ['/DFOO=2'])])
    const foo = merged[0]!.arguments.filter((a) => a.startsWith('/DFOO'))
    expect(foo).toEqual(['/DFOO=1'])
  })

  it('treats /D FOO and /DFOO as the same macro', () => {
    const merged = merge([entry(SHARED, ['/DFOO'])], [entry(SHARED, ['/DFOO=1'])])
    expect(merged[0]!.arguments.filter((a) => a.startsWith('/DFOO'))).toEqual(['/DFOO'])
  })

  it('deduplicates an include directory case-insensitively', () => {
    const merged = merge([entry(SHARED, ['/IC:\\Shared'])], [entry(SHARED, ['/IC:\\shared'])])
    expect(merged[0]!.arguments.filter((a) => a.startsWith('/I'))).toHaveLength(1)
  })

  it('keeps accumulated flags ahead of the source file', () => {
    const merged = merge([entry(SHARED, ['/IC:\\p37'])], [entry(SHARED, ['/IC:\\p38'])])
    expect(merged[0]!.arguments.at(-1)).toBe(SHARED)
    expect(merged[0]!.arguments[0]).toBe('cl.exe')
  })

  it('leaves files the incoming generation did not touch alone', () => {
    // Regenerating one project must not disturb the other 99.
    const other = entry('C:\\proj\\other.cpp', ['/IC:\\untouched'])
    const merged = merge([other, entry(SHARED, ['/IC:\\a'])], [entry(SHARED, ['/IC:\\b'])])
    expect(merged.find((e) => e.file === other.file)!.arguments).toEqual(other.arguments)
  })
})

describe('merge is stable', () => {
  const a = entry(SHARED, ['/IC:\\p37', '/DFEATURE_37', '/std:c++17'])
  const b = entry(SHARED, ['/IC:\\p38', '/DFEATURE_38', '/std:c++20'])

  it('is idempotent: merging the same generation twice changes nothing', () => {
    const once = merge([], [a])
    expect(serialize(merge(once, [a]))).toBe(serialize(once))
  })

  it('is idempotent after an accumulation', () => {
    const merged = merge(merge([], [a]), [b])
    expect(serialize(merge(merged, [b]))).toBe(serialize(merged))
  })

  it('accumulates the same set whichever order the projects arrive in', () => {
    const ab = merge(merge([], [a]), [b])
    const ba = merge(merge([], [b]), [a])
    const accumulated = (e: CompileCommand[]) =>
      e[0]!.arguments.filter((x) => x.startsWith('/I') || x.startsWith('/D')).sort()
    expect(accumulated(ab)).toEqual(accumulated(ba))
  })

  it('round-trips through serialize and parse', () => {
    const merged = merge(merge([], [a]), [b])
    expect(serialize(parse(serialize(merged)))).toBe(serialize(merged))
  })
})

describe('serialize', () => {
  it('sorts by file so regenerating one project makes a small diff', () => {
    const out = parse(serialize([entry('C:\\z.cpp', []), entry('C:\\a.cpp', [])]))
    expect(out.map((e) => e.file)).toEqual(['C:\\a.cpp', 'C:\\z.cpp'])
  })

  it('sorts case-insensitively', () => {
    const out = parse(serialize([entry('C:\\B.cpp', []), entry('C:\\a.cpp', [])]))
    expect(out.map((e) => e.file)).toEqual(['C:\\a.cpp', 'C:\\B.cpp'])
  })

  it('ends with a newline', () => {
    expect(serialize([entry('C:\\a.cpp', [])]).endsWith('\n')).toBe(true)
  })
})

describe('parse', () => {
  it('reads a database this tool wrote', () => {
    const entries = [entry('C:\\a.cpp', ['/IC:\\x'])]
    expect(parse(serialize(entries))).toEqual(entries)
  })

  it('accepts the command-string form another tool may have written', () => {
    const json = JSON.stringify([
      { file: 'C:\\a.cpp', directory: 'C:\\', command: 'cl.exe /I"C:\\a b" C:\\a.cpp' },
    ])
    expect(parse(json)[0]!.arguments).toEqual(['cl.exe', '/IC:\\a b', 'C:\\a.cpp'])
  })

  it('drops keys it does not understand rather than carrying them forward', () => {
    const json = JSON.stringify([
      { file: 'C:\\a.cpp', directory: 'C:\\', arguments: ['cl.exe'], output: 'a.obj' },
    ])
    expect(parse(json)[0]).toEqual({ file: 'C:\\a.cpp', directory: 'C:\\', arguments: ['cl.exe'] })
  })

  it('skips entries with no file rather than writing a broken database', () => {
    expect(parse(JSON.stringify([{ directory: 'C:\\', arguments: [] }]))).toEqual([])
  })

  it('refuses anything that is not an array, because we are about to overwrite it', () => {
    expect(() => parse('{"not":"an array"}')).toThrow(/array/i)
    expect(() => parse('nonsense')).toThrow()
  })
})

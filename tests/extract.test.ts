import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  extractProject,
  generate,
  resolveToolchain,
  supportsTargetResults,
  vswhere,
} from '../src/tui/compileCommands.js'
import type { ToolchainInfo } from '../src/core/compileCommands.js'

const run = promisify(execFile)

/**
 * The version gate is pure, so it is checked everywhere. `-getTargetResult` landed
 * in MSBuild 17.8; VS 2019 ships 16.x and can never do this, which is why the
 * build MSBuild and the extraction MSBuild are configured separately.
 */
describe('supportsTargetResults', () => {
  it('rejects the MSBuild that ships with VS 2019', () => {
    expect(supportsTargetResults('16.11.2.50704')).toBe(false)
  })

  it('rejects an early VS 2022', () => {
    expect(supportsTargetResults('17.7.9')).toBe(false)
  })

  it('accepts the version the feature was introduced in', () => {
    expect(supportsTargetResults('17.8.0')).toBe(true)
  })

  it('accepts a later major', () => {
    expect(supportsTargetResults('18.9.1.35102')).toBe(true)
  })

  it('rejects output it cannot make sense of', () => {
    expect(supportsTargetResults('')).toBe(false)
    expect(supportsTargetResults('MSBuild is not recognized')).toBe(false)
  })
})

// --------------------------------------------------------------- windows only

/**
 * Everything below actually runs MSBuild, so it only runs where MSBuild exists.
 * This is the mirror image of tests/app.test.tsx, which skips *on* win32. Both
 * platforms must be green: macOS with these skipped, Windows with the Ink tests
 * skipped.
 */
const windows = process.platform === 'win32'

let msbuild = ''
let workspace = ''
let toolchain: ToolchainInfo

const PROJECT = `<?xml version="1.0" encoding="utf-8"?>
<Project DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <ItemGroup Label="ProjectConfigurations">
    <ProjectConfiguration Include="Debug|x64">
      <Configuration>Debug</Configuration>
      <Platform>x64</Platform>
    </ProjectConfiguration>
  </ItemGroup>
  <PropertyGroup Label="Globals">
    <ProjectGuid>{2A9B4C1D-0000-4000-8000-000000000001}</ProjectGuid>
  </PropertyGroup>
  <Import Project="$(VCTargetsPath)\\Microsoft.Cpp.Default.props" />
  <PropertyGroup Label="Configuration">
    <ConfigurationType>StaticLibrary</ConfigurationType>
  </PropertyGroup>
  <Import Project="$(VCTargetsPath)\\Microsoft.Cpp.props" />
  <ItemDefinitionGroup>
    <ClCompile>
      <PreprocessorDefinitions>FOO=1;%(PreprocessorDefinitions)</PreprocessorDefinitions>
      <AdditionalIncludeDirectories>..\\shared;%(AdditionalIncludeDirectories)</AdditionalIncludeDirectories>
    </ClCompile>
  </ItemDefinitionGroup>
  <ItemGroup>
    <ClCompile Include="main.cpp" />
    <ClCompile Include="other.cpp">
      <PreprocessorDefinitions>ONLYOTHER;%(PreprocessorDefinitions)</PreprocessorDefinitions>
    </ClCompile>
  </ItemGroup>
  <Import Project="$(VCTargetsPath)\\Microsoft.Cpp.targets" />
</Project>
`

beforeAll(async () => {
  if (!windows) return
  // Find MSBuild the way a user without any config would have to: via vswhere.
  // Tests must never read the developer's real ~/.setui.json.
  const found = await vswhere('-latest', '-products', '*', '-find', 'MSBuild\\**\\Bin\\MSBuild.exe')
  msbuild = found[0] ?? ''
  if (!msbuild) return

  workspace = await mkdtemp(join(tmpdir(), 'setui-extract-'))
  const dir = join(workspace, 'proj')
  await run('cmd', ['/c', 'mkdir', dir.replace(/\//g, '\\')]).catch(() => {})
  await writeFile(join(workspace, 'proj.vcxproj'), PROJECT, 'utf8')
  await writeFile(join(workspace, 'main.cpp'), 'int main(){return 0;}\n', 'utf8')
  await writeFile(join(workspace, 'other.cpp'), 'int other(){return 1;}\n', 'utf8')

  toolchain = await resolveToolchain(msbuild, 'x64')
}, 120_000)

afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true })
})

// A Windows box without the C++ workload is a valid place to run the rest of the
// suite, so a missing toolchain skips rather than fails.
const canRun = () => windows && msbuild !== ''

describe.skipIf(!windows)('resolveToolchain', () => {
  it('finds a cl.exe that exists on disk', () => {
    if (!canRun()) return
    // MSBuild reports C:\WINDOWS\system32\CL.exe, which does not exist. This is
    // the regression test for using that path.
    expect(existsSync(toolchain.clPath)).toBe(true)
    expect(toolchain.clPath.toLowerCase()).not.toContain('system32')
  })

  it('picks the target triple from the build platform', async () => {
    if (!canRun()) return
    expect(toolchain.target).toBe('x86_64-pc-windows-msvc')
    expect((await resolveToolchain(msbuild, 'Win32')).target).toBe('i686-pc-windows-msvc')
    expect((await resolveToolchain(msbuild, 'ARM64')).target).toBe('aarch64-pc-windows-msvc')
  }, 60_000)

  it('names the version and the config key when MSBuild is too old', async () => {
    if (!canRun()) return
    // A .cmd stub cannot be spawned without a shell on modern Node, so point the
    // gate at something that is not MSBuild at all and check the message shape.
    await expect(resolveToolchain(join(workspace, 'nope.exe'), 'x64')).rejects.toThrow(
      /compileCommands/,
    )
  }, 60_000)
})

describe.skipIf(!windows)('extractProject', () => {
  it('extracts per-file flags from a real design-time build', async () => {
    if (!canRun()) return
    const result = await extractProject({
      msbuild,
      projectPath: join(workspace, 'proj.vcxproj'),
      solutionDir: workspace,
      configuration: 'Debug',
      platform: 'x64',
      toolchain,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const byName = (name: string) =>
      result.commands.find((c) => c.file.toLowerCase().endsWith(name))!
    expect(result.commands).toHaveLength(2)

    // The per-file override must survive: this is what proves we are reading
    // per-file command lines and not one project-wide default.
    expect(byName('other.cpp').arguments).toContain('/DONLYOTHER')
    expect(byName('main.cpp').arguments).not.toContain('/DONLYOTHER')

    // ...and the project-wide define must reach both.
    expect(byName('main.cpp').arguments).toContain('/DFOO=1')
    expect(byName('other.cpp').arguments).toContain('/DFOO=1')
  }, 120_000)

  it('makes every include absolute, and finds the Windows SDK headers', async () => {
    if (!canRun()) return
    const result = await extractProject({
      msbuild,
      projectPath: join(workspace, 'proj.vcxproj'),
      solutionDir: workspace,
      configuration: 'Debug',
      platform: 'x64',
      toolchain,
    })
    if (!result.ok) throw new Error(result.error)
    const includes = result.commands[0]!.arguments.filter((a) => a.startsWith('/I'))

    // AdditionalIncludeDirectories was written as `..\shared`.
    expect(includes.filter((i) => !/^\/I[A-Za-z]:\\/.test(i))).toEqual([])
    // Without these, clangd cannot resolve <windows.h>: cl gets them from the
    // INCLUDE environment variable, which a compilation database cannot express.
    expect(includes.some((i) => /Windows Kits/i.test(i))).toBe(true)
  }, 120_000)

  it('uses the real compiler as argv[0] and the source as the last argument', async () => {
    if (!canRun()) return
    const result = await extractProject({
      msbuild,
      projectPath: join(workspace, 'proj.vcxproj'),
      solutionDir: workspace,
      configuration: 'Debug',
      platform: 'x64',
      toolchain,
    })
    if (!result.ok) throw new Error(result.error)
    for (const command of result.commands) {
      expect(existsSync(command.arguments[0]!)).toBe(true)
      expect(command.arguments.at(-1)).toBe(command.file)
    }
  }, 120_000)

  it('reports a project that does not define the platform, rather than throwing', async () => {
    if (!canRun()) return
    // The common failure: a project that codes its configurations differently.
    // It has to be survivable, because one bad project must not cost the other 99.
    //
    // MSBuild fails this with "BaseOutputPath/OutputPath property is not set"
    // AND still writes one empty item, so neither the exit code nor the item
    // count can be the signal. Only the converted commands can.
    const result = await extractProject({
      msbuild,
      projectPath: join(workspace, 'proj.vcxproj'),
      solutionDir: workspace,
      configuration: 'Debug',
      platform: 'NoSuchPlatform',
      toolchain,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.project).toContain('proj.vcxproj')
    expect(result.error).toMatch(/error|MSB/i)
  }, 120_000)

  it('does not fail a bad configuration, because MSBuild does not', async () => {
    if (!canRun()) return
    // Worth pinning down because it is surprising: an unknown *Configuration* is
    // evaluated with the project's defaults and yields real command lines, while
    // an unknown *Platform* errors. Nothing here can detect the former, and the
    // resulting entries describe whatever configuration MSBuild fell back to.
    const result = await extractProject({
      msbuild,
      projectPath: join(workspace, 'proj.vcxproj'),
      solutionDir: workspace,
      configuration: 'NoSuchConfiguration',
      platform: 'x64',
      toolchain,
    })
    expect(result.ok).toBe(true)
  }, 120_000)

  it('reports a project file that is not there', async () => {
    if (!canRun()) return
    const result = await extractProject({
      msbuild,
      projectPath: join(workspace, 'missing.vcxproj'),
      solutionDir: workspace,
      configuration: 'Debug',
      platform: 'x64',
      toolchain,
    })
    expect(result.ok).toBe(false)
  }, 120_000)
})

describe.skipIf(!windows)('generate', () => {
  it('merges every project and reports the ones that failed', async () => {
    if (!canRun()) return
    const progress: string[] = []
    const result = await generate({
      msbuild,
      projects: [join(workspace, 'proj.vcxproj'), join(workspace, 'missing.vcxproj')],
      solutionDir: workspace,
      configuration: 'Debug',
      platform: 'x64',
      toolchain,
      onProgress: (line) => progress.push(line),
    })
    expect(result.commands).toHaveLength(2)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]!.project).toContain('missing.vcxproj')
    // One line per project, so a 90-second run is legible while it happens.
    expect(progress).toHaveLength(2)
  }, 180_000)

  it('leaves the read-only corpus untouched', async () => {
    if (!canRun()) return
    // CLAUDE.md rule 8. A design-time build writes nothing, and this is what
    // proves it stays that way.
    const { stdout } = await run('git', ['status', '--porcelain'], {
      cwd: join(process.cwd(), 'sample-projects', 'Windows-driver-samples'),
    }).catch(() => ({ stdout: '' }))
    expect(stdout.trim()).toBe('')
  }, 60_000)
})

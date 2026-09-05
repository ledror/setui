import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import {
  merge,
  toCompileCommands,
  type ClCommandLine,
  type CompileCommand,
  type ProjectDirectories,
  type ToolchainInfo,
} from '../core/compileCommands.js'

const run = promisify(execFile)

/** Design-time builds print a lot before they print nothing useful. */
const MAX_OUTPUT = 32 * 1024 * 1024

/** vswhere lives at a path Microsoft commits to, so there is nothing to search. */
const VSWHERE = join(
  process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
  'Microsoft Visual Studio',
  'Installer',
  'vswhere.exe',
)

/** Runs vswhere and returns its output lines. Exported so tests can find MSBuild. */
export async function vswhere(...args: string[]): Promise<string[]> {
  try {
    const { stdout } = await run(VSWHERE, args, { windowsHide: true })
    return stdout.split(/\r?\n/).filter(Boolean)
  } catch {
    return []
  }
}

const TRIPLES: Record<string, string> = {
  x64: 'x86_64-pc-windows-msvc',
  win32: 'i686-pc-windows-msvc',
  x86: 'i686-pc-windows-msvc',
  arm64: 'aarch64-pc-windows-msvc',
  arm: 'thumbv7a-pc-windows-msvc',
}

const TOOLS_ARCH: Record<string, string> = {
  x64: 'x64',
  win32: 'x86',
  x86: 'x86',
  arm64: 'arm64',
  arm: 'arm',
}

const HOST_ARCH: Record<string, string> = {
  x64: 'HostX64',
  ia32: 'HostX86',
  arm64: 'HostArm64',
}

/**
 * Locates the compiler and checks that `msbuild` can be run at all.
 *
 * The compiler path matters: MSBuild reports `C:\WINDOWS\system32\CL.exe`, which
 * does not exist. clangd would still infer cl driver-mode from the basename, but
 * anything that probes the compiler breaks on a path that is not there.
 */
export async function resolveToolchain(msbuild: string, platform: string): Promise<ToolchainInfo> {
  if (process.platform !== 'win32') {
    throw new Error('compile_commands.json generation needs Windows and MSBuild')
  }

  // One reachability probe, so that a wrong path is one clear error instead of
  // the same spawn failure repeated once per project. There is no version gate:
  // what extraction needs is the C++ design-time targets, which come with the VC
  // toolset rather than with MSBuild.exe, and no version number reports them. An
  // MSBuild without them says so itself, per project.
  try {
    await run(msbuild, ['-version', '-nologo'], { windowsHide: true })
  } catch (e) {
    throw new Error(
      `could not run MSBuild at ${msbuild}: ${(e as Error).message}. ` +
        'Set msbuild.compileCommands in ~/.setui.json to the MSBuild that came with ' +
        'the Visual Studio C++ tools.',
    )
  }

  const [install] = await vswhere(
    '-latest',
    '-products',
    '*',
    '-requires',
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property',
    'installationPath',
  )
  if (!install) {
    throw new Error(
      `no Visual Studio with the C++ tools found (asked ${VSWHERE}). ` +
        'compile_commands.json generation needs the MSVC toolchain.',
    )
  }

  const toolsRoot = join(install, 'VC', 'Tools', 'MSVC')
  let versions: string[]
  try {
    versions = (await readdir(toolsRoot)).sort()
  } catch {
    throw new Error(`no MSVC toolset under ${toolsRoot}`)
  }
  const toolset = versions.at(-1)
  if (!toolset) throw new Error(`no MSVC toolset under ${toolsRoot}`)

  const key = platform.toLowerCase()
  const target = TRIPLES[key] ?? TRIPLES['x64']!
  const arch = TOOLS_ARCH[key] ?? 'x64'
  const host = HOST_ARCH[process.arch] ?? 'HostX64'

  return {
    clPath: join(toolsRoot, toolset, 'bin', host, arch, 'cl.exe'),
    target,
    vsInstallDir: install,
  }
}

/** The target the injected file adds, and the property telling it where to write. */
const EXTRACT_TARGET = 'SetuiGetCompileCommands'
const OUTPUT_PROPERTY = 'SetuiCompileCommandsFile'

/**
 * The design-time build writes its own results, through this injected file.
 *
 * The obvious route -- `-getTargetResult:GetClCommandLines` -- cannot work on any
 * MSBuild a Visual Studio 2022 ships. Its JSON formatter asks every returned item
 * for `%(FullPath)`, and a `ClCommandLines` item's spec is a cl command line and
 * not a path, so 17.14 answers with MSB1025 and an unhandled
 * InvalidOperationException -- *after* the build itself printed "Build
 * succeeded". Nothing about a project provokes it and nothing about a project
 * avoids it. It was fixed in the MSBuild that came with Visual Studio 2026.
 *
 * So the results never reach that formatter. Microsoft.Cpp.targets imports
 * `$(ForceImportAfterCppTargets)` whenever that file exists, which is enough room
 * to add a target that writes the two item groups itself.
 *
 * Three details are load-bearing:
 *
 * - The transforms are passed straight to the task. Routing them through an
 *   `<ItemGroup>` first would re-split `Files` on its own semicolons and turn one
 *   command line into several half-empty records.
 * - Both writes are in one target, rather than two `AfterTargets` hooks, so the
 *   records cannot be interleaved by whatever order MSBuild picks for the targets
 *   they would have followed.
 * - `_ProjectDirectories` is the item `GetProjectDirectories` returns. It is
 *   private to Microsoft's targets, and there is no public name for it.
 *
 * ponytail: `ForceImportAfterCppTargets` holds a single path, so a project that
 * uses it for its own import loses that import for this build.
 * `ForceImportBeforeCppTargets` is the more widely used of the two hooks, which is
 * why this takes the other one. Chaining onto an existing value would mean
 * evaluating the project first, which is a second MSBuild run per project.
 */
const EXTRACT_TARGETS = `<Project>
  <Target Name="${EXTRACT_TARGET}"
          DependsOnTargets="ComputeReferenceCLInput;GetProjectDirectories;GetClCommandLines">
    <WriteLinesToFile File="$(${OUTPUT_PROPERTY})" Overwrite="true" WriteOnlyWhenDifferent="false"
                      Lines="@(_ProjectDirectories->'DIR|%(IncludePath)|%(ExternalIncludePath)|%(ProjectDir)')" />
    <WriteLinesToFile File="$(${OUTPUT_PROPERTY})" Overwrite="false"
                      Lines="@(ClCommandLines->'CL|%(Files)|%(WorkingDirectory)|%(ToolPath)|%(Identity)')" />
  </Target>
</Project>
`

/**
 * Reads back what the injected target wrote.
 *
 * `|` separates the fields because it cannot occur in a Windows path. `;` cannot
 * be the separator: it is MSBuild's own list separator, and it occurs inside the
 * `Files` field. The command line is the last field and everything past the
 * fourth is joined back on, because `|` is legal in a cl switch (`/D X="a|b"`).
 *
 * Anything that is not a whole record is skipped rather than half-read: an item
 * with an empty command line would put a bare `cl.exe file.cpp` in the database,
 * which looks like a source that compiles with no flags at all.
 */
export function parseExtractOutput(text: string): {
  items: ClCommandLine[]
  dirs: ProjectDirectories
} {
  const items: ClCommandLine[] = []
  let dirs: ProjectDirectories = { includePath: [], externalIncludePath: [], projectDir: '' }
  const list = (value: string) => value.split(';').filter(Boolean)

  for (const line of text.replace(/^\ufeff/, '').split(/\r?\n/)) {
    const fields = line.split('|')
    if (fields[0] === 'CL' && fields.length >= 5) {
      items.push({
        Identity: fields.slice(4).join('|'),
        Files: fields[1]!,
        WorkingDirectory: fields[2]!,
        ToolPath: fields[3]!,
      })
    } else if (fields[0] === 'DIR' && fields.length >= 4) {
      dirs = {
        includePath: list(fields[1]!),
        externalIncludePath: list(fields[2]!),
        projectDir: fields[3]!,
      }
    }
  }
  return { items, dirs }
}

export interface ExtractOptions {
  msbuild: string
  projectPath: string
  /** Projects read $(SolutionDir); MSBuild only sets it for solution builds. */
  solutionDir: string
  configuration: string
  platform: string
  toolchain: ToolchainInfo
  signal?: AbortSignal
}

export type ExtractResult =
  | { ok: true; commands: CompileCommand[] }
  | { ok: false; project: string; error: string }

/**
 * Runs one design-time build and turns its target results into compile commands.
 *
 * Never throws for a project-level failure. A project that does not define the
 * selected Configuration|Platform is the common case, not an exception, and one
 * bad project must not cost the other ninety-nine.
 */
export async function extractProject(options: ExtractOptions): Promise<ExtractResult> {
  const { msbuild, projectPath, solutionDir, configuration, platform, toolchain, signal } = options
  // Two temp files per project -- the injected target, and what it writes. Both
  // are a kilobyte against a design-time build that takes about a second.
  const stem = join(tmpdir(), `setui-cc-${randomBytes(8).toString('hex')}`)
  const targetsFile = `${stem}.targets`
  const resultFile = `${stem}.txt`
  const project = basename(projectPath)

  try {
    await writeFile(targetsFile, EXTRACT_TARGETS, 'utf8')
  } catch (e) {
    // Never throw for one project: the caller is halfway through ninety-nine more.
    return { ok: false, project, error: `could not write ${targetsFile}: ${(e as Error).message}` }
  }

  const args = [
    projectPath,
    '/nologo',
    `/p:Configuration=${configuration}`,
    `/p:Platform=${platform}`,
    // The trailing separator is part of the convention: $(SolutionDir) is used
    // as a prefix, not joined.
    `/p:SolutionDir=${solutionDir.replace(/[\\/]*$/, '\\')}`,
    '/p:DesignTimeBuild=true',
    '/p:BuildingInsideVisualStudio=true',
    // A design-time build must not build what this project references. Those
    // projects contribute their own entries when they are generated.
    '/p:BuildProjectReferences=false',
    // The results come back through the injected target rather than
    // `-getTargetResult`, which cannot serialize them at all.
    `/p:ForceImportAfterCppTargets=${targetsFile}`,
    `/p:${OUTPUT_PROPERTY}=${resultFile}`,
    `/t:${EXTRACT_TARGET}`,
  ]

  let output = ''
  // Not an early return: the temp files are removed by the `finally` below, and
  // a cancelled run would otherwise leave both of them behind.
  let cancelled = false
  try {
    const { stdout } = await run(msbuild, args, {
      windowsHide: true,
      maxBuffer: MAX_OUTPUT,
      signal,
    })
    output = stdout
  } catch (e) {
    // A non-zero exit is not conclusive on its own: the target may have written
    // its records anyway. Keep the output for the error message and let the read
    // below decide.
    const failure = e as Error & { stdout?: string; stderr?: string }
    cancelled = failure.name === 'AbortError'
    output = `${failure.stdout ?? ''}${failure.stderr ?? ''}` || failure.message
  }

  try {
    if (cancelled) return { ok: false, project, error: 'cancelled' }
    const { items, dirs } = parseExtractOutput(await readFile(resultFile, 'utf8'))
    const commands = toCompileCommands(items, dirs, toolchain)
    // The exit code is not the signal, and neither is the record count. A project
    // with no C or C++ sources for this configuration -- a driver package project,
    // or one that excludes them all -- builds cleanly and writes only its
    // directories. Only the converted commands say whether anything was extracted.
    if (commands.length === 0) return { ok: false, project, error: reason(output) }
    return { ok: true, commands }
  } catch {
    // A build that failed before the target ran leaves no file behind at all.
    return { ok: false, project, error: reason(output) }
  } finally {
    await rm(resultFile, { force: true }).catch(() => {})
    await rm(targetsFile, { force: true }).catch(() => {})
  }
}

/**
 * The most useful line of a failed design-time build, for a one-line report.
 *
 * The pattern has to be narrow. Matching /error/ alone picks up MSBuild's own
 * "0 Error(s)" summary line and reports a successful-but-empty build as failing
 * with "0 Error(s)", which tells the user nothing.
 */
function reason(output: string): string {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const error = lines.find((l) => /:\s*error\b|\berror [A-Z]+\d+|MSB\d{4}/i.test(l))
  // No error at all means the project built fine and simply has nothing to
  // compile -- a driver package project, or one whose sources are all excluded
  // from this configuration.
  return error ?? 'no C/C++ sources for this configuration'
}

export interface GenerateOptions {
  msbuild: string
  projects: string[]
  solutionDir: string
  configuration: string
  platform: string
  toolchain: ToolchainInfo
  onProgress?: (line: string) => void
  signal?: AbortSignal
}

export interface GenerateResult {
  commands: CompileCommand[]
  failed: { project: string; error: string }[]
  /** True when the run stopped early. What was extracted is still worth writing. */
  cancelled: boolean
}

/**
 * Extracts every project in turn, accumulating the results.
 *
 * ponytail: one project at a time, ~0.9s each. Each MSBuild is already
 * multi-threaded, and N of them over a cold project tree thrash the disk. Add a
 * small worker pool if 250-project solutions become routine.
 */
export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  const { projects, onProgress, signal } = options
  let commands: CompileCommand[] = []
  const failed: { project: string; error: string }[] = []

  for (const [index, projectPath] of projects.entries()) {
    if (signal?.aborted) return { commands, failed, cancelled: true }
    const result = await extractProject({ ...options, projectPath })
    const position = `[${index + 1}/${projects.length}] ${basename(projectPath)}`
    if (result.ok) {
      // Within one solution a shared source compiled by several projects
      // accumulates their flags, exactly as it does across generations.
      commands = merge(commands, result.commands)
      onProgress?.(`${position} ... ${result.commands.length} files`)
    } else {
      failed.push({ project: result.project, error: result.error })
      onProgress?.(`${position} ... FAILED: ${result.error}`)
    }
  }
  return { commands, failed, cancelled: signal?.aborted ?? false }
}

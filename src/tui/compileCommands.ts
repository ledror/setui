import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readdir, readFile, rm } from 'node:fs/promises'
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

/**
 * `-getTargetResult` landed in MSBuild 17.8. VS 2019 ships 16.x and can never do
 * this, which is why setui configures the build MSBuild and the extraction
 * MSBuild separately: the one that builds a driver is often the older one.
 */
const MIN_MAJOR = 17
const MIN_MINOR = 8

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

/** True if `msbuild -version` reports something that can print target results. */
export function supportsTargetResults(version: string): boolean {
  const match = /^(\d+)\.(\d+)/.exec(version.trim())
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return major > MIN_MAJOR || (major === MIN_MAJOR && minor >= MIN_MINOR)
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
 * Locates the compiler and checks that `msbuild` is new enough.
 *
 * The compiler path matters: MSBuild reports `C:\WINDOWS\system32\CL.exe`, which
 * does not exist. clangd would still infer cl driver-mode from the basename, but
 * anything that probes the compiler breaks on a path that is not there.
 */
export async function resolveToolchain(msbuild: string, platform: string): Promise<ToolchainInfo> {
  if (process.platform !== 'win32') {
    throw new Error('compile_commands.json generation needs Windows and MSBuild 17.8+')
  }

  let version: string
  try {
    const { stdout } = await run(msbuild, ['-version', '-nologo'], { windowsHide: true })
    version = stdout.trim().split(/\r?\n/).at(-1) ?? ''
  } catch (e) {
    throw new Error(
      `could not run MSBuild at ${msbuild}: ${(e as Error).message}. ` +
        'Set msbuild.compileCommands in ~/.setui.json to an MSBuild 17.8 or newer.',
    )
  }
  if (!supportsTargetResults(version)) {
    throw new Error(
      `MSBuild ${version || '(unknown version)'} at ${msbuild} cannot print target results ` +
        '(needs 17.8+, which means Visual Studio 2022 17.8 or newer). ' +
        'Set msbuild.compileCommands in ~/.setui.json to a newer MSBuild.',
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
  const resultFile = join(tmpdir(), `setui-cc-${randomBytes(8).toString('hex')}.json`)
  const project = basename(projectPath)

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
    '/t:ComputeReferenceCLInput;GetProjectDirectories;GetClCommandLines',
    '-getTargetResult:GetClCommandLines',
    '-getTargetResult:GetProjectDirectories',
    // To a file, not stdout: MSBuild's own chatter would have to be de-interleaved
    // from the JSON otherwise.
    `-getResultOutputFile:${resultFile}`,
  ]

  let output = ''
  try {
    const { stdout } = await run(msbuild, args, {
      windowsHide: true,
      maxBuffer: MAX_OUTPUT,
      signal,
    })
    output = stdout
  } catch (e) {
    // A non-zero exit is not conclusive on its own: the JSON may still be there.
    // Keep the output for the error message and let the parse below decide.
    const failure = e as Error & { stdout?: string; stderr?: string }
    if (failure.name === 'AbortError') return { ok: false, project, error: 'cancelled' }
    output = `${failure.stdout ?? ''}${failure.stderr ?? ''}` || failure.message
  }

  try {
    const raw = await readFile(resultFile, 'utf8')
    const parsed = JSON.parse(raw) as {
      TargetResults?: Record<string, { Items?: Record<string, string>[] }>
    }
    const items = (parsed.TargetResults?.['GetClCommandLines']?.Items ?? []).map(clCommandLine)
    const dirs = projectDirectories(parsed.TargetResults?.['GetProjectDirectories']?.Items?.[0])
    const commands = toCompileCommands(items, dirs, toolchain)
    // The exit code is not the signal, and neither is the item count. A project
    // asked for a platform it does not define fails with MSB "BaseOutputPath is
    // not set" *and still writes one item* -- an empty one, with no Identity and
    // no Files. Only the converted commands say whether anything was extracted.
    if (commands.length === 0) return { ok: false, project, error: reason(output) }
    return { ok: true, commands }
  } catch {
    return { ok: false, project, error: reason(output) }
  } finally {
    await rm(resultFile, { force: true }).catch(() => {})
  }
}

/** MSBuild's JSON gives every item the same untyped metadata bag. */
function clCommandLine(item: Record<string, string>): ClCommandLine {
  return {
    Identity: item['Identity'] ?? '',
    Files: item['Files'] ?? '',
    WorkingDirectory: item['WorkingDirectory'] ?? '',
    ToolPath: item['ToolPath'] ?? '',
  }
}

function projectDirectories(item: Record<string, string> | undefined): ProjectDirectories {
  const split = (value: string | undefined) => (value ?? '').split(';').filter(Boolean)
  return {
    includePath: split(item?.['IncludePath']),
    externalIncludePath: split(item?.['ExternalIncludePath']),
    projectDir: item?.['ProjectDir'] ?? '',
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

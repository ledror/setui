import { win32 } from 'node:path'

/**
 * A clang JSON compilation database, built from MSBuild's `GetClCommandLines`.
 *
 * Two facts about that target's output shape everything here:
 *
 * 1. Its command lines are *relative* to each project. In the sample corpus 55 of
 *    55 `/I` values are relative (`..\common`, `\ks`, `.`). A database mixes files
 *    from many projects into one `directory`, so every path-bearing flag is made
 *    absolute here, before anything is merged.
 * 2. Its `ToolPath` is `C:\WINDOWS\system32\CL.exe`, which does not exist. The
 *    caller resolves the real compiler and passes it in.
 *
 * Paths use win32 semantics unconditionally -- `path.win32`, never the
 * platform-default `path`. setui is developed on macOS, where the default parser
 * treats `..\..\inc` as a filename containing backslashes and every test here
 * would pass without testing anything.
 */

/** One entry of the database. `arguments`, never `command`: no quoting rules. */
export interface CompileCommand {
  file: string
  directory: string
  arguments: string[]
}

/** A `GetClCommandLines` item, exactly as MSBuild's `-getTargetResult` JSON has it. */
export interface ClCommandLine {
  /** The cl switches, e.g. `/c /I..\common /W4 /D FOO`. */
  Identity: string
  /** Semicolon-separated absolute source paths. Empty on the defaults probe. */
  Files: string
  /** Absolute. What `Identity`'s relative paths resolve against. */
  WorkingDirectory: string
  ToolPath: string
  ConfigurationOptions?: string
}

/** `GetProjectDirectories` output: the header dirs cl would get from `INCLUDE`. */
export interface ProjectDirectories {
  includePath: string[]
  externalIncludePath: string[]
  projectDir: string
}

export interface ToolchainInfo {
  /** The real cl.exe. clangd infers cl driver-mode from the basename. */
  clPath: string
  /** Clang target triple, e.g. `x86_64-pc-windows-msvc`. */
  target: string
  /** Used to drop the toolset's own module scans from the output. */
  vsInstallDir: string
}

/**
 * Flags whose value is a path, and which therefore have to be made absolute.
 * `/Yu` and `/Yc` are deliberately absent: they name a *header*, which cl looks up
 * through the include path. Resolving them against the working directory breaks
 * precompiled-header matching.
 */
const PATH_FLAGS = ['/external:I', '/imsvc', '/FI', '/I'] as const

/** Flags that accumulate across projects rather than being overwritten. */
const ACCUMULATING = [...PATH_FLAGS, '/D'] as const

/** Build outputs. A language server ignores them and they only add churn. */
const OUTPUT_FLAGS = /^\/(Fo|Fd|Fp|errorReport)/i

const HLSL = /\.(hlsl|hlsli|fx)$/i

/**
 * Splits a cl command line into tokens, dropping the quotes that only existed to
 * survive the command line. The result is handed to `spawn` as an argv array and
 * never to a shell, so `/I"C:\a b\inc"` and `/IC:\a b\inc` are the same argument.
 */
export function tokenize(commandLine: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quoted = false
  let started = false
  for (const ch of commandLine) {
    if (ch === '"') {
      quoted = !quoted
      started = true
    } else if (!quoted && (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r')) {
      if (started) tokens.push(current)
      current = ''
      started = false
    } else {
      current += ch
      started = true
    }
  }
  if (started) tokens.push(current)
  return tokens
}

/** The `/I`-style prefix a token carries, longest first so `/I` cannot shadow `/imsvc`. */
const pathPrefix = (token: string) => PATH_FLAGS.find((f) => token.startsWith(f))

/**
 * Normalizes a project's switches: detached values are attached to their flag,
 * path values are made absolute, build outputs are dropped.
 *
 * Both spellings are real. The corpus has 80 detached `/D FOO` against 5 attached
 * `/DFOO`, and one project emits both in the same command line, so anything that
 * handles only one form silently half-works.
 */
function normalize(tokens: string[], workingDirectory: string): string[] {
  const out: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    const prefix = token === '/D' ? '/D' : pathPrefix(token)
    if (!prefix) {
      if (!OUTPUT_FLAGS.test(token)) out.push(token)
      continue
    }
    // `/I path` and `/Ipath` both occur; attach the detached form.
    let value = token.slice(prefix.length)
    if (value === '') {
      value = tokens[++i] ?? ''
      if (value === '') continue
    }
    out.push(prefix === '/D' ? `/D${value}` : `${prefix}${win32.resolve(workingDirectory, value)}`)
  }
  return out
}

/**
 * The MSVC and Windows SDK header directories. cl receives these through the
 * `INCLUDE` environment variable, which a compilation database cannot express, so
 * without them clangd cannot find <windows.h>.
 *
 * Paths inside the project tree are searched first and the rest last, matching
 * cl's own order (explicit `/I` before `INCLUDE`) so a system header cannot
 * shadow a generated one.
 */
function systemIncludes(dirs: ProjectDirectories): { before: string[]; after: string[] } {
  const before: string[] = []
  const after: string[] = []
  const seen = new Set<string>()
  const inProject = dirs.projectDir.toLowerCase()
  for (const raw of [...dirs.externalIncludePath, ...dirs.includePath]) {
    const trimmed = raw.trim()
    // An unexpanded MSBuild expression cannot be resolved, and emitting it would
    // put a literal `$(...)` in the database. Dropping it is the honest option.
    if (!trimmed || trimmed.includes('$(')) continue
    const path = win32.resolve(dirs.projectDir || 'C:\\', trimmed)
    const key = path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    ;(inProject && key.startsWith(inProject) ? before : after).push(`/I${path}`)
  }
  return { before, after }
}

/** Turns MSBuild's items into compile commands: one per source file. */
export function toCompileCommands(
  items: ClCommandLine[],
  dirs: ProjectDirectories,
  toolchain: ToolchainInfo,
): CompileCommand[] {
  const { before, after } = systemIncludes(dirs)
  const vsDir = toolchain.vsInstallDir.toLowerCase()
  const commands: CompileCommand[] = []

  for (const item of items) {
    const files = item.Files.split(';')
      .map((f) => f.trim())
      .filter(Boolean)
    // The defaults probe carries the project-wide switches and no files at all.
    if (files.length === 0) continue
    // The CLCommandLine task runs once for @(ClCompile) and once for @(FxCompile)
    // and merges both into this item group, with nothing to tell them apart. HLSL
    // entries carry fxc switches, which are not cl switches and mean nothing to
    // clangd.
    if (files.every((f) => HLSL.test(f))) continue

    const flags = normalize(tokenize(item.Identity), item.WorkingDirectory)
    for (const file of files) {
      // The toolset scans its own std.ixx / std.compat.ixx modules; those are not
      // the user's code. A .ixx inside the project is.
      if (vsDir && file.toLowerCase().startsWith(vsDir)) continue
      commands.push({
        file,
        directory: item.WorkingDirectory,
        arguments: [
          toolchain.clPath,
          `--target=${toolchain.target}`,
          // MSVC's STL headers can trip clang's default limit of 20 errors, and
          // hitting it stops the parse and cascades into hundreds of false ones.
          '-ferror-limit=0',
          ...before,
          ...flags,
          ...after,
          file,
        ],
      })
    }
  }
  return commands
}

/**
 * What makes two accumulated flags the same flag. Paths compare
 * case-insensitively because Windows filenames do; macros do not, because C
 * macros are case-sensitive. A macro is keyed on its name alone, so `/DFOO` and
 * `/DFOO=2` collide.
 */
function accumulationKey(flag: string): string | undefined {
  if (flag.startsWith('/D')) return `/D${flag.slice(2).split('=')[0]}`
  const prefix = pathPrefix(flag)
  if (!prefix || flag.length === prefix.length) return undefined
  return (prefix + flag.slice(prefix.length).toLowerCase()).toLowerCase()
}

/**
 * Merges a fresh generation into an existing database.
 *
 * One entry per file. Include directories and defines *accumulate*: a file
 * compiled by 100 projects ends up with every project's include dirs, so that
 * regenerating one of them does not discard the other 99's. Everything else
 * (`/std:`, `/MD`, `/O2`, ...) comes from the most recent generation.
 *
 * The consequence is deliberate: an entry can carry flags the project you last
 * generated does not itself use. That inaccuracy buys cross-project navigation
 * across a whole repository at once. Accuracy is controlled by *where the output
 * file lives* -- a database beside one .vcxproj only ever sees that project.
 *
 * Entries therefore only ever grow. A deleted source file cannot be merged away;
 * generate into a fresh file instead.
 */
export function merge(existing: CompileCommand[], incoming: CompileCommand[]): CompileCommand[] {
  const byFile = new Map<string, CompileCommand>()
  for (const entry of existing) byFile.set(entry.file.toLowerCase(), entry)
  for (const entry of incoming) {
    const key = entry.file.toLowerCase()
    const previous = byFile.get(key)
    byFile.set(key, previous ? accumulate(previous, entry) : entry)
  }
  return [...byFile.values()]
}

function accumulate(previous: CompileCommand, next: CompileCommand): CompileCommand {
  const inherited = new Map<string, string>()
  for (const flag of previous.arguments) {
    const key = accumulationKey(flag)
    // First writer wins, so the database does not depend on the order projects
    // happened to be generated in.
    if (key !== undefined && !inherited.has(key)) inherited.set(key, flag)
  }

  const head = next.arguments.slice(0, -1)
  const kept: string[] = []
  for (const flag of head) {
    const key = accumulationKey(flag)
    if (key === undefined) {
      kept.push(flag)
      continue
    }
    kept.push(inherited.get(key) ?? flag)
    inherited.delete(key)
  }

  return {
    file: next.file,
    directory: next.directory,
    arguments: [...kept, ...inherited.values(), next.arguments.at(-1)!],
  }
}

/** Sorted by file, so regenerating one project makes a diff of just its lines. */
export function serialize(entries: CompileCommand[]): string {
  const sorted = [...entries].sort((a, b) =>
    a.file.toLowerCase().localeCompare(b.file.toLowerCase()),
  )
  return JSON.stringify(sorted, null, 2) + '\n'
}

/**
 * Reads an existing database, including one another tool wrote. Anything that is
 * not an array of entries throws rather than being replaced silently -- we are
 * about to overwrite the file.
 */
export function parse(json: string): CompileCommand[] {
  const parsed: unknown = JSON.parse(json)
  if (!Array.isArray(parsed)) throw new Error('not a compile_commands.json: expected an array')
  const entries: CompileCommand[] = []
  for (const raw of parsed) {
    const record = raw as Partial<CompileCommand> & { command?: unknown }
    if (typeof record.file !== 'string' || !record.file) continue
    const args = Array.isArray(record.arguments)
      ? record.arguments.filter((a): a is string => typeof a === 'string')
      : typeof record.command === 'string'
        ? tokenize(record.command)
        : []
    entries.push({
      file: record.file,
      directory: typeof record.directory === 'string' ? record.directory : '',
      arguments: args,
    })
  }
  return entries
}

# Phase 02 — extraction

Read `plans/00-design.md` first. Depends on phase 01's types.

This is the Windows-only half: find the toolchain, run MSBuild, turn its JSON
into the raw items phase 01 consumes.

## Deliverable

`src/tui/compileCommands.ts`. It lives under `src/tui/` because it spawns
processes and touches the filesystem, which `src/core/` may never do.

## The contract

```ts
/** Throws with a clear message on a non-Windows host or an MSBuild < 17.8. */
export async function resolveToolchain(msbuild: string): Promise<ToolchainInfo>

/** One project. Never throws for a project-level failure: reports it. */
export async function extractProject(options: {
  msbuild: string
  projectPath: string
  solutionDir: string
  configuration: string
  platform: string
  toolchain: ToolchainInfo
  signal?: AbortSignal
}): Promise<
  | { ok: true; commands: CompileCommand[] }
  | { ok: false; project: string; error: string }
>
```

## Toolchain resolution

`vswhere.exe` is always at
`%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe` — a fixed
path Microsoft commits to, so no search is needed.

```
vswhere -latest -products * \
  -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 \
  -property installationPath
```

Then `cl.exe` at `<install>\VC\Tools\MSVC\<highest version>\bin\Host<hostArch>\<targetArch>\cl.exe`.
Map the MSBuild platform to the target arch: `x64`→`x64`, `Win32`→`x86`,
`ARM64`→`arm64`. The clang triple follows: `x86_64-pc-windows-msvc`,
`i686-pc-windows-msvc`, `aarch64-pc-windows-msvc`.

**This box has two VS installs** (BuildTools 18.9 and Community 18.8), so
`-latest` is a real choice, not a formality. If resolution fails, say which step
failed and what path was tried — a silent fallback to MSBuild's bogus
`C:\WINDOWS\system32\CL.exe` is worse than an error.

## The version gate

Run `<msbuild> -version -nologo`, parse `major.minor`, require **≥ 17.8**.
`-getTargetResult` does not exist before it and VS 2019 will never have it.

On failure, the message must name the version found, the executable used, and the
config key to change. This is the common case for the user — assume the
build MSBuild is old and that the fix is setting the other key, not upgrading.

## Invocation

Exactly the argv in `00-design.md`. Notes that cost time to rediscover:

- `-getResultOutputFile:<temp>` writes JSON to a temp file; stdout stays free for
  progress. Use one temp file per project and delete it after.
- Pass the argv as an **array** to `spawn`, never a shell string — the existing
  `src/tui/build.ts` comment explains why (`|` in a platform name, spaces in
  paths). Same rule here.
- `/p:SolutionDir=<dir>\` — with the trailing backslash. Projects read
  `$(SolutionDir)` and MSBuild only sets it for solution builds.
- `BuildProjectReferences=false` keeps a project's extraction to its own files.
  This is intended: referenced projects are already in the database from the
  whole-solution generation.
- Exit code is **not** a reliable failure signal — a design-time build can report
  success while `GetClCommandLines` produced nothing. Treat "no items" as a
  project-level failure with a readable reason.

## Enumerating a solution's projects

Reuse `src/core/sln.ts`. It already parses `.sln` and yields projects with their
paths, and `app.tsx` already resolves them via `join(dirname(solutionPath), toLocal(entry.path))`.
Skip solution folders (`isFolder`). Do not write a second `.sln` reader, and do
not write to `.sln` files — `CLAUDE.md` rule 5.

## Concurrency

**Sequential.** Mark it:

```ts
// ponytail: one project at a time, ~0.9s each. Each MSBuild is already
// multi-threaded and N of them on a cold tree thrash the disk. Add a small
// worker pool if 250-project solutions become routine.
```

Measured cost: ~90 s for 100 projects, ~4 min for the 265-project corpus.

## Tests — `tests/extract.test.ts`

**These must actually invoke MSBuild.** Gate the file, not individual asserts:

```ts
const windows = process.platform === 'win32'
describe.skipIf(!windows)('extraction', () => { ... })
```

This is the mirror image of `tests/app.test.tsx`, which skips *on* win32. Both
directions now exist, so document the situation in `CLAUDE.md` (see phase 04):
**on macOS `npm test` skips extraction; on Windows it runs. Both must be green.**

Find MSBuild in the test through `vswhere`, not through `~/.setui.json` — tests
must never read the developer's real config, which is why `App` takes
`configPath` at all. If `vswhere` or a suitable MSBuild is absent, skip with a
message rather than failing: a Windows box without the C++ workload is a valid
place to run the rest of the suite.

Assert against a **synthetic project written into the scratch/temp directory**,
never against the corpus — `CLAUDE.md` rule 8, and a design-time build over the
corpus is 4 minutes. The synthetic project should carry a per-file
`PreprocessorDefinitions` override so the test proves per-file flags actually
differ between two source files. A minimal one that works:

```xml
<ItemDefinitionGroup>
  <ClCompile>
    <PreprocessorDefinitions>WIN32;FOO=1;%(PreprocessorDefinitions)</PreprocessorDefinitions>
    <AdditionalIncludeDirectories>$(ProjectDir)inc;%(AdditionalIncludeDirectories)</AdditionalIncludeDirectories>
  </ClCompile>
</ItemDefinitionGroup>
<ItemGroup>
  <ClCompile Include="main.cpp" />
  <ClCompile Include="other.cpp">
    <PreprocessorDefinitions>ONLYOTHER;%(PreprocessorDefinitions)</PreprocessorDefinitions>
  </ClCompile>
</ItemGroup>
```

What to assert: two entries come back; `other.cpp` carries `ONLYOTHER` and
`main.cpp` does not; both carry `FOO=1`; argv[0] is an existing file on disk
(this is the regression test for the bogus `system32\CL.exe`); the system include
dirs are present so `<windows.h>` would resolve; and **`git status` in
`sample-projects/` is untouched** by the run.

Also assert the version gate rejects a stub reporting `16.11`.

## Regenerating the phase-01 fixture

Needs Windows and VS ≥ 17.8. Run the invocation from `00-design.md` over ~30
random corpus projects, keep only `Identity`, `Files`, `WorkingDirectory`,
`ToolPath`, `ConfigurationOptions` from `GetClCommandLines`, plus one
`GetProjectDirectories` item's `IncludePath`/`ExternalIncludePath`/`ProjectDir`,
and write it in the shape `tests/fixtures/clCommandLines.json` already has. Keep
the hard cases listed in `plans/01-core.md` — a regenerated fixture that has lost
`/I\ks` or the mixed attached/detached `/D` entry is worse than the old one.

## Done when

`npm test` green on Windows with the extraction tests actually running, and green
on macOS with them skipped. `npm run typecheck` clean on both.

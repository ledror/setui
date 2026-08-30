# Phase 01 — the pure core

Read `plans/00-design.md` first.

Everything in this phase is pure: no filesystem, no spawning, no Ink. It runs
identically on macOS and Windows, and it is where the logic most likely to be
subtly wrong lives — so it carries the real tests.

## Deliverable

`src/core/compileCommands.ts`. One new file; nothing else changes.

## Why a new file

`CLAUDE.md` says prefer adding to an existing module. There is no honest home:
`src/core/build.ts` is 49 lines of msbuild argv construction and shares nothing
with this. Forcing them together would hurt both.

## The contract

```ts
/** One entry of a clang JSON compilation database. */
export interface CompileCommand {
  file: string       // absolute, backslashes
  directory: string  // absolute
  arguments: string[]
}

/** A raw GetClCommandLines item, exactly as MSBuild's JSON delivers it. */
export interface ClCommandLine {
  Identity: string
  Files: string
  WorkingDirectory: string
  ToolPath: string
  ConfigurationOptions?: string
}

/** System header dirs from GetProjectDirectories, already split and cleaned. */
export interface ProjectDirectories {
  includePath: string[]
  externalIncludePath: string[]
  projectDir: string
}

export interface ToolchainInfo {
  clPath: string      // the real cl.exe, resolved in phase 02
  target: string      // clang triple, e.g. "x86_64-pc-windows-msvc"
  vsInstallDir: string // used to drop the toolset's own .ixx module entries
}

/** Split a cl command line into tokens. Quote-aware. */
export function tokenize(commandLine: string): string[]

/** Raw MSBuild items -> compile commands. Absolutizes, injects, filters. */
export function toCompileCommands(
  items: ClCommandLine[],
  dirs: ProjectDirectories,
  toolchain: ToolchainInfo,
): CompileCommand[]

/** Accumulate `incoming` into `existing`. See 00-design.md "Merging". */
export function merge(
  existing: CompileCommand[],
  incoming: CompileCommand[],
): CompileCommand[]

/** Sorted, stable, trailing newline. */
export function serialize(entries: CompileCommand[]): string

/** Tolerant read of an existing database; unusable input throws with the path. */
export function parse(json: string): CompileCommand[]
```

`parse` must accept a database written by another tool: entries carrying
`command` (a string) instead of `arguments` get tokenized on the way in, and
unknown extra keys are dropped rather than preserved. A file that is not a JSON
array throws — we are about to overwrite it and must not do so blindly.

## Rules this phase must not break

1. **`path.win32` everywhere.** Never the platform default. See 00-design.md.
2. `src/core/` imports nothing from `src/tui/`, does no I/O, spawns nothing.
3. Backslashes on write, comparison normalizes separator *and* case.

## The fixture

`tests/fixtures/clCommandLines.json` is already committed. It is 57 real entries
captured from MSBuild 18.9 over 30 random `Windows-driver-samples` projects plus
one synthetic project, and it is the reason this phase is testable on a Mac.
Regenerating it needs Windows and VS ≥ 17.8; the recipe is in
`plans/02-extraction.md`.

It deliberately contains every hard case:

| Case | Present as |
|---|---|
| relative include | `/I..\common`, `/I..\..\inc`, `/I..\` |
| root-relative include | `/I\ks` |
| absolute quoted include | `/I"C:\...\inc"` |
| attached *and* detached `/D` in one entry | `/D _WIN64 ... /D_ATL_NO_WIN_SUPPORT` |
| PCH header names | `/Yu"precomp.h"`, `/Yc"precomp.h"` |
| stripped output flags | `/Fo"...\x64\Debug\\"`, `/Fp"...\precomp.pch"` |
| toolset module noise | two entries whose `Files` is the MSVC `std.ixx` |
| defaults probe | 31 entries with `ConfigurationOptions: "true"` |

## Tests — `tests/compileCommands.test.ts`

Run everywhere. No Windows needed.

- **tokenize**: `/I"C:\a b\inc"` stays one token; `/D FOO` stays two; `/Yu"p.h"`
  keeps its quotes; an empty command line yields `[]`.
- **absolutize**: `/I..\common` with `WorkingDirectory=C:\x\y` becomes
  `C:\x\common`. `/I\ks` becomes `C:\ks`. An already-absolute `/I` is unchanged.
  `/Yu"precomp.h"` is **not** touched.
- **the `path.win32` guard**: assert a resolved include contains no forward
  slashes and starts with a drive letter. This is the test that must go red if
  someone imports the default `path` — say so in a comment, it is the whole point.
- **macro dedup**: merging `/D FOO=1` then `/D FOO=2` keeps exactly one `FOO`,
  and it is `FOO=1`. `/DFOO` and `/D FOO` collapse to one.
- **accumulate**: merging project B into project A's entry for a shared file
  keeps A's `/I` *and* B's `/I`, and takes B's `/std:` — the 00-design.md table,
  asserted directly.
- **filtering**: the two toolset `.ixx` entries are dropped; a `.ixx` under the
  project dir survives; `/Fo`/`/Fd`/`/Fp`/`/errorReport` never appear in output.
- **the inverse test `CLAUDE.md` demands**:
  - *idempotence* — `merge(merge(db, x), x)` serializes byte-identically to
    `merge(db, x)`.
  - *order independence* — `merge(merge(db, a), b)` and `merge(merge(db, b), a)`
    agree on every accumulated flag set.
  These are where ordering bugs in dedup will actually surface.
- **not vacuous**: assert entry counts from the fixture (57 in, a known number
  out after filtering). Per `CLAUDE.md`, a filter that silently matches nothing
  looks exactly like a passing test.

## Done when

`npm test` and `npm run typecheck` pass on both macOS and Windows, and the
fixture round-trips through `parse -> merge -> serialize` with the counts
asserted.

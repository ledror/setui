# compile_commands.json — the settled design

This file is the shared context for phases 01–04. It is **not** a phase: it is
deleted when 04 lands, and the parts still true then move into `ARCHITECTURE.md`.
Do not annotate it with progress.

Read `ARCHITECTURE.md` and `CLAUDE.md` first. Everything here obeys them.

## What we are building

Generate a clang [JSON compilation database][spec] for a `.vcxproj`, or for every
project in a `.sln`, from inside setui, and **merge** it into an existing
`compile_commands.json` chosen by the user.

[spec]: https://clang.llvm.org/docs/JSONCompilationDatabase.html

The workflow this exists for: generate once for a whole solution, then days later
re-generate for the one project you touched, without losing what the other
projects contributed.

## Non-goals

No PowerShell. No C#. No .NET. No binlog parsing. No multi-configuration output,
no `--all-configurations`, no `--prefer-*`. No multi-solution selection UI. No
`.vscode/c_cpp_properties.json`. No `--validate`. No rich hierarchical format. No
transitive project-reference following. No provenance or sentinel entries.

`compile_commands/msbuild-extractor-sample/` is a C# tool that does this in 5,580
lines with a hard dependency on the .NET runtime. It is **reference material for
output formatting only**. Its deduplication is not a model to follow — we made a
different and deliberate choice, see "Merging". It is gitignored.

## The mechanism (verified on this machine, MSBuild 18.9.1.35102)

MSBuild ≥ 17.8 prints target results as JSON. That removes the entire reason the
C# tool exists: there is nothing to parse out of a binlog.

```
MSBuild.exe <project.vcxproj>
  /nologo
  /p:Configuration=<cfg> /p:Platform=<plat>
  /p:SolutionDir=<dir-of-open-sln>\
  /p:DesignTimeBuild=true
  /p:BuildingInsideVisualStudio=true
  /p:BuildProjectReferences=false
  /t:ComputeReferenceCLInput;GetProjectDirectories;GetClCommandLines
  -getTargetResult:GetClCommandLines
  -getTargetResult:GetProjectDirectories
  -getResultOutputFile:<temp.json>
```

`-getResultOutputFile` writes the JSON to a file, so stdout stays free for
progress output and nothing has to be de-interleaved.

Measured: **~0.9 s per project**; 30/30 random corpus projects succeeded; the run
leaves the corpus submodule's `git status` clean (design-time builds write
nothing).

`GetClCommandLines` yields items shaped:

```
Identity             the cl switches, e.g. "/c /I..\common /I\ks /W4 /D FOO ..."
Files                semicolon-separated absolute source paths
WorkingDirectory     absolute; Identity's relative paths resolve against this
ToolPath             "C:\WINDOWS\system32\CL.exe" — GARBAGE, see "Entry shape"
ConfigurationOptions "true" on the project-wide defaults probe
```

`GetProjectDirectories` yields one item carrying `IncludePath` and
`ExternalIncludePath` — the MSVC and Windows SDK header directories. Those reach
the real compiler through the `INCLUDE` environment variable, which a compilation
database cannot express, so **without injecting them clangd cannot find
`<windows.h>`**.

## Merging (the central decision)

**Entries accumulate. They are never replaced wholesale.**

The motivating case: 100 projects each compile a shared core project's sources.
Re-generating project 37 must not discard the include dirs and defines the other
99 contributed, because the point of one database is cross-project navigation
across all of them at once.

| Flag family | Behaviour |
|---|---|
| `/I`, `/external:I`, `/FI` | **accumulate** — union, first-seen order preserved |
| `/D` | **accumulate**, deduplicated by macro *name* (`/D FOO` and `/D FOO=2` are the same macro; first writer wins, so the result does not depend on generation order) |
| everything else | **last writer wins** (`/std:`, `/M[DT]d?`, `/O*`, `/EH*`, `/W*`, `/T[CP]`, `/Zc:*`, …) |

Consequences, accepted deliberately:

- An entry can carry flags the project you last generated does not itself use.
  This is a known, accepted inaccuracy — the cross-project LSP win is worth it.
- Entries only ever grow. Deleting a source file cannot be reflected by a merge;
  the answer is to generate from scratch into a fresh file.
- Accuracy is controlled by **where the output file lives**. Want an exact
  database for one project? Point the output at a path beside that `.vcxproj`.
  Want everything cross-referenced? Point 100 solutions at one file at the repo
  root. The granularity knob is the output path, not a flag.

**Identity of an entry**: the normalized absolute `file` path, compared
case-insensitively. Exactly one entry per file. `directory` is the most recent
writer's `WorkingDirectory` — after absolutization it no longer affects how any
flag resolves, so it is close to decorative, but it is emitted truthfully.

## Absolutization (why the merge is possible at all)

Surveyed across 30 real corpus projects: **55 of 55 `/I` values were relative.**
Zero absolute, zero quoted, zero detached.

```
..\common    \ks    ..\..\inc    .    ..\..\..\..\wil\include    ..\
```

Accumulating a relative `/I` into an entry whose `directory` belongs to a
different project silently resolves it somewhere else. So every path-bearing flag
is made absolute **at extraction time, before anything is merged**:

```
/I  /FI  /external:I  /imsvc   →  path.win32.resolve(WorkingDirectory, value)
everything else                →  verbatim
```

- `\ks` (root-relative, no drive) resolves to `<drive of WorkingDirectory>:\ks`,
  which is what cl.exe does. `path.win32.resolve` gets this right; no special case.
- **Use `path.win32`, never the platform-default `path`.** On macOS the default
  treats `..\..\inc` as a filename containing backslashes and every test passes
  vacuously. This is the same trap that hid 239 projects from the corpus mutation
  tests. One test must fail if someone swaps it back.
- `/Yu"precomp.h"` and `/Yc` name a *header*, resolved through the include path.
  Never absolutize them.

Both attachment forms are real and both must be handled, for `/I` and `/D`: the
survey found **80 detached `/D FOO` against 5 attached `/DFOO`**, and one fixture
entry carries both at once. Quoted (`/I"C:\path"`) and unquoted forms both occur.

## Entry shape

`arguments` (an array), not `command` — no quoting rules to get wrong.

```
[ <real cl.exe>, --target=<triple>, -ferror-limit=0,
  /I<system include dirs...>,          # from IncludePath / ExternalIncludePath
  <absolutized project switches...>,   # from Identity
  <absolute source file> ]
```

- **argv[0] must be the real `cl.exe`.** MSBuild reports
  `C:\WINDOWS\system32\CL.exe`, which does not exist. Resolve the actual one from
  the VS install (`VC\Tools\MSVC\<ver>\bin\Host<arch>\<arch>\cl.exe`). clangd
  infers cl driver-mode from the basename, but a nonexistent path breaks anything
  that probes the compiler.
- **System includes go in as plain `/I<path>`** — not `/external:I`, not `/imsvc`.
  This is what works with clangd in practice and what the reference tool does.
  Classify them as the reference tool does: paths inside the project tree are
  prepended, paths outside are appended, matching cl's `INCLUDE`-after-`/I` search
  order so a system header cannot shadow a generated one.
- `--target=` and `-ferror-limit=0` are injected for clangd's benefit
  (`-ferror-limit=0` stops MSVC STL headers cascading into hundreds of false
  diagnostics once clang passes its default limit of 20).
- **Stripped**: `/Fo`, `/Fd`, `/Fp`, `/errorReport`. Build outputs clangd ignores;
  stripping them also means no relative output path survives into the file.
- **Dropped entries**: files under the VS install directory (the toolset's own
  `std.ixx` / `std.compat.ixx` module scans leak in), and entries whose files are
  all `.hlsl`/`.hlsli`/`.fx` (`FxCompile` items carrying fxc switches, not cl
  switches). A `.ixx` inside the user's own project is kept.
- The `ConfigurationOptions=true` defaults probe is not emitted as its own entry.

## Output file

- Entries sorted by `file`, case-insensitively. Regenerating one project then
  produces a diff confined to that project's lines.
- Within an entry the winner's flag order is preserved, and newly accumulated
  `/I`/`/D` are appended in first-seen order.
- `JSON.stringify(entries, null, 2)` plus a trailing newline.
- **The byte-preservation rules in `CLAUDE.md` do not apply here.** Those govern
  `.vcxproj` and `.vcxproj.filters`, which are the user's files. This is a
  generated artifact we own outright: written whole, never spliced.

## Configuration and platform

Generation always uses the **currently selected** `Configuration|Platform` — the
one the `p` key sets and builds already use. No per-generation prompt, no
multi-config output.

If the user switches `p` between generations the database ends up mixing configs.
That is theirs to reason about and we do not warn about it.

## Failure handling

A project failing is **expected**, not exceptional — most often because it does
not define the selected `Configuration|Platform`. So: log the project and
MSBuild's error, continue, and write the merged database at the end from whatever
succeeded. Final status names the counts:
`merged 97 projects into <path> (3 failed)`.

Cancelling with `esc` writes what was extracted so far. A partial generation is a
valid increment under the accumulate model, and the user can re-run the failed
projects individually, with a different config if that is what they need.

## Platform support

Generation is **Windows-only** and needs MSBuild ≥ 17.8. setui itself must stay
fully runnable on macOS — it is developed there. On a non-Windows host the feature
fails gracefully with a clear message: never a crash, never a half-working path.

## Known baseline (measured 2026-08-30, before any of this work)

**`tests/app.test.tsx` already fails on Windows.** At `HEAD~1` — before the
gitignore commit, with no feature code written — it reports 16 failed / 19 passed
/ 21 skipped. A second run of the full suite gave 19 failed, so the failures are
**flaky and timing-sensitive**, not deterministic; the helpers use `settle(60)`
and the assertions are on rendered Ink frames.

This matters for every phase's "done when": *green on both platforms* is not
currently achievable on Windows, and it is not this feature's fault. Do not
attribute these to your changes, and do not try to fix them inside a phase.
Establish the baseline first (`npx vitest run tests/app.test.tsx`, twice) and
compare against it. Fixing the flakiness is separate work.

## Phases

Implement in order. The data shape from 01 is what everything else consumes.

| | File | What |
|---|---|---|
| 01 | `plans/01-core.md` | pure core: tokenize, absolutize, merge, serialize |
| 02 | `plans/02-extraction.md` | vswhere, cl.exe, MSBuild spawn, version gate |
| 03 | `plans/03-config.md` | the two-MSBuild config shape |
| 04 | `plans/04-tui.md` | keybind, overlays, progress, cancel |

Delete each phase file as it lands. Delete this one with 04.

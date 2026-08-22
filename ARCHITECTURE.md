# setui — Architecture

`setui` is a terminal Solution Explorer for Visual Studio C++ solutions: browse `.sln`
files, their projects, their filters and files, edit filters/files/references, and
invoke msbuild. It accompanies a text editor; it does not replace Visual Studio for
complex project surgery.

## Layering

```
src/core/   pure library. No Ink, no React, no process spawning, no fs writes
            beyond the three project-file types. Imports nothing from src/tui.
src/tui/    Ink app. Owns all disk side effects (mkdir, create, rename, delete),
            process spawning, and config.
```

The core boundary is a directory rule, not a package boundary. It is enforced by
convention and review: **nothing under `src/core/` may import from `src/tui/`.**

## The splice model (the central decision)

Project files are parsed into a **CST** (concrete syntax tree): every node carries
byte offsets into the original source, and all trivia (whitespace, comments, BOM,
line endings, attribute quoting) is represented or recoverable.

Mutations never re-serialize the tree. They produce a list of
`{ start, end, text }` splices applied to the *original* source string. Bytes we did
not deliberately edit are the same bytes, not regenerated equivalents.

Consequences, all of them load-bearing:

- Formatting preservation is free, not a feature we maintain.
- Idempotency is structural: a no-op action yields a byte-identical file.
- A file with formatting we never anticipated still round-trips perfectly.
- We never need a printer that reproduces every quirk of 265 real-world files.

**Contract: if an action changes nothing semantically, the file is byte-identical.**

## Fidelity rules

- Never normalize: BOM, line endings (CRLF/LF), indentation, tabs, attribute quote
  style, GUID casing, and entity encoding are all preserved as found.
- New lines inserted copy the EOL and indentation of their neighbouring siblings.
- Paths inside `.vcxproj`/`.filters` always use **backslashes** on write. Input may
  use either separator. Path comparison normalizes separator and case (Windows
  semantics); stored bytes keep whatever was there.

## Parsers

Two hand-written parsers, both stateless (one input string, one output tree). Neither
follows imports, property inheritance, `Condition` evaluation, or any other MSBuild
semantics. They parse the file in front of them and nothing else.

Both were validated against the sample corpus, which taught two things worth
keeping:

- Most Visual Studio-written `.sln` files begin with a **blank line before the
  header**, so the header is "the first non-empty line", not line 1.
- Item element names **cannot be whitelisted**. The corpus alone uses 21 of them
  (`FilesToPackage`, `OtherWpp`, `Wmimofck`, `MASM`, `Ctrpp`...). Anything in an
  `ItemGroup` with an `Include` is treated as a file; non-file items are
  blacklisted instead.

1. **XML CST** (`src/core/xml.ts`) — shared by `.vcxproj` and `.vcxproj.filters`.
   Just enough XML for MSBuild files: declaration, elements, attributes, text,
   comments. No DTD, no namespace resolution, no CDATA handling beyond passthrough.
2. **SLN CST** (`src/core/sln.ts`) — line-oriented. `Project(...)`/`EndProject`
   blocks and `GlobalSection(...)`/`EndGlobalSection` blocks.

Unparseable input **throws** a typed error with byte offset and line/column. There is
no partial parse: splicing a partially-understood CST is how project files get
destroyed.

## What counts as a file

An item's `Include` is not always one path, so `Project.files` classifies each entry:

- `file` — one concrete path. The only kind setui will edit.
- `shared` — one path out of a semicolon-separated MSBuild item list. Shown in the
  tree (the user wants to see those sources) but not editable: changing one would
  mean rewriting a list.
- `computed` — a wildcard or an unexpanded `$(...)` macro, such as the
  `FilesToPackage Include="$(TargetPath)"` that appears 251 times in the sample
  corpus. These are build inputs and outputs, not source files. The TUI hides them,
  as Visual Studio does.

Every mutation verb refuses anything but `file`, with a message saying why. The
escape hatch is `e` on a project, which opens the `.vcxproj` in the user's editor.

## Solutions are read-only

`setui` never writes a `.sln` byte. Every supported feature — filters, files,
references, build — is achievable without it. Adding a project to a solution means
GUID allocation, configuration-matrix maintenance, and `NestedProjects` surgery: that
is the "do it in Visual Studio or by hand" category.

## The Project facade

A file exists twice: as an item in `.vcxproj` and as an entry in `.vcxproj.filters`.
`openProject(path)` loads both CSTs and exposes domain verbs (`addFile`,
`moveToFilter`, `renameFilter`, …). Callers never see two files. `save()` writes only
the files that actually changed.

If a project has no `.filters` file, filter operations **fail**. We do not synthesize
a `.filters` file from scratch.

Every mutation verb has an inverse test asserting byte-identity, run over both
fixtures and the whole corpus. One exception, deliberate: moving a file out of a
filter deletes its `.filters` entry entirely (what Visual Studio writes), so moving
it back re-appends rather than restoring its old position. Entry order carries no
meaning; that guarantee is semantic, and byte-stable from the second round trip on.

## Virtual paths and building

The msbuild target for a project is its path *inside the solution*, built from the
`NestedProjects` section, using **backslashes**, with `.` escaped to `_`:

```
SolutionFolder1\SolutionFolder2\ProjectName
```

Command line (spawned with an argv array, never a shell string):

```
<msbuild> <sln> /t:<VirtualPath>:<Build|Rebuild|Clean> /p:Configuration=<c> /p:Platform=<p> /m /nologo
```

## Safety

- Record mtime+size at open; re-stat before write and refuse on mismatch (`R` reloads).
- Write via temp file + rename in the same directory.
- No undo stack. These files live in git; git is the undo. Destructive keys confirm.

## No persistence

`setui` is stateless between runs. It remembers nothing except what is in
`~/.setui.json` (msbuild path, editor). Default configuration is chosen by sorting
configurations and platforms and picking the first containing `debug` / `x64`
(case-insensitive), falling back to the first entry.

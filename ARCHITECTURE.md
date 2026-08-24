# setui — Architecture

`setui` is a terminal Solution Explorer for Visual Studio C++ solutions: browse `.sln`
files, their projects, their filters and files, edit filters/files/references, and
invoke msbuild. It accompanies a text editor; it does not replace Visual Studio for
complex project surgery.

## Layering

```
src/core/   pure library. No Ink, no React, no process spawning, and no filesystem
            writes beyond the two files a project owns (.vcxproj and its
            .vcxproj.filters). Imports nothing from src/tui.
src/tui/    Ink app. Owns every disk side effect (mkdir, create, rename, delete),
            every spawn, and the config file.
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

1. **XML CST** (`src/core/xml.ts`) — shared by `.vcxproj` and `.vcxproj.filters`.
   Just enough XML for MSBuild files: declaration, elements, attributes, text,
   comments. No DTD, no namespace resolution, no CDATA handling beyond passthrough.
2. **SLN CST** (`src/core/sln.ts`) — line-oriented. `Project(...)`/`EndProject`
   blocks and `GlobalSection(...)`/`EndGlobalSection` blocks.

Both tile their source completely: every byte belongs to exactly one node. That is
what the round-trip tests actually assert, and it is what makes splicing safe — a
parser that silently skipped something it did not understand would corrupt files.

Unparseable input **throws** a typed error with byte offset and line/column. There is
no partial parse: splicing a partially-understood CST is how project files get
destroyed.

Two things the sample corpus taught, both of which cost a test run to find:

- Most Visual Studio-written `.sln` files begin with a **blank line before the
  header**, so the header is "the first non-empty line", not line 1. 132 of 136
  failed until that was handled.
- Item element names **cannot be whitelisted**. The corpus alone uses 21 of them
  (`FilesToPackage`, `OtherWpp`, `Wmimofck`, `MASM`, `Ctrpp`...). Anything in an
  `ItemGroup` with an `Include` is treated as a file; non-file items are
  blacklisted instead.

## What counts as a file

An item's `Include` is not always one path, so `Project.files` classifies each entry:

- `file` — one concrete path. The only kind setui will edit.
- `shared` — one path out of a semicolon-separated MSBuild item list. Shown in the
  tree (the user wants to see those sources) but not editable: changing one would
  mean rewriting a list.
- `computed` — a wildcard, or any unexpanded MSBuild expression: `$(Property)`,
  `@(ItemList)`, or an item transform like `@(Inf->'%(CopyOutput)')`. The sample
  corpus has 251 of the first kind alone. These are build inputs and outputs, not
  source files. The TUI hides them, as Visual Studio does.

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

The filters file is located **case-insensitively**. Windows filenames are, and real
projects rely on it: 239 of the 253 filters files in the sample corpus are
spelled `.vcxproj.Filters` with a capital F. Matching exactly treated almost all of them as
having no filters on a case-sensitive filesystem — which also silently narrowed the
corpus mutation tests to the two dozen that happened to match.

If a project has no `.filters` file at all, filter operations **fail**. We do not
synthesize one from scratch.

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
<msbuild> <sln> /t:<VirtualPath>[:Rebuild|:Clean] /p:Configuration=<c> /p:Platform=<p> /m /nologo [msbuildArgs...]
```

Build takes **no target suffix**: msbuild rejects the explicit `Project:Build` form,
while `Project:Rebuild` and `Project:Clean` are required.

`msbuildArgs` from the config is appended **last**, verbatim. It is deliberately a
dumb passthrough: no validation, no allow-list, no per-target or per-solution
variants. Appending last means msbuild's last-one-wins lets the user override the
defaults setui passes, without setui maintaining a list of which ones may be
replaced. The cost is that `/p:Configuration=` in there defeats the configuration
picker silently; that is documented rather than policed, because validating would
mean tracking every msbuild switch across versions and would block exactly the
unanticipated uses the feature exists for.

Every build logs its resolved command line first, which is what makes that
passthrough debuggable. That rendering quotes arguments for copy-paste only — the
spawn itself passes an argv array and never goes near a shell.

The child is watched with `exit` rather than `close`. A killed `msbuild /m` can leave
worker processes holding the output pipe open, and waiting for the streams to end
would strand the UI mid-build.


## Safety

- Record mtime+size at open; re-stat before write and refuse on mismatch (`R` reloads).
- Write via temp file + rename in the same directory.
- No undo stack. These files live in git; git is the undo.
- **Every removal is confirmed** — including ones that only edit the project file
  and leave the source on disk. A stray keypress must never cost someone work.

## Distribution

`npm run bundle` (see `build.mjs`) produces a single `dist/setui.js` that runs under
a bare `node`, with no `node_modules` beside it. Two details make that work: the
output is ESM but several dependencies are CommonJS and `require()` Node builtins at
load time, so the banner installs a `createRequire` shim; and Ink imports the
optional `react-devtools-core` unconditionally, so the bundle aliases it to a stub
rather than shipping it. A test copies the bundle outside the repo and runs it,
which is what actually proves it is self-contained — module resolution follows the
file, not the working directory.

## Build output

Output is wrapped to the terminal width by `wrapLines` before either view renders
it, rather than being left to Ink. Both views window by row index, so a line that
occupies three rows on screen has to count as three or the scrolling and the pane's
fixed height go wrong. Truncating instead would hide the end of long lines, and
msbuild lines are mostly long paths.

The full-screen log follows the newest output until the user scrolls up, and
re-attaches when they get back to the bottom — by `G`, or just by scrolling down to
the end. The header says which mode it is in.

## Layout

The app renders in the terminal's **alternate screen** (`alternateScreen` in
`src/cli.tsx`). Without it the first frame is only as tall as the solution picker and
the view lurches when a solution opens; with it setui owns the whole screen from the
first frame and the user's scrollback is restored on exit. Two consequences: the
solution picker is sized from the terminal rather than the overlays' fixed 12 rows,
and opening `$EDITOR` goes through Ink's `suspendTerminal`, which leaves the
alternate screen for the child and re-enters and repaints afterwards — a nested
alternate screen is a boolean, not a stack, so a plain `spawnSync` would drop setui
onto the primary screen when the editor exited.

Rendering runs at `maxFps: 60` with `incrementalRendering`, against Ink's defaults of
30fps and a full redraw per frame.

The whole app must fit the terminal exactly. Overlays (prompt, select, confirm,
help) are laid out below the tree, so their height is subtracted from the tree's;
otherwise opening a dialog pushes the header off the top and the view jumps.

## No persistence

`setui` is stateless between runs: no cache, no session file, nothing written beside
the user's sources. The only state is `~/.setui.json` — `msbuild`, `editor`,
`logLines`, `msbuildArgs` — and it is never written by setui after it is created
empty on first run.

Which configuration a solution opens with is therefore derived, not remembered: sort
the configurations and platforms, take the first containing `debug` and the first
containing `x64` (case-insensitive), falling back to the first entry. Sorting first
is what makes the choice stable across runs.

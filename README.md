# setui

The Visual Studio Solution Explorer, in your terminal.

`setui` browses `.sln` files, their projects, filters, files and project references,
edits them, and drives msbuild — without ever reformatting a byte you didn't ask it
to change. It is meant to sit next to your text editor and cover the day-to-day work:
moving files between filters, adding files, wiring up references, and compiling.
Anything more elaborate is still a job for Visual Studio or a text editor.

## Install

```
npm install
npm run build
```

Runs on Node 20+. Windows is the target platform (that is where msbuild lives);
it runs on macOS and Linux too, minus the build commands.

## Use

```
setui                # search for solutions under the current directory
setui path/to/dir    # search under a directory
setui path/to/x.sln  # open a solution directly
```

On first run it writes `~/.setui.json`:

```json
{
  "msbuild": "C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\MSBuild\\Current\\Bin\\MSBuild.exe",
  "editor": "code -w"
}
```

Fill in `msbuild` — build, rebuild and clean stay disabled until you do. Press `,`
inside setui to open the file in your editor.

A nerd font is assumed, for the file-type icons.

## Keys

```
j k up down       move                  h l left right   collapse / expand
g G               top / bottom          ctrl+u ctrl+d    half page
PgUp PgDn         page
/                 search                enter            expand, or open a file
-  backspace      back to the solution list
a                 add a file, creating it on disk (directories included)
                  on References: add a project reference
A                 add a file that already exists
d                 remove from the project
D                 remove from the project and delete it from disk
f                 new filter (nested filters allowed)
r                 rename a file or a filter
m                 move a file to another filter
b B c             build / rebuild / clean
p                 pick Configuration|Platform
o                 toggle the full build log       esc   clear search / cancel build
e                 open a file, or the .vcxproj itself on a project
,                 open ~/.setui.json
R                 reload from disk                ?  q  help / quit
```

## What it will not do

- **Write `.sln` files.** Adding a project to a solution means GUID allocation and
  configuration-matrix surgery; do that in Visual Studio.
- **Reformat anything.** Edits are byte splices against the original file. If an
  action changes nothing semantically, the file is byte-identical afterwards.
- **Create a `.vcxproj.filters` file.** Filter operations fail on a project that has
  none, rather than inventing one.

## Development

```
npm test          # unit tests plus corpus round-trip tests
npm run typecheck
```

`sample-projects/Windows-driver-samples` is a read-only corpus of 136 solutions and
265 projects. The corpus tests parse every one of them, apply and un-apply edits in
memory, and assert byte-identical results. They never write to it: a test run leaves
`git status` clean, and running the suite twice gives identical results.

See `ARCHITECTURE.md` for the design and `CLAUDE.md` for the working rules.

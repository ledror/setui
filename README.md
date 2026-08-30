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
npm run bundle
```

That produces **`dist/setui.js`**: one self-contained file with no `node_modules`
beside it. Copy it anywhere and run it:

```
node setui.js
```

On Unix it is directly executable (`chmod +x setui.js && ./setui.js`). Node 20+.
Windows is the target platform (that is where msbuild lives); it runs on macOS and
Linux too, minus the build commands.

## Use

```
node setui.js                # search for solutions under the current directory
node setui.js path/to/dir    # search under a directory
node setui.js path/to/x.sln  # open a solution directly
```

(`setui ...` if you put it on your PATH, or `npm link` from a checkout.)

On first run it writes `~/.setui.json`:

```json
{
  "msbuild": {
    "build": "C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\MSBuild\\Current\\Bin\\MSBuild.exe",
    "compileCommands": ""
  },
  "editor": "code -w",
  "logLines": 15,
  "msbuildArgs": "/v:m /nodeReuse:false"
}
```

Fill in `msbuild.build` — build, rebuild and clean stay disabled until you do. Press
`,` inside setui to open the config in your editor, and `R` to reload.

`msbuild.compileCommands` is the MSBuild used by `C` to generate
`compile_commands.json`. Leave it empty to use `msbuild.build`. It is separate
because generation reads `-getTargetResult`, which landed in MSBuild 17.8: VS 2019
ships 16.x and can never do it, while the MSBuild that builds your solution is often
exactly that older one. If the one in use is too old, `C` says so and names this key.

The older string form still works and still means the build MSBuild:

```json
"msbuild": "C:\\...\\MSBuild.exe"
```

`logLines` is how much build output stays on screen (default 15, clamped to 3-60);
`o` opens the whole log full-screen regardless.

`msbuildArgs` is appended verbatim to every build, rebuild and clean. It is a dumb
passthrough: nothing is inspected or validated, so anything msbuild accepts works.
Because the arguments go **last**, they override the defaults setui passes — `/m:4`
beats its `/m`. Either form works:

```json
"msbuildArgs": "/v:m /nodeReuse:false"
"msbuildArgs": ["/p:Banner=Hello World", "/v:q"]
```

Use the array when a single argument has to contain a space; there are no quoting
rules, because msbuild is spawned with an argument array and never through a shell.

One thing to watch: putting `/p:Configuration=...` or `/p:Platform=...` in there
silently defeats the `p` picker — the header will say one thing while msbuild builds
another. setui does not police this. Every build logs the exact command it ran as
its first line, so you can always see what was passed.

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
d                 remove from the project        (confirms)
D                 remove from the project and delete it from disk (confirms)
f                 new filter (nested filters allowed)
r                 rename a file or a filter
m                 move a file to another filter
b B c             build / rebuild / clean
p                 pick Configuration|Platform
o                 toggle the full build log (wraps, and follows new output)
esc               cancel the build, then hide its output, then clear search
e                 open a file, or the .vcxproj itself on a project
,                 open ~/.setui.json
R                 reload from disk                ?  q  help / quit
```

Inside the full-screen build log (`o`): `j k` and the arrows scroll, `ctrl+u ctrl+d`
and `PgUp PgDn` page, `g G` jump to the start and end. It follows new output as it
arrives until you scroll up, and starts following again when you get back to the
bottom; the header says which it is doing.

## What it will not do

- **Write `.sln` files.** Adding a project to a solution means GUID allocation and
  configuration-matrix surgery; do that in Visual Studio.
- **Reformat anything.** Edits are byte splices against the original file. If an
  action changes nothing semantically, the file is byte-identical afterwards.
- **Create a `.vcxproj.filters` file.** Filter operations fail on a project that has
  none, rather than inventing one.
- **Show or edit items that are not plain file paths.** Wildcards and MSBuild
  expressions (`$(TargetPath)`, `@(ClSourceFiles)`) are build inputs and outputs, not
  sources, and are hidden — as Visual Studio hides them. Files named by a
  semicolon-separated `Include` are shown but not editable, since changing one would
  mean rewriting a list. `e` on a project opens the `.vcxproj` for those cases.

## Development

```
npm test          # unit tests, corpus round-trip tests, and a bundle smoke test
npm run typecheck
npm run bundle    # dist/setui.js
```

`sample-projects/Windows-driver-samples` is a read-only corpus of 136 solutions and
265 projects. The corpus tests parse every one of them, apply and un-apply edits in
memory, and assert byte-identical results. They never write to it: a test run leaves
`git status` clean, and running the suite twice gives identical results.

See `ARCHITECTURE.md` for the design and `CLAUDE.md` for the working rules.

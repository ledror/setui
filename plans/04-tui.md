# Phase 04 — the TUI

Read `plans/00-design.md` first. Depends on 01, 02 and 03.

## Deliverable

Edits only — no new files:

| File | Change |
|---|---|
| `src/tui/app.tsx` | the `C` keybind, two overlays in sequence, generation state, help entry |
| `src/tui/build.ts` | generalize `startBuild` into `startProcess`; keep `startBuild` as a thin wrapper |
| `src/tui/discover.ts` | generalize `findSolutions` into `findFiles(root, name)` |
| `CLAUDE.md`, `README.md`, `ARCHITECTURE.md` | document the feature and the test-skip situation |

## The keybind

**`C`.** Free (checked: `s t v w x y z n i u C F M P E S` are all unused), and it
pairs mnemonically with lowercase `c` for Clean.

`C` opens a `select` overlay with two items, the cursor's context deciding which
is preselected:

```
this project (Foo)
whole solution (37 projects)
```

Then a second `select` overlay for the output path (below). Two overlays in
sequence, both the existing component — no new UI primitive.

Help entry, in the block near the build keys:

```
['C', 'generate compile_commands.json'],
```

## The output-path picker

Generalize `findSolutions(root)` into `findFiles(root, name)`. The fd/rg/walk
fallback chain and the `SKIP` set are exactly the same problem for
`compile_commands.json` as for `*.sln`; do not write a second walker.
`findSolutions` becomes a one-line call so nothing else changes. Note fd and rg
take a glob, so `name` needs to reach both the `--extension`/`--glob` forms and
the `readdir` walk — adjust the arg shapes rather than duplicating the function.

The picker lists every `compile_commands.json` found under the directory setui
was launched with (the `start` prop, **not** `process.cwd()`), plus a first entry
that is the default:

```
<new>  C:\repo\compile_commands.json          <- beside the open .sln
C:\repo\compile_commands.json
C:\repo\sub\compile_commands.json
```

`SKIP` hides `bin`/`obj`/`Debug`/`Release`/`x64`, so a database inside a build
directory will not be listed. That is the right trade for `.sln` and acceptable
here — the user can still reach it by typing a path.

`SelectList` filters but cannot return free text, so add a final entry
`<type a path...>` that opens the existing `prompt` overlay. Escape at any point
cancels the whole operation.

## Running it

Rename `startBuild` to `startProcess(exe, args, onOutput, onExit)` and have
`startBuild` call it. Everything that makes it good is already generic: the
100 ms output coalescing (with the comment explaining why a loud build starved
keystrokes), the `taskkill /T` on Windows, `'exit'` rather than `'close'`. Do not
reimplement any of it.

Generation reuses the build pane verbatim: same streaming output, same `esc` to
cancel, same `o` for the full-screen log. Emit one line per project as it goes so
a 90-second run is legible:

```
[12/37] Foo.vcxproj ... 214 files
[13/37] Bar.vcxproj ... FAILED: project does not define Debug|x64
```

Guard against a build and a generation running at once — `running` is a single
ref. Refuse with a status message rather than queueing.

On cancel, write what has been extracted so far and say so:
`cancelled: merged 12 of 37 projects into <path>`.

## Non-Windows hosts

setui must stay fully usable on macOS; only generation is unavailable. `C` there
sets an error status and opens nothing:

```
compile_commands.json generation needs Windows and MSBuild 17.8+
```

One `process.platform !== 'win32'` check at the top of the handler. Do not hide
the keybind from help — a silently missing key is worse than a clear refusal.

## Tests — extend `tests/app.test.tsx`

That file drives the real Ink app through `ink-testing-library` and is skipped on
win32, so these are the **macOS-side** tests. Three existing rules hold:

- **always pass `configPath`** so no test touches the real `~/.setui.json`;
- **let each keystroke land** — use the `press()` helper, never two keys in one
  tick;
- fake the external tool with a script, and assert against its **recorded argv**,
  not against what the argv-building function returned. That discipline is what
  caught the `:Build` suffix and the cancel-hangs bug, and it is what will catch a
  wrong `/p:SolutionDir` here.

Add:

- `C` opens the scope overlay; escape closes it and the tree is intact;
- picking a scope opens the output picker, populated from a temp tree containing
  two `compile_commands.json` files;
- on a non-win32 host `C` reports the platform message and opens no overlay
  (this is the macOS path, so it is directly testable there);
- `esc` during generation cancels and the partial database is written.

The extraction itself is covered on Windows by `tests/extract.test.ts` from
phase 02.

## Documentation

`CLAUDE.md` needs a short section, because the test story is now two-sided and a
future agent will otherwise assume a skipped suite is a broken one:

> `tests/app.test.tsx` is skipped on win32; `tests/extract.test.ts` is skipped
> everywhere *but* win32. `npm test` must be green on both platforms — on macOS
> with extraction skipped, on Windows with the Ink tests skipped. A run that is
> green on only one platform is not green.

Also record in `ARCHITECTURE.md`: the accumulate merge model and its accepted
inaccuracy, the `path.win32` requirement, and that `compile_commands.json` is a
generated artifact exempt from the splice/byte-preservation rules.

## Done when

`npm test`, `npm run typecheck` and `npm run bundle` pass on both platforms;
generating for a solution then re-generating for one project leaves the other
projects' accumulated flags intact — verified by hand on a real solution, since
that is the workflow the whole feature exists for.

Then delete `plans/`.

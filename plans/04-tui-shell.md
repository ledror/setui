# Phase 4 — TUI shell

## Deliverables

- `src/tui/app.tsx`, `src/tui/tree.ts`, `src/tui/icons.ts`, `src/tui/discover.ts`
- `src/cli.ts` (bin entry)

## Startup

`setui [path]`, default cwd.
- Path is a `.sln` → open it directly.
- Path is a directory → discover `.sln` files beneath it and show a picker.

Discovery shells out to `fd`/`fdfind` when available, else `rg --files`, else a
Node walker excluding `.git`, `node_modules`, and common build output dirs. We do not
reimplement `find`. Cross-platform: the Node fallback is the guaranteed path on
Windows.

## Tree

One tree after the solution is chosen, VS-style:

```
solution.sln
  ▾ ProjectA
      ▸ References
      ▾ Source Files
            main.cpp
      ▸ Header Files
        loose.txt              (files with no filter, plain node at the bottom)
  ▸ ProjectB
```

- Projects are parsed **lazily** on first expand. A 100+ project solution must open
  instantly.
- The expanded tree is flattened to an array on every structural change; only the
  visible window `[scrollTop, scrollTop + rows)` is rendered. Ink redraws the whole
  frame per keystroke, so windowing is required, not an optimization.
- Icons from the nerd-font table, converted once from
  `~/Downloads/icons_by_file_extension.lua` into a checked-in `icons.ts`. Extension
  lookup with a generic-file fallback, plus fixed glyphs for solution, project,
  filter open/closed, and references.

## Search

`/` focuses a search input. Substring, case-insensitive, filters the flattened tree;
a matching file keeps its ancestor filters visible as context. `Esc` clears,
`Enter` keeps the filter and returns focus to the tree. No fuzzy library until
substring proves annoying.

## Keymap

```
j/k, ↑/↓      move            h/l, ←/→, Enter  collapse / expand
g/G           top / bottom    PgUp/PgDn, u/d   page
/             search          Esc              clear search / kill build / back
a             add file (creates on disk, mkdir -p intermediate dirs)
A             add existing file (no disk write)
d             remove from project
D             remove from project and delete on disk   [confirm]
f             new filter (nested via A\B)
r             rename (file or filter)
m             move to filter (filter picker)
b / B / c     build / rebuild / clean
p             change Configuration|Platform
o             toggle fullscreen build log
e             open selected file in the configured editor
,             open ~/.setui.json in the configured editor
R             reload solution / project from disk
?             help overlay              q  quit
```

Destructive keys confirm. Keys that need msbuild are disabled with a visible reason
until the config has a valid path.

## Disk side effects live here

`a` → `fs.mkdir(recursive)` + create empty file, then `project.addFile`.
`r` → `fs.rename`, then `project.renameFile`; refuses if the target exists.
`D` → `project.removeFile`, then `fs.unlink`.
Core stays pure.

## Editor

`config.editor`, falling back to `notepad` on win32 and `vim` elsewhere. Ink is
unmounted, the editor spawned with inherited stdio, and Ink re-rendered on exit.

## Done when

The corpus's largest solution opens, expands, searches, and renders correctly, and
file/filter/reference edits round-trip through the core.

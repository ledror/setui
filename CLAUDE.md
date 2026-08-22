# setui — working rules

Read `ARCHITECTURE.md` first. It holds the *why* for everything below, and every
rule here exists because of a decision recorded there.

`setui` is a terminal Solution Explorer for Visual Studio C++ solutions. It edits
`.vcxproj` and `.vcxproj.filters` files and invokes msbuild. **It runs on Windows in
production**, but it was written on macOS, where msbuild does not exist. Assume the
next thing you break is cross-platform.

## Where things live

```
src/core/            pure library, no Ink, no React, no spawning
  text.ts            splice engine, EOL and indent detection
  xml.ts             XML CST for .vcxproj and .vcxproj.filters
  sln.ts             line-oriented .sln CST, virtualPath(), default config/platform
  project.ts         the Project facade: files, filters, references, save()
  itemTypes.ts       extension -> MSBuild item element, None fallback
  build.ts           the msbuild argv, and commandLine() for display
src/tui/             the Ink app; owns every disk side effect and every spawn
  app.tsx            the whole UI: tree, overlays, keymap, build pane
  tree.ts            buildRows(): the flat row list the renderer windows into
  build.ts           spawns msbuild; wrapLines() for the output views
  config.ts          ~/.setui.json
  discover.ts        finding .sln files
  textInput.ts       pure line-editing reducer used by the prompts
  icons.ts           generated nerd-font table; edit by hand, do not regenerate
  devtools-stub.ts   bundle-only stand-in for Ink's optional devtools import
src/cli.tsx          entry point, --help and --version
build.mjs            esbuild bundle -> dist/setui.js
```

## Non-negotiable

1. **Never normalize bytes.** No trimming, no re-indenting, no EOL conversion, no
   GUID re-casing, no attribute-quote rewriting. If a change is semantically a no-op,
   the file must be byte-identical.
2. **All mutations are splices** (`{start, end, text}` applied to the original
   source). Never re-serialize a whole file from a tree.
3. **`src/core/` imports nothing from `src/tui/`.** The core does no process
   spawning and no filesystem writes other than the two project files it owns.
4. **The core never touches the filesystem for side effects.** No mkdir, no create,
   no delete, no rename of source files. The TUI composes those with core verbs —
   that split is why `addFile` and `renameFile` are pure text edits.
5. **`.sln` files are never written.**
6. **Paths in `.vcxproj`/`.filters` are written with backslashes.** Comparison
   normalizes separator *and* case, because Windows filenames are case-insensitive.
7. **Every removal is confirmed**, including ones that only edit the project file.
8. **Tests never modify anything under `sample-projects/`.** See below.

## TDD

Tests first, always. Then make them fail for the right reason before you make them
pass — several bugs in this codebase were found by a test that failed differently
than expected, and at least one "fix" was only proven by reverting it and watching
the new test go red. Do that when a test guards something subtle.

Every mutation verb gets an inverse test: apply, un-apply, assert byte-identical.

### The corpus is the safety net

`sample-projects/Windows-driver-samples` is a git submodule holding 136 real
solutions and 265 real projects. `tests/corpus-*.test.ts` parse every one of them,
round-trip them byte-for-byte, and apply-then-undo every edit in memory.

**The corpus is strictly read-only.** Read, parse, compare in memory; never call
`save()` on it. A test run must leave `git status` clean, and running the suite
twice must give identical results. If you add a corpus test, assert something that
proves it is not vacuous (a count of the thing you are checking), because a filter
that silently matches nothing looks exactly like a passing test — that mistake hid
239 of the 253 projects that have filters from the mutation tests for
several commits.

### Testing the TUI

`tests/app.test.tsx` drives the real Ink app through `ink-testing-library`. Three
things it must keep doing:

- **Always pass `configPath`.** `App` takes it so tests never read or create the
  developer's real `~/.setui.json`.
- **Let each keystroke land.** Use the `press()` helper; two keys written in one
  tick are handled against stale state.
- **Fake msbuild with a shell script.** `fakeMsbuild()` writes a script that records
  its own argv, prints output, and optionally lingers so it can be killed. Assert
  build arguments from *that recorded argv*, not from `buildArgs()`'s return value —
  that is what caught the `:Build` suffix and the cancel-hangs bug. These tests are
  skipped on win32.

## Commands

```
npm test          unit + corpus tests, and a bundle build and smoke test
npm run typecheck tsc --noEmit
npm run bundle    dist/setui.js, the single distributable file
npm start         run from source (tsx)
```

There is no separate `build` script: `bundle` is the build, `typecheck` is the
compile check.

## Conventions

- TypeScript, ESM, Node 20+, vitest.
- Keep the file count low. Prefer adding to an existing module over a new one.
- No dependency for what a few lines of stdlib does.
- Comments explain *why*, not what. The interesting ones here record a real-world
  fact that forced the code's shape — keep writing those.
- Mark deliberate shortcuts with a `ponytail:` comment naming the ceiling and the
  upgrade path. `grep -rn 'ponytail:' src` is the current debt list.

## Plans

There is no `plans/` directory right now, and that is correct: the convention is
one file per phase written *before* the code, and **deleted when the phase lands**,
not annotated. Recreate it for the next multi-step piece of work; do not add
per-feature checkbox bookkeeping.

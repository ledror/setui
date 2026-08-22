# setui — phase plan

Phases are ordered by dependency. Each phase file is deleted when the phase is done.
Done criteria are objective: the tests named in the phase file pass and the corpus
round-trip suite is still green.

1. ~~XML CST + splice engine~~ — **done**. `src/core/{text,xml}.ts`.
2. ~~SLN CST + `virtualPath()`~~ — **done**. `src/core/sln.ts`.
3. ~~The `Project` facade~~ — **done**. `src/core/{project,itemTypes}.ts`.
4. `04-tui-shell.md` — Ink app: discovery, tree, search, windowing, keymap, editor.
5. `05-build.md`     — Config file, msbuild invocation, output pane.

Corpus findings worth keeping (they cost a test run to discover):

- Most Visual Studio-written `.sln` files begin with a **blank line before the
  header**. The header is "the first non-empty line", not line 1.
- All 136 `.sln`, 265 `.vcxproj` and every `.vcxproj.filters` in the sample submodule
  parse and round-trip byte-identically as of phase 2.
- Item element names cannot be whitelisted: the corpus alone uses 21 of them
  (`FilesToPackage`, `OtherWpp`, `Wmimofck`, `MASM`, `Ctrpp`...). Any `ItemGroup`
  child with an `Include` is a file; non-file items are blacklisted instead.
- Moving a file out of a filter deletes its `.filters` entry entirely (what Visual
  Studio writes), so moving it back re-appends rather than restoring its old
  position. Order carries no meaning; the guarantee there is semantic, and
  byte-stable from the second round trip on.

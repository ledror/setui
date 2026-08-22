# setui — working rules

Read `ARCHITECTURE.md` first. It holds the *why* for everything below.

## Non-negotiable

1. **Never normalize bytes.** No trimming, no re-indenting, no EOL conversion, no
   GUID re-casing, no attribute-quote rewriting. If a change is semantically a no-op,
   the file must be byte-identical.
2. **All mutations are splices** (`{start, end, text}` applied to the original
   source). Never re-serialize a whole file from a tree.
3. **`src/core/` imports nothing from `src/tui/`.** The core does no process
   spawning and no filesystem writes other than the project files it owns.
4. **The core never touches the filesystem for side effects.** No mkdir, no create,
   no delete, no rename of source files. The TUI composes those with core verbs.
5. **`.sln` files are never written.**
6. **Paths in `.vcxproj`/`.filters` are written with backslashes.** Comparison
   normalizes separator and case.
7. **Tests must not modify anything under `sample-projects/`.** The corpus is
   read-only: read, parse, compare in memory. A test run must leave `git status`
   clean. Running the suite twice must give identical results.

## TDD

Tests first, always. The two corpus round-trip tests (every `.vcxproj`/`.filters`
through the XML CST; every `.sln` through the SLN CST) are the primary safety net and
run on every commit. Every mutation verb gets an inverse test: apply and un-apply,
assert byte-identical.

## Conventions

- TypeScript, ESM, Node 20+, vitest.
- Keep the file count low. Prefer adding to an existing module over a new one.
- No dependency for what a few lines of stdlib does.
- Mark deliberate shortcuts with a `ponytail:` comment naming the ceiling.

## Plans

`plans/` holds one file per phase, written before the code. A finished plan file is
**deleted**, not annotated. No per-feature checkbox bookkeeping.

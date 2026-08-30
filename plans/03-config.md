# Phase 03 — configuration

Read `plans/00-design.md` first. Small phase; do it before 04 so the TUI has a
key to read.

## Why two MSBuilds

`-getTargetResult` needs MSBuild ≥ 17.8. The MSBuild that *builds* the user's
solution is frequently older — VS 2019 is still the common case for the driver
work this tool is used on, and it can never do extraction. The two are genuinely
independent choices and must be configurable independently.

## The shape

`src/tui/config.ts` today:

```ts
export interface Config {
  msbuild: string
  editor: string
  logLines: number
  msbuildArgs: string[]
}
```

Becomes:

```ts
export interface Config {
  msbuild: { build: string; compileCommands: string }
  editor: string
  logLines: number
  msbuildArgs: string[]
}
```

In `~/.setui.json`:

```json
{
  "msbuild": {
    "build": "C:\\...\\2019\\...\\MSBuild.exe",
    "compileCommands": "C:\\...\\18\\BuildTools\\MSBuild\\Current\\Bin\\MSBuild.exe"
  }
}
```

## Back-compat

Accept both shapes. A bare string keeps meaning the build MSBuild:

```
"msbuild": "C:\\path\\MSBuild.exe"   ->  { build: "C:\\path\\MSBuild.exe", compileCommands: "" }
```

This is four lines in `loadConfig` and it is exactly the call that module already
makes for `msbuildArgs`, which accepts a string *or* an array with a comment
explaining why. Follow that precedent, including writing the comment.

Do **not** rewrite the user's file to migrate it. `loadConfig` deliberately
refuses to do that elsewhere — "the file is the user's, and we would be
overwriting a typo in a path they just typed." The same reasoning holds here.

`blank()` gains `msbuild: { build: '', compileCommands: '' }`.

## Resolution rule

When `compileCommands` is empty, fall back to `build`, then apply the version
gate from phase 02. That way a machine with one modern VS needs no new
configuration at all, and the decoupling is there the moment the version gate
trips.

There is no `compileCommandsMsbuildArgs`. `msbuildArgs` is *not* forwarded to
extraction either: those are the user's build arguments and a design-time build
is not a build. Add a separate key only when something actually needs it.

## Tests — extend `tests/config.test.ts`

- object form parses;
- **string form still parses** into `{ build, compileCommands: '' }`;
- missing `msbuild` yields both empty, and the file is created on first run as it
  is today;
- a malformed `msbuild` (a number, an array) degrades to empty rather than
  throwing — invalid JSON still throws, that behaviour is deliberate and stays.

Every test passes `configPath`. Never read the developer's real `~/.setui.json`.

## Also update

- `README.md` — the config example.
- `ARCHITECTURE.md` — wherever the config shape is described.

## Done when

`npm test` and `npm run typecheck` pass on both platforms, and an existing
`~/.setui.json` with a string `msbuild` still builds solutions exactly as before.

# Phase 5 — Config and build

## Deliverables

- `src/tui/config.ts`, `src/tui/build.ts`, build pane in `app.tsx`

## Config

`~/.setui.json`:

```json
{
  "msbuild": "C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\MSBuild\\Current\\Bin\\MSBuild.exe",
  "editor": "code -w"
}
```

Read on startup. Missing → create it with empty values and show a first-run screen
explaining what to fill in, with a key to open it in the editor. **No `vswhere`, ever.**
Invalid JSON is reported, not silently defaulted.

## Invocation

```
<msbuild> <sln> /t:<VirtualPath>:<Build|Rebuild|Clean> /p:Configuration=<c> /p:Platform=<p> /m /nologo
```

`VirtualPath` comes from `Solution.virtualPath(guid)`: backslash-separated, `.`
escaped to `_`, no file extension. Spawned with an argv **array** (never a shell
string) so spaces and `|` cannot break out.

## Output pane

- Bottom pane, ~15 lines, streaming stdout+stderr as it arrives.
- `Esc` kills the child process tree.
- One build at a time; further build keys are ignored while running.
- Exit code drives a one-line green/red status.
- `o` toggles a fullscreen log view, scrollable with arrows / PgUp / PgDn / u / d and
  the mouse wheel.
- No output parsing, no error list. The full log is kept in memory for the session.

## Testing

msbuild does not exist on the dev machine. Tested by asserting the exact argv array
produced for a given solution/project/config/platform/target, including virtual paths
from nested solution folders and names containing `.`. The spawn itself is a thin
wrapper that is not unit tested.

## Done when

The argv tests pass and the pane behaves correctly against a fake long-running
process.

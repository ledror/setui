import { resolve } from 'node:path'
import { render } from 'ink'
import React from 'react'
import { App } from './tui/app.js'

// Injected by build.mjs; undefined when running from source through tsx.
declare const __SETUI_VERSION__: string | undefined
const version = typeof __SETUI_VERSION__ === 'string' ? __SETUI_VERSION__ : 'dev'

const USAGE = `setui ${version} - the Visual Studio Solution Explorer, in your terminal

  setui                 search for solutions under the current directory
  setui <directory>     search under a directory
  setui <file.sln>      open a solution directly

  --help, -h            this message
  --version, -v         print the version

Configuration lives in ~/.setui.json (msbuild path, editor, logLines).
Press ? inside setui for the keys.`

const arg = process.argv[2]
if (arg === '--help' || arg === '-h') {
  console.log(USAGE)
} else if (arg === '--version' || arg === '-v') {
  console.log(version)
} else {
  render(<App start={resolve(arg ?? process.cwd())} />, {
    // Own the whole terminal from the first frame: no growing-into-place jump when a
    // solution opens, and the user's scrollback comes back untouched on exit.
    alternateScreen: true,
    // Ink's default is 30fps with a full redraw per frame; typing and scrolling both
    // felt behind at that. Incremental rendering only rewrites the lines that changed.
    maxFps: 60,
    incrementalRendering: true,
  })
}

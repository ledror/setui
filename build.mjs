import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

const { version } = JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8'))

/**
 * Bundles setui into one file that runs with a bare `node dist/setui.js`, with no
 * node_modules beside it.
 *
 * Two wrinkles, both handled by the banner and the alias:
 *
 * - The output is ESM, but some dependencies are CommonJS and `require()` Node
 *   builtins at load time. `createRequire` gives them a working `require`.
 * - The shebang has to be the first line, so it lives in the banner rather than in
 *   `src/cli.tsx` (esbuild puts the banner above everything, including a shebang it
 *   found in the entry point, which would leave two of them).
 */
await build({
  entryPoints: ['src/cli.tsx'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/setui.js',
  legalComments: 'none',
  minify: true,
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __setuiCreateRequire } from 'node:module';",
      'const require = __setuiCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  define: {
    // Read from package.json at build time: a single-file bundle has no
    // package.json beside it to read at runtime.
    __SETUI_VERSION__: JSON.stringify(version),
  },
  alias: {
    // Ink imports this unconditionally but only uses it when DEV=true, and the
    // package is optional and normally absent.
    'react-devtools-core': './src/tui/devtools-stub.ts',
  },
  logLevel: 'warning',
})

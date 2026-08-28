import { spawn, type ChildProcess } from 'node:child_process'
import { buildArgs, type BuildRequest } from '../core/build.js'

/** How long output accumulates before it reaches the UI. 10 repaints a second. */
const FLUSH_MS = 100

export interface RunningBuild {
  child: ChildProcess
  kill(): void
}

/**
 * Spawns msbuild with an argument array — never a shell string, so a path with
 * spaces or a `|` in a platform name cannot be reinterpreted. Output is streamed
 * raw; setui does not parse it, the editor is where errors get read.
 */
export function startBuild(
  msbuild: string,
  request: BuildRequest,
  onOutput: (chunk: string) => void,
  onExit: (code: number | null) => void,
): RunningBuild {
  const child = spawn(msbuild, buildArgs(request), { windowsHide: true })

  // One repaint per chunk meant a loud build drove the UI at the full frame rate,
  // and a TTY write blocks the event loop when the terminal is behind (a
  // multiplexer, an ssh hop), so keystrokes queued up behind the output - pressing
  // `o` took seconds to land. Output is coalesced into one update per FLUSH_MS
  // instead: nothing is dropped, it just arrives in fewer, bigger pieces.
  let pending = ''
  let timer: NodeJS.Timeout | undefined
  const flush = () => {
    timer = undefined
    if (pending === '') return
    const text = pending
    pending = ''
    onOutput(text)
  }
  const push = (text: string) => {
    pending += text
    // unref: a pending flush must never hold the process open on its own.
    timer ??= setTimeout(flush, FLUSH_MS).unref()
  }

  child.stdout?.on('data', (b: Buffer) => push(b.toString()))
  child.stderr?.on('data', (b: Buffer) => push(b.toString()))
  child.on('error', (e) => {
    push(`${e.message}\n`)
    flush()
    onExit(null)
  })
  // 'exit', not 'close': a killed msbuild /m can leave workers holding the output
  // pipe open, and waiting for the streams to end would strand the UI mid-build.
  child.on('exit', (code) => {
    // The tail of the output has to land before the exit status does.
    if (timer) clearTimeout(timer)
    flush()
    onExit(code)
  })
  return {
    child,
    kill: () => {
      // /T on Windows: msbuild /m leaves worker processes behind otherwise.
      if (process.platform === 'win32' && child.pid !== undefined) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      } else {
        child.kill('SIGTERM')
      }
    },
  }
}

/**
 * Wraps build output into terminal-width rows.
 *
 * The log views window by row index, so wrapping has to happen here rather than
 * being left to Ink: a line that occupies three rows on screen has to count as
 * three, or scrolling and the pane's fixed height both go wrong. Truncating
 * instead — which is what it used to do — simply hid the end of long lines, and
 * msbuild lines are mostly long paths.
 *
 * ponytail: still re-wraps the whole log whenever it grows, but only for the
 * full-screen view, and only ten times a second - the pane wraps just the tail it
 * shows. Make it incremental if someone watches the full log of a build with
 * hundreds of thousands of lines.
 */
export function wrapLines(lines: string[], width: number): string[] {
  const limit = Math.max(1, Math.floor(width))
  const out: string[] = []
  for (const line of lines) {
    if (line.length <= limit) {
      out.push(line)
      continue
    }
    let rest = line
    while (rest.length > limit) {
      // Prefer a break at whitespace, but never lose characters to an over-long
      // word (a path with no spaces is the common case).
      const window = rest.slice(0, limit + 1)
      const at = window.lastIndexOf(' ')
      const cut = at > 0 ? at : limit
      out.push(rest.slice(0, cut).trimEnd())
      rest = rest.slice(at > 0 ? cut + 1 : cut)
    }
    if (rest) out.push(rest)
  }
  return out
}

import { spawn, type ChildProcess } from 'node:child_process'
import { buildArgs, type BuildRequest } from '../core/build.js'

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
  child.stdout?.on('data', (b: Buffer) => onOutput(b.toString()))
  child.stderr?.on('data', (b: Buffer) => onOutput(b.toString()))
  child.on('error', (e) => {
    onOutput(`${e.message}\n`)
    onExit(null)
  })
  child.on('close', onExit)
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

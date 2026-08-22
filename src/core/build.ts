export type BuildTarget = 'Build' | 'Rebuild' | 'Clean'

export interface BuildRequest {
  solutionPath: string
  /** The project's path inside the solution, from `SlnDocument.virtualPath`. */
  virtualPath: string
  target: BuildTarget
  configuration: string
  platform: string
}

/**
 * The msbuild argument vector. Passed to spawn as an array, never joined into a
 * shell string, so spaces and the `|` in a platform name cannot break out.
 */
export function buildArgs(request: BuildRequest): string[] {
  const { solutionPath, virtualPath, target, configuration, platform } = request
  if (!virtualPath) throw new Error('a build needs the project\'s virtual path inside the solution')
  if (virtualPath.includes('/')) throw new Error(`virtual path must use backslashes: ${virtualPath}`)
  return [
    solutionPath,
    `/t:${virtualPath}:${target}`,
    `/p:Configuration=${configuration}`,
    `/p:Platform=${platform}`,
    '/m',
    '/nologo',
  ]
}

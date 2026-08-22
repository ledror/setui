export type BuildTarget = 'Build' | 'Rebuild' | 'Clean'

export interface BuildRequest {
  solutionPath: string
  /** The project's path inside the solution, from `SlnDocument.virtualPath`. */
  virtualPath: string
  target: BuildTarget
  configuration: string
  platform: string
  /**
   * Verbatim arguments from the user's config, appended last so msbuild's
   * last-one-wins resolves them over our defaults. Never inspected or validated:
   * being a dumb passthrough is the whole point.
   */
  extraArgs?: string[]
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
    // Build is the default target: msbuild rejects the explicit `Project:Build`
    // form, while `Project:Rebuild` and `Project:Clean` are required.
    target === 'Build' ? `/t:${virtualPath}` : `/t:${virtualPath}:${target}`,
    `/p:Configuration=${configuration}`,
    `/p:Platform=${platform}`,
    '/m',
    '/nologo',
    ...(request.extraArgs ?? []),
  ]
}

/**
 * The invocation, rendered for the build log so the user can see exactly what ran
 * and paste it into a terminal. Display only — the real spawn passes an argv array
 * and never goes near a shell, so nothing here can affect what is executed.
 */
export function commandLine(msbuild: string, args: string[]): string {
  return [msbuild, ...args].map(quote).join(' ')
}

const quote = (arg: string) =>
  /[\s"]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg

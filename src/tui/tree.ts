import type { Project } from '../core/project.js'
import type { SlnDocument, SlnProject } from '../core/sln.js'

/**
 * The tree is derived, never stored: given the solution, whichever projects have
 * been loaded so far, and the set of expanded node ids, `buildRows` produces the
 * flat list the renderer draws a window into. Ink redraws every frame, so a flat
 * array plus a slice is what keeps a 100-project solution responsive.
 */

export type Row =
  | { kind: 'folder'; id: string; depth: number; label: string; guid: string }
  | { kind: 'project'; id: string; depth: number; label: string; guid: string; loaded: boolean }
  | { kind: 'references'; id: string; depth: number; label: string; guid: string }
  | { kind: 'reference'; id: string; depth: number; label: string; guid: string; include: string }
  | { kind: 'filter'; id: string; depth: number; label: string; guid: string; path: string }
  | { kind: 'file'; id: string; depth: number; label: string; guid: string; path: string; itemType: string }

/** Rows that can be opened. Files and references are leaves. */
export const isExpandable = (row: Row) =>
  row.kind === 'folder' || row.kind === 'project' || row.kind === 'filter' || row.kind === 'references'

export interface TreeInput {
  solution: SlnDocument
  projects: Map<string, Project>
  expanded: Set<string>
  /** Case-insensitive substring; empty means no filtering. */
  query?: string
}

export const projectId = (guid: string) => `project:${guid}`
export const referencesId = (guid: string) => `refs:${guid}`
export const filterId = (guid: string, path: string) => `filter:${guid}:${path}`

export function buildRows(input: TreeInput): Row[] {
  const query = (input.query ?? '').toLowerCase()
  const rows = collect(input, query)
  return query ? prune(rows, query) : rows
}

function collect(input: TreeInput, query: string): Row[] {
  const { solution, projects, expanded } = input
  // A search reaches into everything already loaded, so it ignores expansion state.
  const isOpen = (id: string) => query !== '' || expanded.has(id)
  const rows: Row[] = []

  const childrenOf = (parentGuid: string | null) =>
    solution.projects
      .filter((p) => (solution.nested.get(p.guid) ?? null) === parentGuid)
      .sort(byFolderThenName)

  const walkSolution = (parentGuid: string | null, depth: number) => {
    for (const entry of childrenOf(parentGuid)) {
      if (entry.isFolder) {
        rows.push({ kind: 'folder', id: `folder:${entry.guid}`, depth, label: entry.name, guid: entry.guid })
        if (isOpen(`folder:${entry.guid}`)) walkSolution(entry.guid, depth + 1)
      } else {
        const project = projects.get(entry.guid)
        rows.push({
          kind: 'project',
          id: projectId(entry.guid),
          depth,
          label: entry.name,
          guid: entry.guid,
          loaded: project !== undefined,
        })
        if (project && isOpen(projectId(entry.guid))) walkProject(entry, project, depth + 1)
      }
    }
  }

  const walkProject = (entry: SlnProject, project: Project, depth: number) => {
    const refsId = referencesId(entry.guid)
    rows.push({ kind: 'references', id: refsId, depth, label: 'References', guid: entry.guid })
    if (isOpen(refsId)) {
      for (const reference of project.references) {
        rows.push({
          kind: 'reference',
          id: `ref:${entry.guid}:${reference.include}`,
          depth: depth + 1,
          label: leaf(reference.include),
          guid: entry.guid,
          include: reference.include,
        })
      }
    }

    const filters = project.filters.map((f) => f.path)
    const walkFilters = (parent: string | null, at: number) => {
      for (const path of childFilters(filters, parent)) {
        const id = filterId(entry.guid, path)
        rows.push({ kind: 'filter', id, depth: at, label: leaf(path), guid: entry.guid, path })
        if (isOpen(id)) {
          walkFilters(path, at + 1)
          pushFiles(entry.guid, project, path, at + 1)
        }
      }
    }
    walkFilters(null, depth)
    // Files in no filter at all sit at the bottom, as a plain listing.
    pushFiles(entry.guid, project, null, depth)
  }

  const pushFiles = (guid: string, project: Project, filter: string | null, depth: number) => {
    const files = project.files
      .filter((f) => (f.filter ?? null) === filter)
      .sort((a, b) => leaf(a.path).localeCompare(leaf(b.path)))
    for (const file of files) {
      rows.push({
        kind: 'file',
        id: `file:${guid}:${file.path}`,
        depth,
        label: leaf(file.path),
        guid,
        path: file.path,
        itemType: file.itemType,
      })
    }
  }

  walkSolution(null, 0)
  return rows
}

/** Keeps matching rows plus the ancestors that give them context. */
function prune(rows: Row[], query: string): Row[] {
  const keep = new Set<number>()
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i]!.label.toLowerCase().includes(query)) continue
    keep.add(i)
    let depth = rows[i]!.depth
    for (let j = i - 1; j >= 0 && depth > 0; j--) {
      if (rows[j]!.depth < depth) {
        keep.add(j)
        depth = rows[j]!.depth
      }
    }
  }
  return rows.filter((_, i) => keep.has(i))
}

const childFilters = (all: string[], parent: string | null) =>
  all
    .filter((path) => {
      const cut = path.lastIndexOf('\\')
      return (cut < 0 ? null : path.slice(0, cut)) === parent
    })
    .sort((a, b) => a.localeCompare(b))

const leaf = (path: string) => path.split('\\').pop() ?? path

const byFolderThenName = (a: SlnProject, b: SlnProject) =>
  Number(b.isFolder) - Number(a.isFolder) || a.name.localeCompare(b.name)

/** The visible slice, keeping the cursor inside it. */
export function windowOf(total: number, height: number, cursor: number, scrollTop: number): number {
  if (total <= height) return 0
  const top = Math.min(Math.max(scrollTop, cursor - height + 1), cursor)
  return Math.max(0, Math.min(top, total - height))
}

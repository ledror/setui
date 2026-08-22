# Phase 3 — The Project facade

## Deliverables

- `src/core/itemTypes.ts` — exhaustive extension → MSBuild item element map.
- `src/core/project.ts`   — the facade.
- `tests/project.test.ts`, `tests/corpus-project.test.ts`

## Item types

A complete extension table mirroring Visual Studio's defaults, e.g.

- `ClCompile`: cpp, c, cc, cxx, c++, cp, cs? (no), def, odl, asm, asmx, …
- `ClInclude`: h, hpp, hxx, hm, inl, inc, ipp, xsd, …
- `ResourceCompile`: rc, rc2
- `Midl`: idl, odl
- `Inf`: inf, inx
- `Image`: ico, cur, bmp, png, gif, jpg, jpeg
- `Text`: txt
- `Xml`: xml
- `None`: **everything else — the fallback.**

Unknown/obscure extensions (`.bin`, anything) resolve to `None`. The table is data;
being long is fine. `<Extensions>` lists inside `.filters` are preserved but never
consulted.

## API

```ts
openProject(vcxprojPath): Promise<Project>

interface Project {
  name: string
  guid: string
  files: ProjectFile[]                    // { path, itemType, filter?: string }
  filters: ProjectFilter[]                // { path, guid, extensions? } ; nested via 'A\B'
  references: ProjectReference[]          // { include, guid? }
  hasFilters: boolean

  addFile(path: string, filter?: string): void
  removeFile(path: string): void
  renameFile(oldPath: string, newPath: string): void
  moveToFilter(path: string, filter: string | null): void   // null = no-filter bucket
  addFilter(path: string): void
  removeFilter(path: string, opts?: { reparentTo?: string | null }): void
  renameFilter(path: string, newName: string): void
  addReference(otherVcxprojPath: string): Promise<void>
  removeReference(include: string): void

  dirty: boolean
  save(): Promise<void>
}
```

## Semantics

- **Insertion point**: append to the last existing `ItemGroup` containing that item
  type; if none exists, insert a new `ItemGroup` after the last `ItemGroup` in the
  file. Indentation and EOL copied from neighbours.
- **`addFile`** writes the item to `.vcxproj` and, if a filter is given and the
  project has a `.filters` file, the corresponding entry with a `<Filter>` child.
- **`moveToFilter(path, null)`** deletes the `<Filter>` child element, leaving the
  item; it does not write an empty `<Filter></Filter>`.
- **Filter operations require `hasFilters`**; otherwise throw. We never synthesize a
  `.filters` file.
- **New filter GUIDs** come from a generator injected into `openProject`, defaulting
  to `crypto.randomUUID()` uppercased and braced. Tests inject a counter.
- **`renameFilter`** rewrites the filter's own `Include` and, for every descendant
  filter and every item whose `<Filter>` matches, the leading path segment. Matching
  is on **segment boundaries only** — `Source Files` must not match
  `Source Files Old`.
- **`removeFilter`** with `reparentTo` moves descendants; without it, throws if the
  filter is non-empty (the TUI confirms and passes `reparentTo: null`).
- **`addReference`** parses the target `.vcxproj` to read its `ProjectGuid`, and
  writes `<ProjectReference Include="rel\path">` + `<Project>{guid}</Project>`. The
  relative path is computed with `path.relative` then separator-converted to `\`.
  Existing references' GUID casing is never touched.
- **`save()`** re-stats both files against the mtime+size recorded at open and throws
  `StaleFileError` on mismatch. Writes temp file + rename, same directory. Only
  changed files are written.

## Tests

Unit, on small fixtures — every verb, plus:
- Add then remove → byte-identical to original.
- Remove then add (same filter, same position rules) → byte-identical.
- Rename then rename back → byte-identical for files, filters, nested filters.
- Move to filter and back → byte-identical.
- `renameFilter` on a prefix-colliding sibling name.
- Filter ops on a project with no `.filters` throw.
- Paths given with `/` are written with `\`.
- Case-insensitive duplicate detection on add.

Corpus (read-only): for every project in the corpus that has a `.filters` file, open
it, add a file to each existing filter, remove it, and assert the produced strings
equal the originals — all in memory, nothing written to disk.

## Done when

All tests pass and `git status` on the submodule is clean.

/** A byte-range replacement against an original source string. */
export interface Splice {
  start: number
  end: number
  text: string
}

/**
 * Applies splices to `source`, right to left, so earlier offsets stay valid.
 * Splices may be given in any order; they may touch but never overlap.
 * An empty list returns the original string untouched.
 */
export function applySplices(source: string, splices: Splice[]): string {
  if (splices.length === 0) return source

  const ordered = splices
    .map((s, i) => ({ ...s, i }))
    .sort((a, b) => a.start - b.start || a.i - b.i)

  for (let n = 0; n < ordered.length; n++) {
    const s = ordered[n]!
    if (s.start < 0 || s.end > source.length || s.start > s.end) {
      throw new Error(`splice out of range: [${s.start}, ${s.end}) in a ${source.length} char source`)
    }
    const prev = ordered[n - 1]
    if (prev && s.start < prev.end) {
      throw new Error(`splices overlap: [${prev.start}, ${prev.end}) and [${s.start}, ${s.end})`)
    }
  }

  let out = source
  for (let n = ordered.length - 1; n >= 0; n--) {
    const s = ordered[n]!
    out = out.slice(0, s.start) + s.text + out.slice(s.end)
  }
  return out
}

/** The line ending this file uses, taken from its first newline. */
export function detectEol(source: string): '\r\n' | '\n' {
  const i = source.indexOf('\n')
  if (i < 0) return '\n'
  return source[i - 1] === '\r' ? '\r\n' : '\n'
}

/** The whitespace prefix of the line containing `offset`. */
export function lineIndent(source: string, offset: number): string {
  const lineStart = source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1
  let i = lineStart
  while (i < source.length && (source[i] === ' ' || source[i] === '\t')) i++
  return source.slice(lineStart, i)
}

/** 1-based line/column for an offset, for error reporting. */
export function lineColumn(source: string, offset: number): { line: number; column: number } {
  let line = 1
  let lineStart = 0
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') {
      line++
      lineStart = i + 1
    }
  }
  return { line, column: offset - lineStart + 1 }
}

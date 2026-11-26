/**
 * Find syntax tokens that should not be divided between provider requests.
 * Tokens larger than the request limit are deliberately left splittable.
 * @param text - complete source text.
 * @returns sorted, non-overlapping source ranges.
 */
function protectedTextRanges(text) {
  const patterns = [
    /(`+)[^\n]*?\1/g, // inline code spans, including multi-backtick delimiters
    /^ {0,3}(?:`{3,}|~{3,})[^\n]*(?:\n|$)/gm, // Markdown fence marker lines
    /\{\{[\s\S]*?\}\}/g, // common template placeholders
    /\$\{[^}\n]*\}/g, // interpolation placeholders
    /<\/?[A-Za-z][^>\n]*>/g, // HTML/XML tags
    /\[[^\]\n]*\]\([^)]+\)/g, // Markdown links
    /https?:\/\/[^\s<>()]+/g, // URLs
  ]
  const ranges = []
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      ranges.push({ start: match.index, end: match.index + match[0].length })
    }
  }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end)
  const merged = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

/**
 * Move a proposed fragment boundary out of a protected syntax token when the
 * complete token fits in one provider request.
 * @param ranges - protected source ranges, in UTF-16 offsets.
 * @param offset - current fragment's source offset.
 * @param boundary - proposed local boundary.
 * @param maxChars - maximum fragment size.
 * @returns a local boundary that does not bisect a protected token.
 */
function protectBoundary(ranges, offset, boundary, maxChars) {
  const absolute = offset + boundary
  const range = ranges.find((item) =>
    item.start < absolute && item.end > absolute && item.end - item.start <= maxChars,
  )
  if (range === undefined) return boundary
  if (range.start > offset) return range.start - offset
  if (range.end - offset <= maxChars) return range.end - offset
  return boundary
}

/**
 * Split text into request-sized pieces on paragraph, then line, then sentence,
 * then word boundaries. Complete inline syntax tokens (code spans, template
 * placeholders, HTML tags, Markdown links and URLs) are kept in one fragment
 * whenever the token itself fits the provider limit.
 *
 * The separator always stays with the fragment it closes, so concatenating
 * the fragments reproduces the source exactly.
 * @param text - source text.
 * @param maxChars - per-fragment limit in UTF-16 code units.
 * @returns the fragments in source order.
 */
/**
 * Validate JSON and locate only string-value tokens, never object keys.
 *
 * Source offsets let us replace values without reserializing the document:
 * whitespace, key spelling, numeric notation, booleans, null and nesting
 * remain unchanged.
 * @param source - the JSON source text.
 * @returns string-value tokens in source order.
 */
export function jsonStringValueTokens(source) {
  JSON.parse(source)
  const tokens = []
  let index = 0
  while (index < source.length) {
    if (source[index] !== '"') {
      index += 1
      continue
    }
    const start = index
    index += 1
    while (index < source.length) {
      const character = source[index]
      if (character === '\\') {
        index += 2
        continue
      }
      index += 1
      if (character === '"') break
    }
    const end = index
    let next = end
    while (next < source.length && /[\t\n\r ]/u.test(source[next])) next += 1
    if (source[next] !== ':') {
      const value = JSON.parse(source.slice(start, end))
      tokens.push({ start, end, value })
    }
  }
  return tokens
}

/**
 * Split Markdown into translatable prose and exact syntax spans.
 *
 * This is intentionally a conservative lexer, not a full CommonMark parser.
 * It protects structural tokens that are unsafe to rewrite (fenced/inline
 * code, link destinations, URLs, HTML tags, entities, template placeholders,
 * emphasis markers and common block prefixes). Link labels and ordinary prose
 * remain translatable. Every returned segment is losslessly reversible by
 * concatenating its text fields in order.
 *
 * @param {string} source - Markdown source.
 * @returns {{text: string, translate: boolean}[]} Ordered source segments.
 */
export function markdownSegments(source) {
  const ranges = []
  const add = (start, end) => {
    if (Number.isInteger(start) && Number.isInteger(end) && end > start) {
      ranges.push({ start, end })
    }
  }
  const addMatches = (pattern) => {
    for (const match of source.matchAll(pattern)) {
      add(match.index, match.index + match[0].length)
    }
  }

  // Fence content is protected as one range, including the delimiters. An
  // unclosed fence protects through EOF rather than translating code as prose.
  let lineStart = 0
  while (lineStart < source.length) {
    const newline = source.indexOf('\n', lineStart)
    const lineEnd = newline < 0 ? source.length : newline
    const rawLine = source.slice(lineStart, lineEnd)
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    const opening = line.match(/^ {0,3}(\x60{3,}|~{3,})/)
    if (opening === null) {
      lineStart = newline < 0 ? source.length : newline + 1
      continue
    }

    const fenceChar = opening[1][0]
    const fenceLength = opening[1].length
    const fenceUnit = fenceChar === '\x60' ? '\\x60' : '~'
    const closingPattern = new RegExp('^ {0,3}' + fenceUnit + '{' + fenceLength + ',}[ \\t]* * grapheme fits. Oversized graphemes may be divided between code points, but
 * never inside a UTF-16 surrogate pair.
 * @param text - the remaining source text.
 * @param boundary - proposed UTF-16 boundary.
 * @param maxChars - provider fragment limit.
 * @returns a safe local boundary.
 */
function adjustGraphemeBoundary(text, boundary, maxChars) {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  for (const item of segmenter.segment(text)) {
    const start = item.index
    const end = start + item.segment.length
    if (start < boundary && end > boundary) {
      if (start > 0) return start
      if (end <= maxChars) return end

      // This one grapheme is larger than the whole fragment budget. Preserve
      // code points even though keeping the grapheme intact is impossible.
      let safe = 0
      while (safe < text.length) {
        const point = text.codePointAt(safe)
        const width = point > 0xffff ? 2 : 1
        if (safe + width > maxChars) break
        safe += width
        if (safe >= boundary) break
      }
      if (safe === 0) {
        throw new RangeError('splitText: maxChars is smaller than one Unicode code point')
      }
      return safe
    }
  }
  return boundary
}

export function splitText(text, maxChars) {
  if (maxChars < 1) throw new RangeError('splitText: maxChars must be positive')
  if (text.length <= maxChars) return [text]
  const fragments = []
  const ranges = protectedTextRanges(text)
  let rest = text
  let offset = 0
  // A break earlier than this would produce a run of tiny fragments; the
  // coarse separators are preferred, but only when they still fill the
  // request reasonably well.
  const minCut = Math.floor(maxChars / 2)
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars)
    let cut = -1
    let size = 0
    for (const separator of ['\n\n', '\n', '. ', ' ']) {
      const found = window.lastIndexOf(separator)
      if (found >= minCut) {
        cut = found
        size = separator.length
        break
      }
    }
    let boundary = cut < 0 ? maxChars : cut + size
    boundary = protectBoundary(ranges, offset, boundary, maxChars)
    // Keep a complete grapheme together when it fits. If a single grapheme
    // exceeds the provider limit, fall back to code-point-safe boundaries.
    boundary = adjustGraphemeBoundary(rest, boundary, maxChars)
    fragments.push(rest.slice(0, boundary))
    rest = rest.slice(boundary)
    offset += boundary
  }
  if (rest.length > 0) fragments.push(rest)
  return fragments
}

)
    let cursor = newline < 0 ? source.length : newline + 1
    let fenceEnd = source.length
    while (cursor < source.length) {
      const nextNewline = source.indexOf('\n', cursor)
      const nextEnd = nextNewline < 0 ? source.length : nextNewline
      let candidate = source.slice(cursor, nextEnd)
      if (candidate.endsWith('\r')) candidate = candidate.slice(0, -1)
      if (closingPattern.test(candidate)) {
        fenceEnd = nextNewline < 0 ? nextEnd : nextNewline + 1
        break
      }
      if (nextNewline < 0) break
      cursor = nextNewline + 1
    }
    add(lineStart, fenceEnd)
    lineStart = fenceEnd
  }

  // Inline code, interpolation tokens, template placeholders, HTML tags,
  // autolinks/URLs and HTML entities must reach the provider unchanged.
  addMatches(/(\x60+)[^\n]*?\1/g)
  addMatches(/\{\{[\s\S]*?\}\}/g)
  addMatches(/\$\{[^}\n]*\}/g)
  addMatches(/<\/?[A-Za-z][^>\n]*>/g)
  addMatches(/<https?:\/\/[^>\s]+>/gi)
  addMatches(/https?:\/\/[^\s<>()]+/gi)
  addMatches(/&(?:#\d+|#x[\da-f]+|[a-z][\w]+);/gi)

  // Keep link labels translatable while freezing brackets, destinations and
  // optional titles. Images are preserved whole because alt text is metadata.
  const links = /(!?)\[([^\]\n]*)\]\((?:<[^>\n]*>|[^)\n])*\)/g
  for (const match of source.matchAll(links)) {
    const start = match.index
    const end = start + match[0].length
    if (match[1] === '!') {
      add(start, end)
      continue
    }
    const labelStart = start + 1
    const labelEnd = labelStart + match[2].length
    add(start, labelStart)
    add(labelEnd, end)
  }

  // Protect Markdown block prefixes while leaving the following words free.
  addMatches(/^ {0,3}(?:#{1,6}[ \t]+|>[ \t]?|(?:[-+*]|\d+[.)])[ \t]+)(?:\[[ xX]\][ \t]+)?/gm)
  addMatches(/^ {0,3}(?:(?:\*|_|-)[ \t]*){3,}[ \t]*$/gm)
  // Emphasis/strike delimiters are protected separately from their contents.
  addMatches(/\*\*|__|~~|(?<!\w)\*(?=\S)|(?<=\S)\*(?!\w)|(?<!\w)_(?=\S)|(?<=\S)_(?!\w)/g)

  ranges.sort((a, b) => a.start - b.start || a.end - b.end)
  const merged = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end)
    } else {
      merged.push({ ...range })
    }
  }

  const segments = []
  const append = (text, translate) => {
    if (text.length === 0) return
    const shouldTranslate = translate && /\S/u.test(text)
    const previous = segments.at(-1)
    if (previous && previous.translate === shouldTranslate) {
      previous.text += text
    } else {
      segments.push({ text, translate: shouldTranslate })
    }
  }
  let offset = 0
  for (const range of merged) {
    append(source.slice(offset, range.start), true)
    append(source.slice(range.start, range.end), false)
    offset = range.end
  }
  append(source.slice(offset), true)
  return segments
}

/**
 * Keep fragment boundaries on grapheme boundaries whenever the complete
 * grapheme fits. Oversized graphemes may be divided between code points, but
 * never inside a UTF-16 surrogate pair.
 * @param text - the remaining source text.
 * @param boundary - proposed UTF-16 boundary.
 * @param maxChars - provider fragment limit.
 * @returns a safe local boundary.
 */
function adjustGraphemeBoundary(text, boundary, maxChars) {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  for (const item of segmenter.segment(text)) {
    const start = item.index
    const end = start + item.segment.length
    if (start < boundary && end > boundary) {
      if (start > 0) return start
      if (end <= maxChars) return end

      // This one grapheme is larger than the whole fragment budget. Preserve
      // code points even though keeping the grapheme intact is impossible.
      let safe = 0
      while (safe < text.length) {
        const point = text.codePointAt(safe)
        const width = point > 0xffff ? 2 : 1
        if (safe + width > maxChars) break
        safe += width
        if (safe >= boundary) break
      }
      if (safe === 0) {
        throw new RangeError('splitText: maxChars is smaller than one Unicode code point')
      }
      return safe
    }
  }
  return boundary
}

export function splitText(text, maxChars) {
  if (maxChars < 1) throw new RangeError('splitText: maxChars must be positive')
  if (text.length <= maxChars) return [text]
  const fragments = []
  const ranges = protectedTextRanges(text)
  let rest = text
  let offset = 0
  // A break earlier than this would produce a run of tiny fragments; the
  // coarse separators are preferred, but only when they still fill the
  // request reasonably well.
  const minCut = Math.floor(maxChars / 2)
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars)
    let cut = -1
    let size = 0
    for (const separator of ['\n\n', '\n', '. ', ' ']) {
      const found = window.lastIndexOf(separator)
      if (found >= minCut) {
        cut = found
        size = separator.length
        break
      }
    }
    let boundary = cut < 0 ? maxChars : cut + size
    boundary = protectBoundary(ranges, offset, boundary, maxChars)
    // Keep a complete grapheme together when it fits. If a single grapheme
    // exceeds the provider limit, fall back to code-point-safe boundaries.
    boundary = adjustGraphemeBoundary(rest, boundary, maxChars)
    fragments.push(rest.slice(0, boundary))
    rest = rest.slice(boundary)
    offset += boundary
  }
  if (rest.length > 0) fragments.push(rest)
  return fragments
}


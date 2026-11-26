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

// Reuse the ICU segmenter across fragment boundaries. Its iterator stops
// at the first boundary that crosses the proposed cut.
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

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
  for (const item of GRAPHEME_SEGMENTER.segment(text)) {
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

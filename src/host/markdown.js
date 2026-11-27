/**
 * Conservative Markdown lexer for structure-preserving translation.
 *
 * This is not a full CommonMark parser. It identifies common opaque syntax
 * spans and returns an ordered, lossless sequence. Link labels and ordinary
 * prose remain translatable; protected spans are copied back exactly.
 */

/**
 * Separate translatable prose from Markdown syntax and non-prose payloads.
 * @param {string} source - Markdown source text.
 * @returns {{text: string, translate: boolean}[]} Lossless ordered segments.
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

  // Fenced code blocks are protected whole, including opening and closing
  // delimiters. An unclosed fence protects to EOF rather than exposing code.
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
    const closing = new RegExp('^ {0,3}' + fenceUnit + '{' + fenceLength + ',}[ \t]*$')
    let cursor = newline < 0 ? source.length : newline + 1
    let fenceEnd = source.length
    while (cursor < source.length) {
      const nextNewline = source.indexOf('\n', cursor)
      const nextEnd = nextNewline < 0 ? source.length : nextNewline
      let candidate = source.slice(cursor, nextEnd)
      if (candidate.endsWith('\r')) candidate = candidate.slice(0, -1)
      if (closing.test(candidate)) {
        fenceEnd = nextNewline < 0 ? nextEnd : nextNewline + 1
        break
      }
      if (nextNewline < 0) break
      cursor = nextNewline + 1
    }
    add(lineStart, fenceEnd)
    lineStart = fenceEnd
  }

  // Reference-style link definitions are opaque: translating their label,
  // destination or title would disconnect every use of that reference.
  const referenceDefinitions = new Set()
  const definitionPattern = /^ {0,3}\[([^\]\n]+)\]:[ \t]*(?:<[^>\n]*>|[^ \t\n]+)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\))?)?[ \t]*$/gm
  for (const match of source.matchAll(definitionPattern)) {
    referenceDefinitions.add(match[1].trim().replace(/\s+/g, ' ').toLowerCase())
    let definitionEnd = match.index + match[0].length
    const definitionHasTitle = /[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\))[ \t]*$/.test(match[0])
    if (!definitionHasTitle) {
      let nextLineStart = definitionEnd
      if (source.startsWith('\r\n', nextLineStart)) nextLineStart += 2
      else if (source[nextLineStart] === '\n' || source[nextLineStart] === '\r') nextLineStart += 1
      else nextLineStart = -1
      if (nextLineStart >= 0) {
        const nextLineEnd = source.indexOf('\n', nextLineStart)
        const rawTitleLine = source.slice(nextLineStart, nextLineEnd < 0 ? source.length : nextLineEnd)
        const titleLine = rawTitleLine.endsWith('\r') ? rawTitleLine.slice(0, -1) : rawTitleLine
        if (/^ {0,3}(?:"[^"\n]*"|'[^'\n]*'|\([^)\\n]*\))[ \t]*$/.test(titleLine)) {
          definitionEnd = nextLineEnd < 0 ? source.length : nextLineEnd + 1
        }
      }
    }
    add(match.index, definitionEnd)
  }

  // Translate a reference link's visible label, but preserve its delimiters
  // and reference identifier. Images remain opaque like inline images.
  const referenceLinks = /(!?)\[([^\]\n]+)\](?:\[([^\]\n]*)\])?/g
  for (const match of source.matchAll(referenceLinks)) {
    const linkStart = match.index
    const linkEnd = linkStart + match[0].length
    if (source[linkEnd] === '(') continue // Inline links are handled below.
    const identifier = match[3] === undefined || match[3] === '' ? match[2] : match[3]
    const normalized = identifier.trim().replace(/\s+/g, ' ').toLowerCase()
    if (!referenceDefinitions.has(normalized)) continue
    if (match[1] === '!') {
      add(linkStart, linkEnd)
      continue
    }
    const labelStart = linkStart + 1
    const labelEnd = labelStart + match[2].length
    add(linkStart, labelStart)
    add(labelEnd, linkEnd)
  }

  // Inline code, template tokens, HTML, autolinks, bare URLs and entities.
  addMatches(/(\x60+)[^\n]*?\1/g)
  addMatches(/\{\{[\s\S]*?\}\}/g)
  addMatches(/\$\{[^}\n]*\}/g)
  addMatches(/<\/?[A-Za-z][^>\n]*>/g)
  addMatches(/<https?:\/\/[^>\s]+>/gi)
  addMatches(/https?:\/\/[^\s<>()]+/gi)
  addMatches(/&(?:#\d+|#x[\da-f]+|[a-z][\w]+);/gi)
  // HTML comments are non-rendered markup and may span multiple lines.
  // Preserve an unclosed comment through EOF rather than exposing its payload.
  let commentCursor = 0
  while (commentCursor < source.length) {
    const commentStart = source.indexOf('<!--', commentCursor)
    if (commentStart < 0) break
    const enclosing = ranges.find((range) => commentStart >= range.start && commentStart < range.end)
    if (enclosing) {
      commentCursor = enclosing.end
      continue
    }
    const commentClose = source.indexOf('-->', commentStart + 4)
    const commentEnd = commentClose < 0 ? source.length : commentClose + 3
    add(commentStart, commentEnd)
    commentCursor = commentEnd
  }

  // Link labels can be translated; brackets, destinations and titles cannot.
  // Images are kept intact because their alt text describes an embedded asset.
  const links = /(!?)\[([^\]\n]*)\]\((?:<[^>\n]*>|[^)\n])*\)/g
  for (const match of source.matchAll(links)) {
    const linkStart = match.index
    const linkEnd = linkStart + match[0].length
    if (match[1] === '!') {
      add(linkStart, linkEnd)
      continue
    }
    const labelStart = linkStart + 1
    const labelEnd = labelStart + match[2].length
    add(linkStart, labelStart)
    add(labelEnd, linkEnd)
  }

  // Common block prefixes, horizontal rules and formatting delimiters.
  addMatches(/^ {0,3}(?:#{1,6}[ \t]+|>[ \t]?|(?:[-+*]|\d+[.)])[ \t]+)(?:\[[ xX]\][ \t]+)?/gm)
  addMatches(/^ {0,3}(?:(?:\*|_|-)[ \t]*){3,}[ \t]*$/gm)
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

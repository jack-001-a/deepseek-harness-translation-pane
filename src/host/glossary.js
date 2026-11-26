import { splitText } from './text.js'

/** Maximum number of configured terms retained by the Host. */
export const MAX_GLOSSARY_ENTRIES = 128
/** Maximum source or target term length, in UTF-16 code units. */
export const MAX_GLOSSARY_TERM_CHARS = 128

/**
 * Escape a literal term for use in a regular-expression alternative.
 * @param value - the configured source term.
 * @returns a regex-safe literal.
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Normalize and bound the configured source-to-target glossary.
 *
 * The first duplicate wins. Terms are matched case-insensitively; longer
 * terms are ordered first so a phrase takes precedence over its substrings.
 * ASCII word boundaries prevent a term such as "API" from matching inside
 * "rapid" or "APIs", while CJK terms remain usable inside continuous text.
 *
 * @param raw - the profile's glossary array.
 * @returns a frozen list of validated terms.
 */
export function normalizeGlossary(raw) {
  if (!Array.isArray(raw)) return Object.freeze([])

  const seen = new Set()
  const entries = []
  for (const candidate of raw.slice(0, MAX_GLOSSARY_ENTRIES * 2)) {
    if (entries.length >= MAX_GLOSSARY_ENTRIES) break
    if (candidate === null || typeof candidate !== 'object') continue
    if (typeof candidate.source !== 'string' || typeof candidate.target !== 'string') continue

    const source = candidate.source.trim()
    const target = candidate.target.trim()
    if (
      source.length === 0 ||
      target.length === 0 ||
      source.length > MAX_GLOSSARY_TERM_CHARS ||
      target.length > MAX_GLOSSARY_TERM_CHARS ||
      /[\u0000-\u001F\u007F]/u.test(source) ||
      /[\u0000-\u001F\u007F]/u.test(target)
    ) continue

    const key = source.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    const first = Array.from(source)[0]
    const last = Array.from(source).at(-1)
    const prefix = /^[A-Za-z0-9_]$/.test(first) ? '(?<![A-Za-z0-9_])' : ''
    const suffix = /^[A-Za-z0-9_]$/.test(last) ? '(?![A-Za-z0-9_])' : ''
    entries.push({
      source,
      target,
      key,
      pattern: prefix + escapeRegExp(source) + suffix,
    })
  }

  entries.sort((left, right) => right.source.length - left.source.length)
  return Object.freeze(entries.map((entry) => Object.freeze(entry)))
}

/**
 * Split one source string into translatable prose and locally replaced terms.
 *
 * The returned sequence is lossless in source order. Matched terms are
 * replaced with their configured target text and marked non-translatable, so
 * the external provider never receives those matched source terms.
 *
 * @param source - the original source string.
 * @param glossary - normalized glossary entries.
 * @returns ordered translatable and literal segments.
 */
export function glossarySegments(source, glossary) {
  if (source.length === 0) return []
  if (!Array.isArray(glossary) || glossary.length === 0) {
    return [{ text: source, translate: true }]
  }

  const alternatives = glossary.map((entry) => entry.pattern).join('|')
  const pattern = new RegExp(alternatives, 'giu')
  const bySource = new Map(glossary.map((entry) => [entry.key, entry]))
  const segments = []
  const append = (text, translate) => {
    if (text.length === 0) return
    const previous = segments.at(-1)
    if (previous && previous.translate === translate) {
      previous.text += text
    } else {
      segments.push({ text, translate })
    }
  }

  let cursor = 0
  for (const match of source.matchAll(pattern)) {
    const entry = bySource.get(match[0].toLowerCase())
    if (entry === undefined) continue
    append(source.slice(cursor, match.index), true)
    append(entry.target, false)
    cursor = match.index + match[0].length
  }
  append(source.slice(cursor), true)

  return segments
}

/**
 * Build provider-sized fragments while keeping glossary replacements local.
 * @param source - one source string or Markdown prose segment.
 * @param glossary - normalized glossary entries.
 * @param fragmentChars - provider request size.
 * @returns a translation plan in source order.
 */
export function createTranslationPlan(source, glossary, fragmentChars) {
  return glossarySegments(source, glossary).map((segment) => ({
    ...segment,
    fragments: segment.translate ? splitText(segment.text, fragmentChars) : [],
  }))
}

/**
 * Count provider fragments across multiple translation plans.
 * @param plans - plans in output order.
 * @returns the number of provider fragments.
 */
export function countTranslationPlanFragments(plans) {
  return plans.reduce(
    (total, plan) => total + plan.reduce((count, segment) => count + segment.fragments.length, 0),
    0,
  )
}

/**
 * Render translation plans with provider results in source order.
 * @param plans - plans in output order.
 * @param results - provider result records in dispatch order.
 * @returns rendered strings and the number of consumed provider results.
 */
export function renderTranslationPlans(plans, results) {
  let cursor = 0
  const texts = plans.map((plan) => {
    let output = ''
    for (const segment of plan) {
      if (!segment.translate || segment.fragments.length === 0) {
        output += segment.text
        continue
      }
      const count = segment.fragments.length
      output += results.slice(cursor, cursor + count).map((entry) => entry.text).join('')
      cursor += count
    }
    return output
  })
  return { texts, consumed: cursor }
}

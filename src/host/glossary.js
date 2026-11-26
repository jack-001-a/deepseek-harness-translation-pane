import { splitText } from './text.js'

/** Maximum number of configured terms retained by the Host. */
export const MAX_GLOSSARY_ENTRIES = 128
/** Maximum source or target term length, in UTF-16 code units. */
export const MAX_GLOSSARY_TERM_CHARS = 128
/** Maximum JSON import size, in UTF-8 bytes. */
export const MAX_GLOSSARY_IMPORT_BYTES = 256 * 1024
/** Supported version of the portable glossary JSON format. */
export const GLOSSARY_FORMAT_VERSION = 1

/**
 * Escape a literal term for use in a regular-expression alternative.
 * @param value - the configured source term.
 * @returns a regex-safe literal.
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&')
}

/**
 * Normalize a language scope. A wildcard keeps a rule applicable to every
 * language pair; concrete tags also match their regional subtags.
 * @param value - the configured BCP-47 language tag or wildcard.
 * @returns the normalized scope.
 */
function languageScope(value) {
  if (value === undefined || value === null || value === '') return '*'
  if (typeof value !== 'string') return null
  const tag = value.trim()
  if (tag === '*') return '*'
  if (!/^(?:auto|[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/u.test(tag)) return null
  return tag.toLowerCase()
}

/**
 * Decide whether one configured language scope applies to a request.
 * A source set to "auto" only receives wildcard or auto-specific rules: a
 * language-specific rule must not be guessed before detection.
 * @param configured - the normalized glossary scope.
 * @param actual - the request language.
 * @returns whether the scope applies.
 */
export function languageScopeMatches(configured, actual) {
  if (configured === '*') return true
  if (typeof actual !== 'string' || actual.length === 0) return false
  const language = actual.trim().toLowerCase()
  if (language === 'auto') return configured === 'auto'
  return language === configured || language.startsWith(configured + '-')
}

/**
 * Build the regular expression for one normalized glossary entry.
 * @param entry - validated term fields.
 * @returns a global matcher for this entry.
 */
function compileEntry(entry) {
  const first = Array.from(entry.source)[0]
  const last = Array.from(entry.source).at(-1)
  const automaticBoundary =
    /^[A-Za-z0-9_]$/u.test(first) || /^[A-Za-z0-9_]$/u.test(last)
  const boundary = entry.wholeWord === null ? automaticBoundary : entry.wholeWord
  const prefix = boundary && /^[A-Za-z0-9_]$/u.test(first) ? '(?<![A-Za-z0-9_])' : ''
  const suffix = boundary && /^[A-Za-z0-9_]$/u.test(last) ? '(?![A-Za-z0-9_])' : ''
  return new RegExp(
    prefix + escapeRegExp(entry.source) + suffix,
    entry.matchCase ? 'gu' : 'giu',
  )
}

/**
 * Inspect, validate and normalize raw glossary terms.
 *
 * Duplicate source terms within the same language scope are diagnosed;
 * conflicting translations are errors. Overlapping terms are warnings because
 * the matcher resolves them deterministically by priority, then length.
 *
 * @param raw - the profile or imported glossary array.
 * @returns sanitized entries and serializable diagnostics.
 */
export function inspectGlossary(raw) {
  const errors = []
  const warnings = []
  const entries = []
  if (raw === undefined || raw === null) raw = []
  if (!Array.isArray(raw)) {
    return {
      entries,
      errors: [{ code: 'invalid-glossary', index: null, message: 'Glossary must be an array.' }],
      warnings,
    }
  }
  if (raw.length > MAX_GLOSSARY_ENTRIES) {
    errors.push({
      code: 'too-many-entries',
      index: null,
      message: 'Glossary exceeds the maximum of ' + MAX_GLOSSARY_ENTRIES + ' entries.',
    })
  }

  const seen = new Map()
  const candidates = raw.slice(0, MAX_GLOSSARY_ENTRIES)
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    const invalid = (message) => errors.push({ code: 'invalid-entry', index, message })
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      invalid('Entry must be an object.')
      continue
    }
    if (typeof candidate.source !== 'string' || typeof candidate.target !== 'string') {
      invalid('Entry requires string source and target fields.')
      continue
    }

    const source = candidate.source.trim()
    const target = candidate.target.trim()
    if (
      source.length === 0 ||
      target.length === 0 ||
      source.length > MAX_GLOSSARY_TERM_CHARS ||
      target.length > MAX_GLOSSARY_TERM_CHARS ||
      /[\u0000-\u001F\u007F]/u.test(source) ||
      /[\u0000-\u001F\u007F]/u.test(target)
    ) {
      invalid('Source and target must be non-empty, control-free terms of at most ' +
        MAX_GLOSSARY_TERM_CHARS + ' characters.')
      continue
    }

    const sourceLanguage = languageScope(candidate.sourceLanguage)
    const targetLanguage = languageScope(candidate.targetLanguage)
    if (sourceLanguage === null || targetLanguage === null) {
      invalid('Language scopes must be *, auto, or valid BCP-47 language tags.')
      continue
    }
    if (candidate.matchCase !== undefined && typeof candidate.matchCase !== 'boolean') {
      invalid('matchCase must be a boolean when supplied.')
      continue
    }
    if (candidate.wholeWord !== undefined && typeof candidate.wholeWord !== 'boolean') {
      invalid('wholeWord must be a boolean when supplied.')
      continue
    }
    if (candidate.enabled !== undefined && typeof candidate.enabled !== 'boolean') {
      invalid('enabled must be a boolean when supplied.')
      continue
    }
    const priority = candidate.priority === undefined ? 0 : candidate.priority
    if (!Number.isInteger(priority) || priority < -1000 || priority > 1000) {
      invalid('priority must be an integer between -1000 and 1000.')
      continue
    }

    const entry = {
      source,
      target,
      sourceLanguage,
      targetLanguage,
      matchCase: candidate.matchCase === true,
      wholeWord: candidate.wholeWord === true
        ? true
        : candidate.wholeWord === false
          ? false
          : null,
      enabled: candidate.enabled !== false,
      priority,
      index,
    }
    const duplicateKey = [
      sourceLanguage,
      targetLanguage,
      entry.matchCase ? 'case' : 'fold',
      entry.matchCase ? source : source.toLowerCase(),
    ].join('\u0000')
    const previous = seen.get(duplicateKey)
    if (previous !== undefined) {
      const sameTarget = previous.target === target
      warnings.push({
        code: sameTarget ? 'duplicate-entry' : 'conflicting-entry',
        index,
        otherIndex: previous.index,
        message: sameTarget
          ? 'Duplicate source term; the first entry is retained.'
          : 'The same source term has different targets in the same language scope; the first entry is retained.',
      })
      if (!sameTarget) {
        errors.push({
          code: 'conflicting-entry',
          index,
          otherIndex: previous.index,
          message: 'Conflicting target for a duplicate source term.',
        })
      }
      continue
    }
    seen.set(duplicateKey, entry)
    entries.push(entry)
  }

  // Warn when two enabled terms in the same language scope overlap. Longest
  // match and explicit priority make the winner reproducible.
  for (let left = 0; left < entries.length; left += 1) {
    const a = entries[left]
    if (!a.enabled) continue
    for (let right = left + 1; right < entries.length; right += 1) {
      const b = entries[right]
      if (!b.enabled) continue
      if (a.sourceLanguage !== b.sourceLanguage || a.targetLanguage !== b.targetLanguage) continue
      const aSource = a.matchCase ? a.source : a.source.toLowerCase()
      const bSource = a.matchCase ? b.source : b.source.toLowerCase()
      const overlaps = aSource.includes(bSource) || bSource.includes(aSource)
      if (!overlaps) continue
      warnings.push({
        code: 'overlapping-terms',
        index: b.index,
        otherIndex: a.index,
        message: 'Overlapping source terms use priority first, then longest-match order.',
      })
    }
  }

  entries.sort(
    (left, right) =>
      right.priority - left.priority ||
      right.source.length - left.source.length ||
      left.index - right.index,
  )
  const normalized = entries.map((entry) => Object.freeze({
    ...entry,
    pattern: compileEntry(entry),
  }))
  return {
    entries: Object.freeze(normalized),
    errors: Object.freeze(errors),
    warnings: Object.freeze(warnings),
  }
}

/**
 * Normalize the configured glossary, retaining the historical array format.
 * Invalid entries are ignored after validation; use inspectGlossary when the
 * caller needs to present diagnostics.
 * @param raw - raw entries.
 * @returns frozen normalized entries.
 */
export function normalizeGlossary(raw) {
  return inspectGlossary(raw).entries
}

/**
 * Convert normalized entries to a portable, versioned JSON data structure.
 * @param glossary - normalized glossary entries.
 * @returns a versioned export document.
 */
export function glossaryExportDocument(glossary) {
  return {
    version: GLOSSARY_FORMAT_VERSION,
    glossary: (Array.isArray(glossary) ? glossary : []).map((entry) => ({
      source: entry.source,
      target: entry.target,
      ...(entry.sourceLanguage === '*' ? {} : { sourceLanguage: entry.sourceLanguage }),
      ...(entry.targetLanguage === '*' ? {} : { targetLanguage: entry.targetLanguage }),
      ...(entry.matchCase ? { matchCase: true } : {}),
      ...(entry.wholeWord === null ? {} : { wholeWord: entry.wholeWord }),
      ...(entry.enabled === false ? { enabled: false } : {}),
      ...(entry.priority === 0 ? {} : { priority: entry.priority }),
    })),
  }
}

/**
 * Serialize the portable glossary format as formatted JSON.
 * @param glossary - normalized glossary entries.
 * @returns the JSON export.
 */
export function serializeGlossaryExport(glossary) {
  return JSON.stringify(glossaryExportDocument(glossary), null, 2)
}

/**
 * Parse and inspect a pasted or uploaded glossary JSON file.
 * Accepts either the versioned export document or the legacy bare array.
 * @param input - JSON text.
 * @returns normalized entries plus diagnostics.
 */
export function parseGlossaryImport(input) {
  if (typeof input !== 'string') {
    return {
      entries: Object.freeze([]),
      errors: Object.freeze([{ code: 'invalid-json', index: null, message: 'Import must be JSON text.' }]),
      warnings: Object.freeze([]),
    }
  }
  if (BufferByteLength(input) > MAX_GLOSSARY_IMPORT_BYTES) {
    return {
      entries: Object.freeze([]),
      errors: Object.freeze([{ code: 'import-too-large', index: null, message: 'Glossary JSON exceeds the import size limit.' }]),
      warnings: Object.freeze([]),
    }
  }
  let parsed
  try {
    parsed = JSON.parse(input)
  } catch {
    return {
      entries: Object.freeze([]),
      errors: Object.freeze([{ code: 'invalid-json', index: null, message: 'Glossary import is not valid JSON.' }]),
      warnings: Object.freeze([]),
    }
  }
  let raw = parsed
  if (!Array.isArray(parsed)) {
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      parsed.version !== GLOSSARY_FORMAT_VERSION ||
      !Array.isArray(parsed.glossary)
    ) {
      return {
        entries: Object.freeze([]),
        errors: Object.freeze([{ code: 'unsupported-format', index: null, message: 'Expected a version 1 glossary document or a legacy JSON array.' }]),
        warnings: Object.freeze([]),
      }
    }
    raw = parsed.glossary
  }
  return inspectGlossary(raw)
}

/**
 * Measure a string as UTF-8 bytes without requiring a Node-only Buffer import.
 * @param value - input text.
 * @returns UTF-8 byte length.
 */
function BufferByteLength(value) {
  return new TextEncoder().encode(value).byteLength
}

/**
 * Split one source string into translatable prose and locally replaced terms.
 * Matching is scoped to the request's source and target languages.
 * @param source - the original source string.
 * @param glossary - normalized glossary entries.
 * @param languages - source and target language tags.
 * @returns ordered translatable and literal segments.
 */
export function glossarySegments(source, glossary, languages = {}) {
  if (source.length === 0) return []
  if (!Array.isArray(glossary) || glossary.length === 0) {
    return [{ text: source, translate: true }]
  }
  const applicable = glossary.filter((entry) =>
    entry.enabled !== false &&
    languageScopeMatches(entry.sourceLanguage ?? '*', languages.sourceLanguage ?? 'auto') &&
    languageScopeMatches(entry.targetLanguage ?? '*', languages.targetLanguage ?? 'zh-Hans'),
  )
  if (applicable.length === 0) return [{ text: source, translate: true }]

  const matches = []
  for (const entry of applicable) {
    for (const match of source.matchAll(entry.pattern)) {
      matches.push({
        start: match.index,
        end: match.index + match[0].length,
        entry,
      })
    }
  }
  matches.sort(
    (left, right) =>
      left.start - right.start ||
      right.entry.priority - left.entry.priority ||
      (right.end - right.start) - (left.end - left.start) ||
      left.entry.index - right.entry.index,
  )

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
  for (const match of matches) {
    if (match.start < cursor) continue
    append(source.slice(cursor, match.start), true)
    append(match.entry.target, false)
    cursor = match.end
  }
  append(source.slice(cursor), true)
  return segments
}

/**
 * Build provider-sized fragments while keeping glossary replacements local.
 * @param source - one source string or Markdown prose segment.
 * @param glossary - normalized glossary entries.
 * @param fragmentChars - provider request size.
 * @param languages - source and target language tags.
 * @returns a translation plan in source order.
 */
export function createTranslationPlan(source, glossary, fragmentChars, languages = {}) {
  return glossarySegments(source, glossary, languages).map((segment) => ({
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

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

const RULES = [
  { id: 'glossary-unused-term', name: 'Unused glossary term', level: 'warning', description: 'A configured term does not occur in the source sample.' },
  { id: 'glossary-shadowed-match', name: 'Shadowed glossary match', level: 'warning', description: 'A term occurrence loses to an overlapping match.' },
  { id: 'glossary-pattern-mismatch', name: 'Glossary pattern mismatch', level: 'warning', description: 'A literal occurrence is rejected by case or whole-word matching.' },
  { id: 'glossary-language-scope-mismatch', name: 'Glossary language scope mismatch', level: 'note', description: 'A rule is outside the selected language pair.' },
  { id: 'glossary-invalid-entry', name: 'Invalid glossary entry', level: 'error', description: 'A glossary import contains an invalid or conflicting entry.' },
  { id: 'glossary-duplicate-entry', name: 'Duplicate glossary entry', level: 'note', description: 'A duplicate entry was found; the first entry is retained.' },
  { id: 'glossary-overlapping-entry', name: 'Overlapping glossary entries', level: 'note', description: 'Enabled glossary terms overlap and may compete for source text.' },
]
const RULE_INDEX = new Map(RULES.map((rule, index) => [rule.id, index]))

function artifactUri(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath === '-') return null
  return relative(process.cwd(), resolve(filePath)).replace(/\\/gu, '/')
}

function sarifRegion(sourceText, start, length) {
  const prefix = sourceText.slice(0, start)
  const matchedText = sourceText.slice(start, start + length)
  const prefixLines = prefix.split(/\r\n|\r|\n/u)
  const matchedLines = matchedText.split(/\r\n|\r|\n/u)
  const startLine = prefixLines.length
  const startColumn = Array.from(prefixLines.at(-1)).length + 1
  const endLine = startLine + matchedLines.length - 1
  const endColumn = matchedLines.length === 1
    ? startColumn + Array.from(matchedText).length
    : Array.from(matchedLines.at(-1)).length + 1
  return {
    startLine, startColumn, endLine, endColumn,
    charOffset: Array.from(prefix).length,
    charLength: Array.from(matchedText).length,
  }
}

export function createGlossarySarifReport({
  glossaryFile, sampleFile, sourceText = '', validation,
  rules = [], summary = null, ciPolicy = null,
}) {
  const results = []
  const glossaryUri = artifactUri(glossaryFile)
  const sampleUri = artifactUri(sampleFile)
  const diagnostics = validation ?? { errors: [], warnings: [] }
  const errors = Array.isArray(diagnostics.errors) ? diagnostics.errors : []
  const warnings = Array.isArray(diagnostics.warnings) ? diagnostics.warnings : []

  function addResult(ruleId, level, message, details = {}) {
    const hasRange = sampleUri !== null &&
      Number.isInteger(details.start) &&
      Number.isInteger(details.length) &&
      details.start >= 0 && details.length >= 0 &&
      details.start + details.length <= sourceText.length
    const uri = hasRange ? sampleUri : glossaryUri ?? sampleUri
    const locations = []
    if (uri !== null) {
      const physicalLocation = { artifactLocation: { uri } }
      if (hasRange) physicalLocation.region = sarifRegion(sourceText, details.start, details.length)
      locations.push({ physicalLocation })
    }
    const properties = { ...(details.properties ?? {}) }
    if (Number.isInteger(details.entryIndex)) properties.glossaryEntryIndex = details.entryIndex
    if (typeof details.source === 'string') properties.sourceTerm = details.source
    if (typeof details.target === 'string') properties.targetTerm = details.target
    results.push({
      ruleId, ruleIndex: RULE_INDEX.get(ruleId), level, message: { text: message },
      ...(locations.length ? { locations } : {}),
      ...(Object.keys(properties).length ? { properties } : {}),
    })
  }

  for (const diagnostic of errors) {
    addResult('glossary-invalid-entry', 'error', diagnostic.message ?? 'Invalid glossary entry.', {
      entryIndex: diagnostic.index,
      properties: {
        diagnosticCode: diagnostic.code ?? 'invalid-glossary',
        ...(Number.isInteger(diagnostic.otherIndex) ? { conflictingEntryIndex: diagnostic.otherIndex } : {}),
      },
    })
  }
  for (const diagnostic of warnings) {
    if (diagnostic.code === 'conflicting-entry') continue
    const ruleId = diagnostic.code === 'duplicate-entry'
      ? 'glossary-duplicate-entry'
      : 'glossary-overlapping-entry'
    addResult(ruleId, 'note', diagnostic.message ?? 'Glossary diagnostic.', {
      entryIndex: diagnostic.index,
      properties: {
        diagnosticCode: diagnostic.code ?? 'glossary-warning',
        ...(Number.isInteger(diagnostic.otherIndex) ? { relatedEntryIndex: diagnostic.otherIndex } : {}),
      },
    })
  }

  for (const rule of rules) {
    const entryIndex = Number.isInteger(rule.index) ? rule.index : null
    if (rule.reason === 'disabled') continue
    if (rule.reason === 'source-language-mismatch' || rule.reason === 'target-language-mismatch') {
      addResult(
        'glossary-language-scope-mismatch',
        'note',
        'Term "' + rule.source + '" is outside the selected language pair (' +
          (rule.reason === 'source-language-mismatch' ? 'source' : 'target') + ' language mismatch).',
        { entryIndex, source: rule.source, target: rule.target, properties: { reason: rule.reason } },
      )
    }
    if (rule.reason === 'case-mismatch' || rule.reason === 'word-boundary-mismatch') {
      for (const start of Array.isArray(rule.literalOccurrences) ? rule.literalOccurrences : []) {
        addResult(
          'glossary-pattern-mismatch',
          'warning',
          'Term "' + rule.source + '" occurs in the sample but is rejected by ' +
            (rule.reason === 'case-mismatch' ? 'case-sensitive matching.' : 'whole-word boundaries.'),
          {
            entryIndex, source: rule.source, target: rule.target,
            start, length: rule.source.length,
            properties: { reason: rule.reason },
          },
        )
      }
    }
    for (const match of Array.isArray(rule.matches) ? rule.matches : []) {
      if (match.decision !== 'shadowed') continue
      addResult(
        'glossary-shadowed-match',
        'warning',
        'Term "' + rule.source + '" is shadowed by ' +
          (Array.isArray(match.blockedBy) && match.blockedBy.length
            ? match.blockedBy.map((item) => '"' + item.source + '"').join(', ')
            : 'a higher-precedence glossary match') + '.',
        {
          entryIndex, source: rule.source, target: rule.target,
          start: match.start, length: match.end - match.start,
          properties: { reason: 'overlap', blockedBy: Array.isArray(match.blockedBy) ? match.blockedBy : [] },
        },
      )
    }
    if (rule.reason === 'not-found') {
      addResult(
        'glossary-unused-term',
        'warning',
        'Term "' + rule.source + '" was not found in the supplied source sample.',
        { entryIndex, source: rule.source, target: rule.target, properties: { reason: 'not-found' } },
      )
    }
  }

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'DSH Translation Glossary Audit',
          informationUri: 'https://github.com/jack-001-a/deepseek-harness-translation-pane',
          rules: RULES.map((rule) => ({
            id: rule.id, name: rule.name,
            shortDescription: { text: rule.name },
            fullDescription: { text: rule.description },
            defaultConfiguration: { level: rule.level },
          })),
        },
      },
      columnKind: 'unicodeCodePoints',
      results,
      invocations: [{ executionSuccessful: errors.length === 0 && (ciPolicy?.passed ?? true) }],
      properties: {
        ...(summary ? { summary } : {}),
        ...(ciPolicy ? { ciPolicy } : {}),
        glossaryFile: glossaryUri,
        sourceFile: sampleUri,
      },
    }],
  }
}

export function writeGlossarySarif(report, outputPath) {
  const serialized = JSON.stringify(report, null, 2) + '\n'
  if (typeof outputPath === 'string' && outputPath.length > 0) {
    mkdirSync(dirname(resolve(outputPath)), { recursive: true })
    writeFileSync(outputPath, serialized, 'utf8')
    return
  }
  process.stdout.write(serialized)
}

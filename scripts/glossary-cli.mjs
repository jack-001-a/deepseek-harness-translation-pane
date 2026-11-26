#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { createGlossarySarifReport, writeGlossarySarif } from './glossary-sarif.mjs'

import { glossarySegments, languageScopeMatches, parseGlossaryImport, serializeGlossaryExport } from '../src/host/glossary.js'

const USAGE = [
  'Usage:',
  '  dsh-translation-glossary validate [file|-] [--format text|json]',
  '  dsh-translation-glossary policy validate <policy-file> [--format text|json]',
  '  dsh-translation-glossary fix <file> --output <new-file> [--format text|json]',
  '  dsh-translation-glossary preview [file|-] (--text <text> | --text-file <path>)',
  '      [--source-language <tag|auto>] [--target-language <tag>] [--format text|json|sarif] [--output <path>]',
  '  dsh-translation-glossary diff <before-file|-> <after-file|-> [--format text|json]',
  '  dsh-translation-glossary explain <file|-> (--text <text> | --text-file <path>)',
  '      [--source-language <tag|auto>] [--target-language <tag>] [--format text|json]',
  '  dsh-translation-glossary audit <file|-> (--text <text> | --text-file <path>)',
  '      [--source-language <tag|auto>] [--target-language <tag>] [--format text|json]',
  '      [--fail-on none|unused|shadowed|pattern-mismatch|out-of-scope|any] [--policy <file>]',
  '',
  'Use "-" or omit the glossary file to read glossary JSON from stdin.',
  'Exit codes: 0 success/policy pass, 1 invalid glossary or failed audit policy, 2 usage or file error.',
].join('\n')

class CliError extends Error {}

function parseOptions(args, allowed) {
  const positional = []
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const separator = token.indexOf('=')
    const name = token.slice(2, separator === -1 ? undefined : separator)
    if (!allowed.has(name)) throw new CliError('Unknown option: --' + name)
    if (Object.hasOwn(options, name)) throw new CliError('Option supplied more than once: --' + name)
    const value = separator === -1 ? args[index + 1] : token.slice(separator + 1)
    if (value === undefined || (separator === -1 && index + 1 >= args.length)) {
      throw new CliError('Option requires a value: --' + name)
    }
    options[name] = value
    if (separator === -1) index += 1
  }
  return { positional, options }
}

function readTextFile(filePath, label) {
  try {
    return readFileSync(filePath === '-' ? 0 : filePath, 'utf8')
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'IO_ERROR'
    throw new CliError('Cannot read ' + label + ' "' + filePath + '" (' + code + ').')
  }
}

function writeJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n')
}

function diagnosticLines(diagnostics, label) {
  for (const item of diagnostics) {
    const side = item.side ? item.side + ' ' : ''
    const location = Number.isInteger(item.index) ? 'entry ' + (item.index + 1) + ': ' : ''
    process.stdout.write(label + ' [' + item.code + '] ' + side + location + item.message + '\n')
  }
}

function reportValidation(validation) {
  return {
    valid: validation.errors.length === 0,
    entryCount: validation.entries.length,
    errors: validation.errors,
    warnings: validation.warnings,
  }
}

function validate(args) {
  const { positional, options } = parseOptions(args, new Set(['format']))
  if (positional.length > 1) throw new CliError('validate accepts at most one glossary file.')
  const format = options.format ?? 'text'
  if (!['text', 'json'].includes(format)) throw new CliError('--format must be "text" or "json".')

  const input = readTextFile(positional[0] ?? '-', 'glossary file')
  const validation = parseGlossaryImport(input)
  const report = reportValidation(validation)
  if (format === 'json') {
    writeJson({ command: 'validate', ...report })
  } else {
    process.stdout.write('Glossary validation: ' + (report.valid ? 'valid' : 'invalid') + '\n')
    process.stdout.write('Accepted entries: ' + report.entryCount + '\n')
    process.stdout.write('Errors: ' + report.errors.length + '; warnings: ' + report.warnings.length + '\n')
    diagnosticLines(report.errors, 'ERROR')
    diagnosticLines(report.warnings, 'WARN')
  }
  return report.valid ? 0 : 1
}

function preview(args) {
  const { positional, options } = parseOptions(
    args,
    new Set(['format', 'text', 'text-file', 'source-language', 'target-language']),
  )
  if (positional.length > 1) throw new CliError('preview accepts at most one glossary file.')
  if (Object.hasOwn(options, 'text') === Object.hasOwn(options, 'text-file')) {
    throw new CliError('preview requires exactly one of --text or --text-file.')
  }
  const format = options.format ?? 'text'
  if (!['text', 'json'].includes(format)) throw new CliError('--format must be "text" or "json".')
  const sourceLanguage = options['source-language'] ?? 'auto'
  const targetLanguage = options['target-language'] ?? 'zh-Hans'
  const languagePattern = /^(?:auto|[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/u
  if (!languagePattern.test(sourceLanguage)) {
    throw new CliError('--source-language must be "auto" or a BCP-47 language tag.')
  }
  if (!languagePattern.test(targetLanguage)) {
    throw new CliError('--target-language must be a BCP-47 language tag.')
  }

  const glossaryInput = readTextFile(positional[0] ?? '-', 'glossary file')
  const validation = parseGlossaryImport(glossaryInput)
  if (validation.errors.length > 0) {
    const report = { command: 'preview', ...reportValidation(validation) }
    if (format === 'json') writeJson(report)
    else {
      process.stdout.write('Glossary is invalid; preview was not generated.\n')
      diagnosticLines(validation.errors, 'ERROR')
      diagnosticLines(validation.warnings, 'WARN')
    }
    return 1
  }

  const sourceText = Object.hasOwn(options, 'text')
    ? options.text
    : readTextFile(options['text-file'], 'source text file')
  const segments = glossarySegments(sourceText, validation.entries, {
    sourceLanguage,
    targetLanguage,
  })
  const replacementSegments = segments.filter((segment) => !segment.translate)
  const report = {
    command: 'preview',
    valid: true,
    sourceLanguage,
    targetLanguage,
    providerCalls: 0,
    localReplacementCount: replacementSegments.length,
    localReplacements: replacementSegments.map((segment) => segment.text),
    previewText: segments.map((segment) => segment.text).join(''),
    segments: segments.map((segment) => ({
      kind: segment.translate ? 'unmatched-source' : 'local-glossary-replacement',
      text: segment.text,
    })),
    warnings: validation.warnings,
    note: 'This is a local glossary-only preview. Unmatched source text stays unchanged; no machine translation or provider request is performed.',
  }

  if (format === 'json') {
    writeJson(report)
  } else {
    process.stdout.write('Local glossary preview (no provider calls)\n')
    process.stdout.write('Language pair: ' + sourceLanguage + ' -> ' + targetLanguage + '\n')
    process.stdout.write('Local replacement segments: ' + report.localReplacementCount + '\n')
    process.stdout.write('Preview:\n' + report.previewText + '\n')
    process.stdout.write('Unmatched source text is unchanged; this is not a machine translation.\n')
    diagnosticLines(validation.warnings, 'WARN')
  }
  return 0
}


function glossaryIdentity(entry) {
  const source = entry.matchCase ? entry.source : entry.source.toLowerCase()
  return JSON.stringify([entry.sourceLanguage, entry.targetLanguage, entry.matchCase, source])
}

function glossaryRecord(entry) {
  return {
    source: entry.source,
    target: entry.target,
    sourceLanguage: entry.sourceLanguage,
    targetLanguage: entry.targetLanguage,
    matchCase: entry.matchCase,
    wholeWord: entry.wholeWord,
    enabled: entry.enabled,
    priority: entry.priority,
    index: entry.index,
  }
}

function compareGlossaryEntries(beforeEntries, afterEntries) {
  const before = new Map(beforeEntries.map((entry) => [glossaryIdentity(entry), entry]))
  const after = new Map(afterEntries.map((entry) => [glossaryIdentity(entry), entry]))
  const added = []
  const removed = []
  const changed = []
  const changedKeys = new Set()

  for (const [key, entry] of after) {
    const previous = before.get(key)
    if (!previous) {
      added.push(glossaryRecord(entry))
      continue
    }
    const fields = ['source', 'target', 'wholeWord', 'enabled', 'priority']
    const differences = fields.filter((field) => previous[field] !== entry[field])
    if (differences.length > 0) {
      changedKeys.add(key)
      changed.push({
        source: entry.source,
        fields: differences,
        before: glossaryRecord(previous),
        after: glossaryRecord(entry),
      })
    }
  }

  for (const [key, entry] of before) {
    if (!after.has(key)) removed.push(glossaryRecord(entry))
  }

  const beforeCommon = beforeEntries
    .filter((entry) => after.has(glossaryIdentity(entry)))
    .map(glossaryIdentity)
  const afterCommon = afterEntries
    .filter((entry) => before.has(glossaryIdentity(entry)))
    .map(glossaryIdentity)
  const beforeRank = new Map(beforeCommon.map((key, index) => [key, index]))
  const reordered = []
  const reorderedKeys = new Set()
  for (let index = 0; index < afterCommon.length; index += 1) {
    const key = afterCommon[index]
    const oldRank = beforeRank.get(key)
    if (oldRank === index) continue
    const previous = before.get(key)
    const current = after.get(key)
    reorderedKeys.add(key)
    reordered.push({
      source: current.source,
      beforeIndex: previous.index,
      afterIndex: current.index,
      beforePosition: oldRank + 1,
      afterPosition: index + 1,
    })
  }

  const affected = new Set([...changedKeys, ...reorderedKeys])
  const unchangedCount = Math.max(0, beforeCommon.length - affected.size)
  const sortByIndex = (left, right) => left.index - right.index
  added.sort(sortByIndex)
  removed.sort(sortByIndex)
  changed.sort((left, right) => left.after.index - right.after.index)
  reordered.sort((left, right) => left.afterIndex - right.afterIndex)

  return {
    summary: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      reordered: reordered.length,
      unchanged: unchangedCount,
    },
    added,
    removed,
    changed,
    reordered,
  }
}

function diff(args) {
  const { positional, options } = parseOptions(args, new Set(['format']))
  if (positional.length !== 2) {
    throw new CliError('diff requires exactly two glossary files: <before-file> <after-file>.')
  }
  if (positional[0] === '-' && positional[1] === '-') {
    throw new CliError('Only one diff input may use stdin ("-").')
  }
  const format = options.format ?? 'text'
  if (!['text', 'json'].includes(format)) throw new CliError('--format must be "text" or "json".')

  const beforeInput = readTextFile(positional[0], 'before glossary file')
  const afterInput = readTextFile(positional[1], 'after glossary file')
  const beforeValidation = parseGlossaryImport(beforeInput)
  const afterValidation = parseGlossaryImport(afterInput)
  const errors = [
    ...beforeValidation.errors.map((item) => ({ ...item, side: 'before' })),
    ...afterValidation.errors.map((item) => ({ ...item, side: 'after' })),
  ]
  const warnings = [
    ...beforeValidation.warnings.map((item) => ({ ...item, side: 'before' })),
    ...afterValidation.warnings.map((item) => ({ ...item, side: 'after' })),
  ]

  if (errors.length > 0) {
    const report = {
      command: 'diff',
      valid: false,
      beforeFile: positional[0],
      afterFile: positional[1],
      errors,
      warnings,
    }
    if (format === 'json') writeJson(report)
    else {
      process.stdout.write('Glossary diff was not generated because an input is invalid.\n')
      diagnosticLines(errors, 'ERROR')
      diagnosticLines(warnings, 'WARN')
    }
    return 1
  }

  const beforeEntries = [...beforeValidation.entries].sort((left, right) => left.index - right.index)
  const afterEntries = [...afterValidation.entries].sort((left, right) => left.index - right.index)
  const comparison = compareGlossaryEntries(beforeEntries, afterEntries)
  const report = {
    command: 'diff',
    valid: true,
    beforeFile: positional[0],
    afterFile: positional[1],
    ...comparison,
    warnings,
  }

  if (format === 'json') {
    writeJson(report)
  } else {
    const { added, removed, changed, reordered, unchanged } = report.summary
    const hasChanges = added + removed + changed + reordered > 0
    process.stdout.write('Glossary diff: ' + (hasChanges ? 'changes found' : 'no changes') + '\n')
    process.stdout.write(
      'Added: ' + added + '; removed: ' + removed + '; changed: ' + changed +
      '; reordered: ' + reordered + '; unchanged: ' + unchanged + '\n',
    )
    for (const entry of report.added) {
      process.stdout.write('+ ' + entry.source + ' -> ' + entry.target + '\n')
    }
    for (const entry of report.removed) {
      process.stdout.write('- ' + entry.source + ' -> ' + entry.target + '\n')
    }
    for (const entry of report.changed) {
      process.stdout.write('~ ' + entry.source + ' [' + entry.fields.join(', ') + ']\n')
    }
    for (const entry of report.reordered) {
      process.stdout.write('↕ ' + entry.source + ' (position ' +
        entry.beforePosition + ' -> ' + entry.afterPosition + ')\n')
    }
    diagnosticLines(report.warnings, 'WARN')
  }
  return 0
}


function literalPositions(source, term) {
  const escaped = Array.from(term, (character) => ".*+?^${}()|[]\\".includes(character) ? "\\" + character : character).join("")
  return [...source.matchAll(new RegExp(escaped, "giu"))].map((match) => match.index)
}

function explainMatches(sourceText, entries, languages) {
  const details = new Map()
  const candidates = []

  for (const entry of entries) {
    const item = {
      ...glossaryRecord(entry),
      decision: null,
      reason: null,
      matches: [],
    }
    details.set(entry.index, item)

    if (entry.enabled === false) {
      item.decision = 'skipped'
      item.reason = 'disabled'
      continue
    }
    if (!languageScopeMatches(entry.sourceLanguage ?? '*', languages.sourceLanguage ?? 'auto')) {
      item.decision = 'skipped'
      item.reason = 'source-language-mismatch'
      continue
    }
    if (!languageScopeMatches(entry.targetLanguage ?? '*', languages.targetLanguage ?? 'zh-Hans')) {
      item.decision = 'skipped'
      item.reason = 'target-language-mismatch'
      continue
    }

    const matches = [...sourceText.matchAll(entry.pattern)].map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
      entry,
    }))
    for (const match of matches) candidates.push(match)

    if (matches.length === 0) {
      const positions = literalPositions(sourceText, entry.source)
      if (positions.length === 0) {
        item.decision = 'not-matched'
        item.reason = 'not-found'
      } else if (
        entry.matchCase &&
        !positions.some((position) => sourceText.slice(position, position + entry.source.length) === entry.source)
      ) {
        item.decision = 'skipped'
        item.reason = 'case-mismatch'
        item.literalOccurrences = positions
      } else {
        item.decision = 'skipped'
        item.reason = 'word-boundary-mismatch'
        item.literalOccurrences = positions
      }
    }
  }

  candidates.sort(
    (left, right) =>
      left.start - right.start ||
      right.entry.priority - left.entry.priority ||
      (right.end - right.start) - (left.end - left.start) ||
      left.entry.index - right.entry.index,
  )

  const accepted = []
  let cursor = 0
  for (const candidate of candidates) {
    const item = details.get(candidate.entry.index)
    const occurrence = {
      start: candidate.start,
      end: candidate.end,
      text: candidate.text,
      target: candidate.entry.target,
    }
    if (candidate.start < cursor) {
      const blockers = accepted
        .filter((winner) => winner.start < candidate.end && winner.end > candidate.start)
        .map((winner) => ({
          source: winner.entry.source,
          index: winner.entry.index,
          start: winner.start,
          end: winner.end,
        }))
      item.matches.push({
        ...occurrence,
        decision: 'shadowed',
        reason: 'overlap',
        blockedBy: blockers,
      })
      continue
    }
    accepted.push(candidate)
    cursor = candidate.end
    item.matches.push({ ...occurrence, decision: 'applied', reason: null })
  }

  for (const item of details.values()) {
    if (item.matches.length === 0) continue
    const applied = item.matches.filter((match) => match.decision === 'applied').length
    const shadowed = item.matches.length - applied
    item.decision = applied > 0
      ? shadowed > 0 ? 'partially-applied' : 'applied'
      : 'shadowed'
    item.reason = shadowed > 0
      ? applied > 0 ? 'some-occurrences-overlapped' : 'overlapped-by-higher-precedence-rule'
      : null
  }

  return [...details.values()].sort((left, right) => left.index - right.index)
}

function explain(args) {
  const { positional, options } = parseOptions(
    args,
    new Set(['format', 'text', 'text-file', 'source-language', 'target-language']),
  )
  if (positional.length !== 1) throw new CliError('explain requires exactly one glossary file (use "-" for stdin).')
  if (Object.hasOwn(options, 'text') === Object.hasOwn(options, 'text-file')) {
    throw new CliError('explain requires exactly one of --text or --text-file.')
  }
  const format = options.format ?? 'text'
  if (!['text', 'json'].includes(format)) throw new CliError('--format must be "text" or "json".')

  const sourceLanguage = options['source-language'] ?? 'auto'
  const targetLanguage = options['target-language'] ?? 'zh-Hans'
  const languagePattern = /^(?:auto|[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/u
  if (!languagePattern.test(sourceLanguage)) {
    throw new CliError('--source-language must be "auto" or a BCP-47 language tag.')
  }
  if (!languagePattern.test(targetLanguage)) {
    throw new CliError('--target-language must be a BCP-47 language tag.')
  }
  if (positional[0] === '-' && options['text-file'] === '-') {
    throw new CliError('Only one explain input may use stdin ("-").')
  }

  const input = readTextFile(positional[0], 'glossary file')
  const validation = parseGlossaryImport(input)
  if (validation.errors.length > 0) {
    const report = {
      command: 'explain',
      valid: false,
      ...reportValidation(validation),
    }
    if (format === 'json') writeJson(report)
    else {
      process.stdout.write('Glossary is invalid; explanation was not generated.\n')
      diagnosticLines(validation.errors, 'ERROR')
      diagnosticLines(validation.warnings, 'WARN')
    }
    return 1
  }

  const sourceText = Object.hasOwn(options, 'text')
    ? options.text
    : readTextFile(options['text-file'], 'source text file')
  const languages = { sourceLanguage, targetLanguage }
  const rules = explainMatches(sourceText, validation.entries, languages)
  const segments = glossarySegments(sourceText, validation.entries, languages)
  const previewText = segments.map((segment) => segment.text).join('')
  const appliedOccurrences = rules.flatMap((rule) =>
    rule.matches.filter((match) => match.decision === 'applied'),
  )
  const shadowedOccurrences = rules.flatMap((rule) =>
    rule.matches.filter((match) => match.decision === 'shadowed'),
  )
  const report = {
    command: 'explain',
    valid: true,
    sourceLanguage,
    targetLanguage,
    providerCalls: 0,
    summary: {
      rules: rules.length,
      appliedRules: rules.filter((rule) => rule.decision === 'applied' || rule.decision === 'partially-applied').length,
      skippedRules: rules.filter((rule) => rule.decision === 'skipped').length,
      unmatchedRules: rules.filter((rule) => rule.decision === 'not-matched').length,
      appliedOccurrences: appliedOccurrences.length,
      shadowedOccurrences: shadowedOccurrences.length,
    },
    previewText,
    rules,
    warnings: validation.warnings,
    note: 'This is a local rule explanation and glossary-only preview. Unmatched source text stays unchanged; no machine translation or provider request is performed. Offsets are zero-based UTF-16 code units.',
  }

  if (format === 'json') {
    writeJson(report)
  } else {
    process.stdout.write('Glossary match explanation (no provider calls)\n')
    process.stdout.write('Language pair: ' + sourceLanguage + ' -> ' + targetLanguage + '\n')
    process.stdout.write(
      'Rules: ' + report.summary.rules +
      '; applied: ' + report.summary.appliedRules +
      '; skipped: ' + report.summary.skippedRules +
      '; unmatched: ' + report.summary.unmatchedRules + '\n',
    )
    for (const rule of rules) {
      process.stdout.write(
        '[' + rule.index + '] ' + rule.source + ' -> ' + rule.target +
        ': ' + rule.decision + (rule.reason ? ' (' + rule.reason + ')' : '') + '\n',
      )
      for (const match of rule.matches) {
        const blockers = match.blockedBy?.map((item) => item.source + ' [entry ' + item.index + ']')
        process.stdout.write(
          '    ' + match.decision + ' "' + match.text + '" @ ' + match.start + ':' + match.end +
          (blockers?.length ? '; blocked by ' + blockers.join(', ') : '') + '\n',
        )
      }
    }
    process.stdout.write('Preview:\n' + previewText + '\n')
    process.stdout.write('Unmatched source text is unchanged; this is not a machine translation.\n')
    diagnosticLines(validation.warnings, 'WARN')
  }
  return 0
}

 

const POLICY_SCHEMA_URI = 'https://raw.githubusercontent.com/jack-001-a/deepseek-harness-translation-pane/main/config/glossary-policy.schema.json'

const QUALITY_POLICY_FIELDS = new Set([
  'minCoveragePercent',
  'maxUnusedRules',
  'maxShadowedOccurrences',
  'maxPatternMismatchRules',
  'maxOutOfScopeRules',
])

function loadQualityPolicy(filePath) {
  const input = readTextFile(filePath, 'quality policy file')
  let parsed
  try {
    parsed = JSON.parse(input)
  } catch {
    throw new CliError('Quality policy must be valid JSON.')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.version !== 1) {
    throw new CliError('Quality policy must be an object with version: 1.')
  }
  for (const key of Object.keys(parsed)) {
    if (key !== 'version' && key !== '$schema' && !QUALITY_POLICY_FIELDS.has(key)) {
      throw new CliError('Unknown quality policy field: ' + key)
    }
  }
  if (Object.hasOwn(parsed, '$schema') && (
    typeof parsed.$schema !== 'string' ||
    parsed.$schema.trim().length === 0 ||
    parsed.$schema.length > 512 ||
    /[\u0000-\u001F\u007F]/u.test(parsed.$schema)
  )) {
    throw new CliError('Quality policy $schema must be a non-empty URI reference of at most 512 characters.')
  }
  const policy = {}
  for (const field of QUALITY_POLICY_FIELDS) {
    if (!Object.hasOwn(parsed, field)) continue
    const value = parsed[field]
    if (field === 'minCoveragePercent') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
        throw new CliError('minCoveragePercent must be a number between 0 and 100.')
      }
    } else if (!Number.isInteger(value) || value < 0 || value > 1000000) {
      throw new CliError(field + ' must be an integer between 0 and 1000000.')
    }
    policy[field] = value
  }
  if (Object.keys(policy).length === 0) {
    throw new CliError('Quality policy must define at least one threshold.')
  }
  return policy
}

function evaluateQualityPolicy(policy, summary) {
  if (!policy) return []
  const metrics = {
    minCoveragePercent: { metric: 'coveragePercent', actual: summary.coveragePercent, operator: '>=', threshold: policy.minCoveragePercent },
    maxUnusedRules: { metric: 'unusedRules', actual: summary.unusedRules, operator: '<=', threshold: policy.maxUnusedRules },
    maxShadowedOccurrences: { metric: 'shadowedOccurrences', actual: summary.shadowedOccurrences, operator: '<=', threshold: policy.maxShadowedOccurrences },
    maxPatternMismatchRules: { metric: 'patternMismatchRules', actual: summary.patternMismatchRules, operator: '<=', threshold: policy.maxPatternMismatchRules },
    maxOutOfScopeRules: { metric: 'outOfScopeRules', actual: summary.outOfScopeRules, operator: '<=', threshold: policy.maxOutOfScopeRules },
  }
  return Object.entries(metrics)
    .filter(([field]) => Object.hasOwn(policy, field))
    .map(([field, check]) => ({
      ...check,
      passed: field === 'minCoveragePercent'
        ? check.actual >= check.threshold
        : check.actual <= check.threshold,
    }))
}

function audit(args) {
  const { positional, options } = parseOptions(
    args,
    new Set(['format', 'text', 'text-file', 'source-language', 'target-language', 'fail-on', 'output', 'policy']),
  )
  if (positional.length !== 1) throw new CliError('audit requires exactly one glossary file (use "-" for stdin).')
  if (Object.hasOwn(options, 'text') === Object.hasOwn(options, 'text-file')) {
    throw new CliError('audit requires exactly one of --text or --text-file.')
  }
  const format = options.format ?? 'text'
  if (!['text', 'json', 'sarif'].includes(format)) throw new CliError('--format must be "text", "json" or "sarif".')
  const outputPath = options.output
  if (outputPath !== undefined && (outputPath.length === 0 || format !== 'sarif')) {
    throw new CliError('--output is supported only with --format sarif and requires a non-empty path.')
  }

  const failOn = options['fail-on'] ?? 'none'
  const allowedFailOn = new Set(['none', 'unused', 'shadowed', 'pattern-mismatch', 'out-of-scope', 'any'])
  if (!allowedFailOn.has(failOn)) {
    throw new CliError('--fail-on must be one of: none, unused, shadowed, pattern-mismatch, out-of-scope, any.')
  }

  const qualityPolicy = options.policy ? loadQualityPolicy(options.policy) : null
  const sourceLanguage = options['source-language'] ?? 'auto'
  const targetLanguage = options['target-language'] ?? 'zh-Hans'
  const languagePattern = /^(?:auto|[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/u
  if (!languagePattern.test(sourceLanguage)) {
    throw new CliError('--source-language must be "auto" or a BCP-47 language tag.')
  }
  if (!languagePattern.test(targetLanguage)) {
    throw new CliError('--target-language must be a BCP-47 language tag.')
  }
  if (positional[0] === '-' && options['text-file'] === '-') {
    throw new CliError('Only one audit input may use stdin ("-").')
  }

  const input = readTextFile(positional[0], 'glossary file')
  const validation = parseGlossaryImport(input)
  if (validation.errors.length > 0) {
    const report = {
      command: 'audit',
      valid: false,
      ...reportValidation(validation),
    }
    if (format === 'sarif') {
      const sarif = createGlossarySarifReport({
        glossaryFile: positional[0],
        sampleFile: options['text-file'],
        validation,
        ciPolicy: { failOn, passed: false, failureReasons: [{ category: 'invalid-glossary', count: validation.errors.length }] },
      })
      writeGlossarySarif(sarif, outputPath)
    } else if (format === 'json') writeJson(report)
    else {
      process.stdout.write('Glossary is invalid; audit was not generated.\n')
      diagnosticLines(validation.errors, 'ERROR')
      diagnosticLines(validation.warnings, 'WARN')
    }
    return 1
  }

  const sourceText = Object.hasOwn(options, 'text')
    ? options.text
    : readTextFile(options['text-file'], 'source text file')
  const languages = { sourceLanguage, targetLanguage }
  const rules = explainMatches(sourceText, validation.entries, languages)
  const ruleReports = rules.map((rule) => {
    const applied = rule.matches.filter((match) => match.decision === 'applied')
    const shadowed = rule.matches.filter((match) => match.decision === 'shadowed')
    let status
    let recommendation = null
    if (applied.length > 0 && shadowed.length > 0) {
      status = 'partially-active'
      recommendation = 'Some occurrences are shadowed; review the overlapping rules and priorities.'
    } else if (applied.length > 0) {
      status = 'active'
    } else if (rule.decision === 'shadowed') {
      status = 'fully-shadowed'
      recommendation = 'This rule never wins in the supplied sample; review its overlapping rules and priority.'
    } else if (rule.reason === 'disabled') {
      status = 'disabled'
      recommendation = 'This rule is disabled and does not participate in matching.'
    } else if (rule.reason === 'source-language-mismatch' || rule.reason === 'target-language-mismatch') {
      status = 'out-of-scope'
      recommendation = 'The configured language scope does not include this audit language pair.'
    } else if (rule.reason === 'case-mismatch' || rule.reason === 'word-boundary-mismatch') {
      status = 'pattern-mismatch'
      recommendation = 'Review matchCase and wholeWord settings against the supplied source sample.'
    } else {
      status = 'unused-in-sample'
      recommendation = 'The source term was not observed in this sample; check a representative corpus before removing it.'
    }
    return {
      entryNumber: rule.index + 1,
      source: rule.source,
      target: rule.target,
      sourceLanguage: rule.sourceLanguage,
      targetLanguage: rule.targetLanguage,
      matchCase: rule.matchCase,
      wholeWord: rule.wholeWord,
      enabled: rule.enabled,
      priority: rule.priority,
      occurrences: rule.matches.length,
      appliedOccurrences: applied.length,
      shadowedOccurrences: shadowed.length,
      status,
      reason: rule.reason,
      recommendation,
    }
  })
  const appliedOccurrences = rules.flatMap((rule) =>
    rule.matches.filter((match) => match.decision === 'applied'),
  )
  const shadowedOccurrences = rules.flatMap((rule) =>
    rule.matches.filter((match) => match.decision === 'shadowed'),
  )
  const sourceCodeUnits = sourceText.length
  const matchedSourceCodeUnits = appliedOccurrences.reduce(
    (total, match) => total + match.text.length,
    0,
  )
  const summary = {
    totalRules: ruleReports.length,
    activeRules: ruleReports.filter((rule) => rule.status === 'active' || rule.status === 'partially-active').length,
    fullyShadowedRules: ruleReports.filter((rule) => rule.status === 'fully-shadowed').length,
    unusedRules: ruleReports.filter((rule) => rule.status === 'unused-in-sample').length,
    disabledRules: ruleReports.filter((rule) => rule.status === 'disabled').length,
    outOfScopeRules: ruleReports.filter((rule) => rule.status === 'out-of-scope').length,
    patternMismatchRules: ruleReports.filter((rule) => rule.status === 'pattern-mismatch').length,
    candidateOccurrences: appliedOccurrences.length + shadowedOccurrences.length,
    appliedOccurrences: appliedOccurrences.length,
    shadowedOccurrences: shadowedOccurrences.length,
    sourceCodeUnits,
    matchedSourceCodeUnits,
    coveragePercent: sourceCodeUnits === 0
      ? 0
      : Math.round((matchedSourceCodeUnits / sourceCodeUnits) * 10000) / 100,
  }
  const failCategories = failOn === 'any'
    ? new Set(['unused', 'shadowed', 'pattern-mismatch', 'out-of-scope'])
    : failOn === 'none'
      ? new Set()
      : new Set([failOn])
  const allFindings = [
    { category: 'unused', count: summary.unusedRules, message: 'Glossary rules not observed in the supplied sample.' },
    { category: 'shadowed', count: summary.shadowedOccurrences, message: 'Glossary occurrences shadowed by higher-precedence matches.' },
    { category: 'pattern-mismatch', count: summary.patternMismatchRules, message: 'Rules blocked by case or word-boundary matching.' },
    { category: 'out-of-scope', count: summary.outOfScopeRules, message: 'Rules excluded by the requested language pair.' },
  ]
  const failureReasons = allFindings.filter((finding) =>
    failCategories.has(finding.category) && finding.count > 0,
  )
  const qualityChecks = evaluateQualityPolicy(qualityPolicy, summary)
  const qualityFailures = qualityChecks.filter((check) => !check.passed)
  const ciPolicy = {
    failOn,
    passed: failureReasons.length === 0 && qualityFailures.length === 0,
    failureReasons,
    qualityPolicy: qualityPolicy
      ? {
          file: options.policy,
          thresholds: qualityPolicy,
          checks: qualityChecks,
          failureReasons: qualityFailures,
        }
      : null,
  }
  const report = {
    command: 'audit',
    valid: true,
    sourceLanguage,
    targetLanguage,
    providerCalls: 0,
    summary,
    ciPolicy,
    rules: ruleReports,
    warnings: validation.warnings,
    note: 'Audit metrics describe only the supplied sample. Coverage is the percentage of UTF-16 source code units replaced by winning local glossary matches; shadowed occurrences are excluded. No machine translation or provider request is performed.',
  }

  if (format === 'sarif') {
    const sarif = createGlossarySarifReport({
      glossaryFile: positional[0],
      sampleFile: options['text-file'],
      sourceText,
      validation,
      rules,
      summary,
      ciPolicy,
    })
    writeGlossarySarif(sarif, outputPath)
  } else if (format === 'json') {
    writeJson(report)
  } else {
    process.stdout.write('Glossary coverage audit (no provider calls)\n')
    process.stdout.write('Language pair: ' + sourceLanguage + ' -> ' + targetLanguage + '\n')
    process.stdout.write(
      'Coverage: ' + summary.coveragePercent + '% (' + matchedSourceCodeUnits +
      '/' + sourceCodeUnits + ' source code units)\n',
    )
    process.stdout.write(
      'CI gate: --fail-on ' + failOn + ' => ' + (ciPolicy.passed ? 'PASS' : 'FAIL') + '\n',
    )
    if (qualityPolicy) {
      process.stdout.write(
        'Quality policy checks: ' + qualityChecks.filter((check) => check.passed).length + '/' + qualityChecks.length + ' passed\n',
      )
    }
    process.stdout.write(
      'Rules: ' + summary.totalRules +
      '; active: ' + summary.activeRules +
      '; fully shadowed: ' + summary.fullyShadowedRules +
      '; unused: ' + summary.unusedRules +
      '; out of scope: ' + summary.outOfScopeRules +
      '; disabled: ' + summary.disabledRules +
      '; pattern mismatch: ' + summary.patternMismatchRules + '\n',
    )
    for (const rule of ruleReports) {
      process.stdout.write(
        '[' + rule.entryNumber + '] ' + rule.source + ' -> ' + rule.target +
        ': ' + rule.status + ' (' + rule.appliedOccurrences + '/' + rule.occurrences +
        ' applied)' + (rule.reason ? ' [' + rule.reason + ']' : '') + '\n',
      )
    }
    diagnosticLines(validation.warnings, 'WARN')
  }
  return ciPolicy.passed ? 0 : 1
}


function fixGlossary(args) {
  const { positional, options } = parseOptions(args, new Set(['output', 'format']))
  if (positional.length !== 1 || positional[0] === '-') {
    throw new CliError('fix requires exactly one glossary file path; stdin is not supported.')
  }
  if (typeof options.output !== 'string' || options.output.length === 0 || options.output === '-') {
    throw new CliError('fix requires --output <new-file>; the source glossary is never overwritten.')
  }
  const format = options.format ?? 'text'
  if (!['text', 'json'].includes(format)) throw new CliError('--format must be "text" or "json".')
  const sourcePath = resolve(positional[0])
  const outputPath = resolve(options.output)
  if (sourcePath === outputPath) {
    throw new CliError('The output path must differ from the source glossary; in-place edits are not supported.')
  }

  const input = readTextFile(positional[0], 'glossary file')
  const validation = parseGlossaryImport(input)
  let inputEntryCount = null
  try {
    const parsed = JSON.parse(input)
    inputEntryCount = Array.isArray(parsed)
      ? parsed.length
      : Array.isArray(parsed?.glossary)
        ? parsed.glossary.length
        : null
  } catch {
    // The validator below owns malformed JSON diagnostics.
  }

  const duplicateCount = validation.warnings.filter((item) => item.code === 'duplicate-entry').length
  const overlapWarnings = validation.warnings.filter((item) => item.code === 'overlapping-terms')
  const report = {
    command: 'fix',
    valid: validation.errors.length === 0,
    sourceFile: positional[0],
    outputFile: options.output,
    inputEntryCount,
    outputEntryCount: validation.entries.length,
    removedDuplicates: duplicateCount,
    preservedOverlapWarnings: overlapWarnings.length,
    manualReviewRequired: overlapWarnings.length > 0,
    errors: validation.errors,
    warnings: validation.warnings,
    written: false,
  }

  if (validation.errors.length > 0) {
    if (format === 'json') writeJson(report)
    else {
      process.stdout.write('No output written: the glossary contains blocking errors.\n')
      diagnosticLines(validation.errors, 'ERROR')
      diagnosticLines(validation.warnings, 'WARN')
    }
    return 1
  }

  const serialized = serializeGlossaryExport(validation.entries) + '\n'
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, serialized, { encoding: 'utf8', flag: 'wx' })
  report.written = true

  if (format === 'json') {
    writeJson(report)
  } else {
    process.stdout.write('Wrote safe glossary normalization to ' + options.output + '\n')
    process.stdout.write('Entries: ' + inputEntryCount + ' -> ' + validation.entries.length + '\n')
    process.stdout.write('Removed duplicate entries: ' + duplicateCount + '\n')
    process.stdout.write('Overlapping rules preserved for review: ' + overlapWarnings.length + '\n')
    if (overlapWarnings.length > 0) {
      process.stdout.write('Manual review is still required for overlapping terms; no overlap rule was changed.\n')
    }
    diagnosticLines(overlapWarnings, 'WARN')
  }
  return 0
}



function initializeQualityPolicyCommand(args) {
  const { positional, options } = parseOptions(args, new Set(['output', 'preset', 'format']))
  if (positional.length !== 0) throw new CliError('policy init does not accept positional arguments.')
  if (typeof options.output !== 'string' || options.output.length === 0 || options.output === '-') {
    throw new CliError('policy init requires --output <new-file>.')
  }
  const format = options.format ?? 'text'
  if (!['text', 'json'].includes(format)) throw new CliError('--format must be "text" or "json".')

  const presetName = options.preset ?? 'balanced'
  const presets = {
    strict: {
      minCoveragePercent: 95,
      maxUnusedRules: 0,
      maxShadowedOccurrences: 0,
      maxPatternMismatchRules: 0,
      maxOutOfScopeRules: 0,
    },
    balanced: {
      minCoveragePercent: 80,
      maxUnusedRules: 2,
      maxShadowedOccurrences: 2,
      maxPatternMismatchRules: 0,
      maxOutOfScopeRules: 2,
    },
    permissive: {
      minCoveragePercent: 60,
      maxUnusedRules: 10,
      maxShadowedOccurrences: 5,
      maxPatternMismatchRules: 2,
      maxOutOfScopeRules: 5,
    },
  }
  if (!Object.hasOwn(presets, presetName)) {
    throw new CliError('--preset must be one of: strict, balanced, permissive.')
  }

  const outputPath = resolve(options.output)
  const document = {
    $schema: POLICY_SCHEMA_URI,
    version: 1,
    ...presets[presetName],
  }
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, JSON.stringify(document, null, 2) + '\n', {
    encoding: 'utf8',
    flag: 'wx',
  })

  const report = {
    command: 'policy init',
    preset: presetName,
    outputFile: options.output,
    schema: POLICY_SCHEMA_URI,
    thresholds: presets[presetName],
    written: true,
  }
  if (format === 'json') {
    writeJson(report)
  } else {
    process.stdout.write('Created ' + presetName + ' quality policy at ' + options.output + '\n')
    process.stdout.write('Edit thresholds for your project before enforcing them in CI.\n')
    process.stdout.write('Validate it with: dsh-translation-glossary policy validate ' + options.output + '\n')
  }
  return 0
}

function validateQualityPolicyCommand(args) {
  const { positional, options } = parseOptions(args, new Set(['format']))
  if (positional.length !== 1 || positional[0] === '-') {
    throw new CliError('policy validate requires exactly one file path; stdin is not supported.')
  }
  const format = options.format ?? 'text'
  if (!['text', 'json'].includes(format)) throw new CliError('--format must be "text" or "json".')

  const input = readTextFile(positional[0], 'quality policy file')
  let document
  try {
    document = JSON.parse(input)
  } catch {
    throw new CliError('Quality policy must be valid JSON.')
  }
  const thresholds = loadQualityPolicy(positional[0])
  const report = {
    command: 'policy validate',
    valid: true,
    policyFile: positional[0],
    version: document.version,
    schema: document.$schema ?? null,
    thresholdCount: Object.keys(thresholds).length,
    thresholds,
  }

  if (format === 'json') {
    writeJson(report)
  } else {
    process.stdout.write('Quality policy is valid (version ' + report.version + ').\n')
    process.stdout.write('Thresholds configured: ' + report.thresholdCount + '\n')
    if (report.schema) process.stdout.write('Schema: ' + report.schema + '\n')
    for (const [name, value] of Object.entries(thresholds)) {
      process.stdout.write(name + ': ' + value + '\n')
    }
  }
  return 0
}

function main(argv) {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--help')) {
    process.stdout.write(USAGE + '\n')
    return 0
  }
  const [command, ...args] = argv
  try {
    if (command === 'fix') return fixGlossary(args)
    if (command === 'policy') {
      if (args[0] === 'validate') return validateQualityPolicyCommand(args.slice(1))
      if (args[0] === 'init') return initializeQualityPolicyCommand(args.slice(1))
      throw new CliError('policy supports the validate and init subcommands.')
    }
    if (command === 'validate') return validate(args)
    if (command === 'preview') return preview(args)
    if (command === 'diff') return diff(args)
    if (command === 'explain') return explain(args)
    if (command === 'audit') return audit(args)
    throw new CliError('Unknown command: ' + command)
  } catch (error) {
    process.stderr.write('Error: ' + (error instanceof Error ? error.message : String(error)) + '\n')
    process.stderr.write(USAGE + '\n')
    return 2
  }
}

process.exitCode = main(process.argv.slice(2))

#!/usr/bin/env node
import { readFileSync } from 'node:fs'

import { glossarySegments, parseGlossaryImport } from '../src/host/glossary.js'

const USAGE = [
  'Usage:',
  '  dsh-translation-glossary validate [file|-] [--format text|json]',
  '  dsh-translation-glossary preview [file|-] (--text <text> | --text-file <path>)',
  '  dsh-translation-glossary diff <before-file|-> <after-file|-> [--format text|json]',
  '      [--source-language <tag|auto>] [--target-language <tag>] [--format text|json]',
  '',
  'Use "-" or omit the glossary file to read glossary JSON from stdin.',
  'Exit codes: 0 valid/success, 1 invalid glossary, 2 usage or file error.',
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

function main(argv) {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--help')) {
    process.stdout.write(USAGE + '\n')
    return 0
  }
  const [command, ...args] = argv
  try {
    if (command === 'validate') return validate(args)
    if (command === 'preview') return preview(args)
    if (command === 'diff') return diff(args)
    throw new CliError('Unknown command: ' + command)
  } catch (error) {
    process.stderr.write('Error: ' + (error instanceof Error ? error.message : String(error)) + '\n')
    process.stderr.write(USAGE + '\n')
    return 2
  }
}

process.exitCode = main(process.argv.slice(2))

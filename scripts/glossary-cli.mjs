#!/usr/bin/env node
import { readFileSync } from 'node:fs'

import { glossarySegments, parseGlossaryImport } from '../src/host/glossary.js'

const USAGE = [
  'Usage:',
  '  dsh-translation-glossary validate [file|-] [--format text|json]',
  '  dsh-translation-glossary preview [file|-] (--text <text> | --text-file <path>)',
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
    const location = Number.isInteger(item.index) ? 'entry ' + (item.index + 1) + ': ' : ''
    process.stdout.write(label + ' [' + item.code + '] ' + location + item.message + '\n')
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

function main(argv) {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--help')) {
    process.stdout.write(USAGE + '\n')
    return 0
  }
  const [command, ...args] = argv
  try {
    if (command === 'validate') return validate(args)
    if (command === 'preview') return preview(args)
    throw new CliError('Unknown command: ' + command)
  } catch (error) {
    process.stderr.write('Error: ' + (error instanceof Error ? error.message : String(error)) + '\n')
    process.stderr.write(USAGE + '\n')
    return 2
  }
}

process.exitCode = main(process.argv.slice(2))

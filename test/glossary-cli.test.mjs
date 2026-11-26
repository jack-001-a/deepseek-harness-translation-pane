import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../scripts/glossary-cli.mjs', import.meta.url))

function fixture(t, contents) {
  const directory = mkdtempSync(join(tmpdir(), 'translation-pane-glossary-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'glossary.json')
  writeFileSync(path, contents, 'utf8')
  return path
}

function runCli(args, input) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    input,
  })
}

test('validate reports a valid versioned glossary as machine-readable JSON', (t) => {
  const path = fixture(t, JSON.stringify({
    version: 1,
    glossary: [
      { source: 'API', target: '接口', sourceLanguage: 'en', targetLanguage: 'zh-Hans' },
      { source: 'DeepSeek', target: '深度求索' },
    ],
  }))
  const result = runCli(['validate', path, '--format', 'json'])

  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.command, 'validate')
  assert.equal(report.valid, true)
  assert.equal(report.entryCount, 2)
  assert.deepEqual(report.errors, [])
})

test('validate exits 1 and identifies conflicting duplicate terms', (t) => {
  const path = fixture(t, JSON.stringify([
    { source: 'API', target: '接口' },
    { source: 'API', target: '应用程序接口' },
  ]))
  const result = runCli(['validate', path, '--format=json'])

  assert.equal(result.status, 1)
  const report = JSON.parse(result.stdout)
  assert.equal(report.valid, false)
  assert.ok(report.errors.some((item) => item.code === 'conflicting-entry'))
})

test('validate reads glossary JSON from stdin when the file argument is omitted', () => {
  const result = runCli(['validate', '--format', 'json'], '[{"source":"API","target":"接口"}]')

  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).entryCount, 1)
})

test('preview performs local replacements, honors boundaries and never calls a provider', (t) => {
  const path = fixture(t, JSON.stringify({
    version: 1,
    glossary: [
      { source: 'API', target: '接口', sourceLanguage: 'en', targetLanguage: 'zh-Hans', wholeWord: true },
      { source: 'DeepSeek API', target: '深度求索接口', sourceLanguage: 'en', targetLanguage: 'zh-Hans' },
    ],
  }))
  const result = runCli([
    'preview', path,
    '--source-language', 'en',
    '--target-language', 'zh-Hans',
    '--text', 'DeepSeek API; APIs; API',
    '--format', 'json',
  ])

  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.providerCalls, 0)
  assert.equal(report.previewText, '深度求索接口; APIs; 接口')
  assert.deepEqual(report.localReplacements, ['深度求索接口', '接口'])
  assert.ok(report.segments.some((segment) => segment.kind === 'unmatched-source' && segment.text.includes('APIs')))
  assert.match(report.note, /no machine translation/i)
})

test('preview can read source text from stdin with --text-file -', (t) => {
  const path = fixture(t, '[{"source":"API","target":"接口","sourceLanguage":"en","targetLanguage":"zh-Hans"}]')
  const result = runCli([
    'preview', path,
    '--source-language', 'en',
    '--target-language', 'zh-Hans',
    '--text-file', '-',
    '--format', 'json',
  ], 'API gateway')

  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).previewText, '接口 gateway')
})

test('preview respects language scopes and leaves non-matching terms unchanged', (t) => {
  const path = fixture(t, JSON.stringify([
    { source: 'API', target: '接口', sourceLanguage: 'en', targetLanguage: 'zh-Hans' },
  ]))
  const result = runCli([
    'preview', path,
    '--source-language', 'en',
    '--target-language', 'fr',
    '--text', 'API',
    '--format', 'json',
  ])

  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.previewText, 'API')
  assert.equal(report.localReplacementCount, 0)
})

test('diff reports added, removed and modified entries with structured fields', (t) => {
  const before = fixture(t, JSON.stringify([
    { source: 'API', target: '接口' },
    { source: 'DeepSeek', target: '深度求索' },
    { source: 'OpenAI', target: '开放人工智能' },
  ]))
  const after = fixture(t, JSON.stringify({
    version: 1,
    glossary: [
      { source: 'API', target: '应用程序接口', priority: 20, enabled: false },
      { source: 'DeepSeek', target: '深度求索', wholeWord: true },
      { source: 'Gemini', target: '双子座' },
    ],
  }))
  const result = runCli(['diff', before, after, '--format', 'json'])

  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.valid, true)
  assert.deepEqual(report.summary, {
    added: 1, removed: 1, changed: 2, reordered: 0, unchanged: 0,
  })
  assert.equal(report.added[0].source, 'Gemini')
  assert.equal(report.removed[0].source, 'OpenAI')
  assert.deepEqual(report.changed.find((entry) => entry.source === 'API').fields, [
    'target', 'enabled', 'priority',
  ])
  assert.deepEqual(report.changed.find((entry) => entry.source === 'DeepSeek').fields, [
    'wholeWord',
  ])
})

test('diff is stable across legacy arrays and versioned JSON exports', (t) => {
  const before = fixture(t, '[{"source":"API","target":"接口"}]')
  const after = fixture(t, '{"version":1,"glossary":[{"source":"API","target":"接口"}]}')
  const result = runCli(['diff', before, after, '--format=json'])

  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout).summary, {
    added: 0, removed: 0, changed: 0, reordered: 0, unchanged: 1,
  })
})

test('diff reports relative rule reordering without treating insertion as a reorder', (t) => {
  const before = fixture(t, JSON.stringify([
    { source: 'Alpha', target: '甲' },
    { source: 'Beta', target: '乙' },
    { source: 'Gamma', target: '丙' },
  ]))
  const after = fixture(t, JSON.stringify([
    { source: 'New', target: '新' },
    { source: 'Beta', target: '乙' },
    { source: 'Alpha', target: '甲' },
    { source: 'Gamma', target: '丙' },
  ]))
  const result = runCli(['diff', before, after, '--format', 'json'])

  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.summary.added, 1)
  assert.equal(report.summary.reordered, 2)
  assert.deepEqual(report.reordered.map((entry) => entry.source), ['Beta', 'Alpha'])
  assert.equal(report.summary.unchanged, 1)
})

test('diff reports validation failures against the correct input and exits 1', (t) => {
  const before = fixture(t, '[{"source":"API","target":"接口"}]')
  const after = fixture(t, '[{"source":"API","target":"接口"},{"source":"API","target":"应用程序接口"}]')
  const result = runCli(['diff', before, after, '--format', 'json'])

  assert.equal(result.status, 1)
  const report = JSON.parse(result.stdout)
  assert.equal(report.valid, false)
  assert.ok(report.errors.some((item) => item.side === 'after' && item.code === 'conflicting-entry'))
})

test('diff supports one stdin input and rejects two stdin inputs', (t) => {
  const before = fixture(t, '[{"source":"API","target":"接口"}]')
  const valid = runCli(['diff', before, '-', '--format', 'json'], '[{"source":"API","target":"接口"}]')
  const invalid = runCli(['diff', '-', '-', '--format', 'json'], '[]')

  assert.equal(valid.status, 0, valid.stderr)
  assert.equal(JSON.parse(valid.stdout).summary.unchanged, 1)
  assert.equal(invalid.status, 2)
  assert.match(invalid.stderr, /Only one diff input/)
})

test('explain shows applied and shadowed occurrences using Host precedence', (t) => {
  const path = fixture(t, JSON.stringify([
    { source: 'DeepSeek', target: '深度求索', sourceLanguage: 'en', targetLanguage: 'zh-Hans' },
    { source: 'Seek API', target: '搜索接口', sourceLanguage: 'en', targetLanguage: 'zh-Hans', wholeWord: false, priority: 100 },
    { source: 'API', target: '接口', sourceLanguage: 'en', targetLanguage: 'zh-Hans' },
  ]))
  const result = runCli([
    'explain', path,
    '--source-language', 'en',
    '--target-language', 'zh-Hans',
    '--text', 'DeepSeek API and API',
    '--format', 'json',
  ])

  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.providerCalls, 0)
  assert.equal(report.previewText, '深度求索 接口 and 接口')
  assert.equal(report.summary.appliedOccurrences, 3)
  const shadowed = report.rules.find((rule) => rule.source === 'Seek API')
  assert.equal(shadowed.decision, 'shadowed')
  assert.equal(shadowed.matches[0].reason, 'overlap')
  assert.equal(shadowed.matches[0].blockedBy[0].source, 'DeepSeek')
  assert.match(report.note, /UTF-16 code units/)
})

test('explain diagnoses disabled, language, case, boundary and missing rules', (t) => {
  const path = fixture(t, JSON.stringify([
    { source: 'Legacy', target: '旧版', enabled: false },
    { source: 'API', target: '接口', sourceLanguage: 'fr', targetLanguage: 'zh-Hans' },
    { source: 'HTTP', target: '超文本传输协议', sourceLanguage: 'en', targetLanguage: 'fr' },
    { source: 'DeepSeek', target: '深度求索', sourceLanguage: 'en', targetLanguage: 'zh-Hans', matchCase: true },
    { source: 'API', target: '接口', sourceLanguage: 'en', targetLanguage: 'zh-Hans', wholeWord: true },
    { source: 'Missing', target: '缺失', sourceLanguage: 'en', targetLanguage: 'zh-Hans' },
  ]))
  const result = runCli([
    'explain', path,
    '--source-language', 'en',
    '--target-language', 'zh-Hans',
    '--text', 'legacy deepseek APIs HTTP',
    '--format', 'json',
  ])

  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  const reasonBySource = Object.fromEntries(report.rules.map((rule) => [rule.source, rule.reason]))
  assert.equal(reasonBySource.Legacy, 'disabled')
  assert.equal(reasonBySource.API, 'word-boundary-mismatch')
  assert.equal(reasonBySource.HTTP, 'target-language-mismatch')
  assert.equal(reasonBySource.DeepSeek, 'case-mismatch')
  assert.equal(reasonBySource.Missing, 'not-found')
  assert.equal(report.previewText, 'legacy deepseek APIs HTTP')
  assert.equal(report.summary.appliedOccurrences, 0)
})

test('explain separates source-language mismatch and supports text-file input', (t) => {
  const glossary = fixture(t, '[{"source":"API","target":"接口","sourceLanguage":"ja","targetLanguage":"zh-Hans"}]')
  const textPath = fixture(t, 'API gateway')
  const result = runCli([
    'explain', glossary,
    '--source-language', 'en',
    '--target-language', 'zh-Hans',
    '--text-file', textPath,
    '--format', 'json',
  ])

  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.rules[0].reason, 'source-language-mismatch')
  assert.equal(report.previewText, 'API gateway')
})

test('explain rejects two stdin inputs and invalid source arguments', (t) => {
  const result = runCli([
    'explain', '-', '--text-file', '-', '--format', 'json',
  ], '[]')
  const missingText = runCli(['explain', '-'])

  assert.equal(result.status, 2)
  assert.match(result.stderr, /Only one explain input/)
  assert.equal(missingText.status, 2)
  assert.match(missingText.stderr, /exactly one of --text/)
})


test('audit reports applied coverage, shadowed and unused rules with machine-readable metrics', (t) => {
  const path = fixture(t, JSON.stringify([
    { source: 'API', target: '接口', sourceLanguage: 'en', targetLanguage: 'zh-Hans', priority: 10 },
    { source: 'API Gateway', target: 'API 网关', sourceLanguage: 'en', targetLanguage: 'zh-Hans' },
    { source: 'Obsolete', target: '旧版', sourceLanguage: 'en', targetLanguage: 'zh-Hans' },
    { source: 'Legacy', target: '遗留', sourceLanguage: 'en', targetLanguage: 'zh-Hans', enabled: false },
  ]))
  const sourceText = 'API Gateway and API APIs'
  const result = runCli([
    'audit', path,
    '--source-language', 'en',
    '--target-language', 'zh-Hans',
    '--text', sourceText,
    '--format', 'json',
  ])

  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.command, 'audit')
  assert.equal(report.providerCalls, 0)
  assert.equal(report.summary.totalRules, 4)
  assert.equal(report.summary.activeRules, 1)
  assert.equal(report.summary.fullyShadowedRules, 1)
  assert.equal(report.summary.unusedRules, 1)
  assert.equal(report.summary.disabledRules, 1)
  assert.equal(report.summary.appliedOccurrences, 2)
  assert.equal(report.summary.shadowedOccurrences, 1)
  assert.equal(report.summary.matchedSourceCodeUnits, 6)
  assert.equal(report.summary.coveragePercent, Math.round((6 / sourceText.length) * 10000) / 100)
  assert.equal(report.rules.find((rule) => rule.source === 'API Gateway').status, 'fully-shadowed')
  assert.equal(report.rules.find((rule) => rule.source === 'Obsolete').status, 'unused-in-sample')
  assert.equal(report.rules.find((rule) => rule.source === 'Legacy').status, 'disabled')
  assert.match(report.note, /supplied sample/)
})

test('audit distinguishes out-of-scope rules from case and boundary mismatches', (t) => {
  const path = fixture(t, JSON.stringify([
    { source: 'API', target: '接口', sourceLanguage: 'ja', targetLanguage: 'zh-Hans' },
    { source: 'HTTP', target: '超文本传输协议', sourceLanguage: 'en', targetLanguage: 'zh-Hans', wholeWord: true },
    { source: 'DeepSeek', target: '深度求索', sourceLanguage: 'en', targetLanguage: 'zh-Hans', matchCase: true },
  ]))
  const result = runCli([
    'audit', path,
    '--source-language', 'en',
    '--target-language', 'zh-Hans',
    '--text', 'HTTPs deepseek',
    '--format', 'json',
  ])

  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  const bySource = Object.fromEntries(report.rules.map((rule) => [rule.source, rule]))
  assert.equal(bySource.API.status, 'out-of-scope')
  assert.equal(bySource.HTTP.status, 'pattern-mismatch')
  assert.equal(bySource.HTTP.reason, 'word-boundary-mismatch')
  assert.equal(bySource.DeepSeek.status, 'pattern-mismatch')
  assert.equal(bySource.DeepSeek.reason, 'case-mismatch')
  assert.equal(report.summary.coveragePercent, 0)
})

test('audit reads sample text from stdin but never permits both inputs to consume stdin', (t) => {
  const glossary = fixture(t, '[{"source":"API","target":"接口"}]')
  const fromStdin = runCli(['audit', glossary, '--text-file', '-', '--format', 'json'], 'API gateway')
  const bothStdin = runCli(['audit', '-', '--text-file', '-', '--format', 'json'], '[]')
  const missingSample = runCli(['audit', glossary])

  assert.equal(fromStdin.status, 0, fromStdin.stderr)
  assert.equal(JSON.parse(fromStdin.stdout).summary.appliedOccurrences, 1)
  assert.equal(bothStdin.status, 2)
  assert.match(bothStdin.stderr, /Only one audit input/)
  assert.equal(missingSample.status, 2)
  assert.match(missingSample.stderr, /exactly one of --text/)
})


test('audit text output and CLI help use readable line breaks and list the command', (t) => {
  const path = fixture(t, '[{"source":"API","target":"接口"}]')
  const output = runCli(['audit', path, '--text', 'API gateway'])
  const help = runCli(['--help'])

  assert.equal(output.status, 0, output.stderr)
  assert.match(output.stdout, /Glossary coverage audit/)
  assert.ok(output.stdout.includes('Coverage: 27.27%'))
  assert.ok(output.stdout.includes(String.fromCharCode(10)))
  assert.equal(help.status, 0)
  assert.match(help.stdout, /dsh-translation-glossary audit/)
  assert.equal(help.stdout.includes(String.fromCharCode(92) + 'n'), false)
})


test('preview refuses malformed language tags and unknown commands with exit code 2', (t) => {
  const path = fixture(t, '[{"source":"API","target":"接口"}]')
  const badLanguage = runCli(['preview', path, '--text', 'API', '--source-language', 'en&to=xx'])
  const unknownCommand = runCli(['remove', path])

  assert.equal(badLanguage.status, 2)
  assert.match(badLanguage.stderr, /BCP-47/)
  assert.equal(unknownCommand.status, 2)
  assert.match(unknownCommand.stderr, /Unknown command/)
})

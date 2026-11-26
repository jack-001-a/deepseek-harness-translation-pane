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

test('preview refuses malformed language tags and unknown commands with exit code 2', (t) => {
  const path = fixture(t, '[{"source":"API","target":"接口"}]')
  const badLanguage = runCli(['preview', path, '--text', 'API', '--source-language', 'en&to=xx'])
  const unknownCommand = runCli(['remove', path])

  assert.equal(badLanguage.status, 2)
  assert.match(badLanguage.stderr, /BCP-47/)
  assert.equal(unknownCommand.status, 2)
  assert.match(unknownCommand.stderr, /Unknown command/)
})

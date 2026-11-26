import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../scripts/glossary-cli.mjs', import.meta.url))

function fixture(t, contents, name = 'fixture.txt') {
  const directory = mkdtempSync(join(tmpdir(), 'translation-pane-sarif-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents, 'utf8')
  return path
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
}

test('audit emits SARIF 2.1.0 with stable rules and Unicode-correct source regions', (t) => {
  const glossary = fixture(t, JSON.stringify([
    { source: 'API', target: '接口', sourceLanguage: 'en', targetLanguage: 'zh-Hans', priority: 10 },
    { source: 'API Gateway', target: 'API 网关', sourceLanguage: 'en', targetLanguage: 'zh-Hans' },
    { source: 'Missing', target: '缺失', sourceLanguage: 'en', targetLanguage: 'zh-Hans' },
  ]), 'glossary.json')
  const source = fixture(t, '😀 heading\r\nAPI Gateway', 'source.txt')
  const result = runCli([
    'audit', glossary, '--source-language', 'en', '--target-language', 'zh-Hans',
    '--text-file', source, '--format', 'sarif',
  ])

  assert.equal(result.status, 0, result.stderr)
  const sarif = JSON.parse(result.stdout)
  assert.equal(sarif.version, '2.1.0')
  assert.equal(sarif.runs[0].columnKind, 'unicodeCodePoints')
  assert.ok(sarif.runs[0].tool.driver.rules.some((rule) => rule.id === 'glossary-shadowed-match'))
  const shadowed = sarif.runs[0].results.find((item) => item.ruleId === 'glossary-shadowed-match')
  assert.ok(shadowed)
  assert.equal(shadowed.level, 'warning')
  const region = shadowed.locations[0].physicalLocation.region
  assert.equal(region.startLine, 2)
  assert.equal(region.startColumn, 1)
  assert.equal(region.charOffset, 11)
  assert.equal(region.charLength, 11)
  assert.ok(sarif.runs[0].results.some((item) => item.ruleId === 'glossary-unused-term'))
})

test('audit writes SARIF before returning a selected policy failure', (t) => {
  const glossary = fixture(t, '[{"source":"Unused","target":"未使用","sourceLanguage":"en","targetLanguage":"zh-Hans"}]', 'glossary.json')
  const source = fixture(t, 'Only common words', 'source.txt')
  const reportPath = fixture(t, '', 'reports/glossary.sarif')
  const result = runCli([
    'audit', glossary, '--source-language', 'en', '--target-language', 'zh-Hans',
    '--text-file', source, '--fail-on', 'unused', '--format', 'sarif', '--output', reportPath,
  ])
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  const sarif = JSON.parse(readFileSync(reportPath, 'utf8'))
  assert.equal(sarif.runs[0].properties.ciPolicy.passed, false)
  assert.ok(sarif.runs[0].results.some((item) => item.ruleId === 'glossary-unused-term'))
})

test('invalid glossary imports also produce SARIF error results', (t) => {
  const glossary = fixture(t, '[{"source":"API","target":"接口"},{"source":"API","target":"应用程序接口"}]', 'glossary.json')
  const source = fixture(t, 'API', 'source.txt')
  const result = runCli(['audit', glossary, '--text-file', source, '--format', 'sarif'])
  assert.equal(result.status, 1)
  const sarif = JSON.parse(result.stdout)
  assert.ok(sarif.runs[0].results.some((item) => item.ruleId === 'glossary-invalid-entry' && item.level === 'error'))
  assert.equal(sarif.runs[0].invocations[0].executionSuccessful, true)
})

test('audit rejects output files for non-SARIF formats', (t) => {
  const glossary = fixture(t, '[]', 'glossary.json')
  const source = fixture(t, 'No configured terms', 'source.txt')
  const result = runCli(['audit', glossary, '--text-file', source, '--format', 'json', '--output', fixture(t, '', 'report.json')])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /--output is supported only with --format sarif/)
})

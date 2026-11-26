import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ACTION_RUNNER = fileURLToPath(new URL('../scripts/run-glossary-action.mjs', import.meta.url))

test('composite action runner exposes SARIF and the selected policy result', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'translation-pane-action-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const glossary = join(directory, 'glossary.json')
  const source = join(directory, 'source.txt')
  const output = join(directory, 'github-output')
  const summary = join(directory, 'step-summary.md')
  const policy = join(directory, 'quality-policy.json')
  const sarif = join(directory, 'reports', 'glossary.sarif')
  writeFileSync(glossary, '[{"source":"Missing","target":"缺失"}]', 'utf8')
  writeFileSync(source, 'Ordinary text', 'utf8')
  writeFileSync(output, '', 'utf8')
  writeFileSync(summary, '', 'utf8')
  writeFileSync(policy, JSON.stringify({ version: 1, minCoveragePercent: 90, maxUnusedRules: 0 }), 'utf8')

  const result = spawnSync(process.execPath, [ACTION_RUNNER], {
    encoding: 'utf8',
    env: {
      ...process.env, GITHUB_OUTPUT: output,
      INPUT_GLOSSARY_FILE: glossary, INPUT_SOURCE_FILE: source,
      INPUT_SOURCE_LANGUAGE: 'en', INPUT_TARGET_LANGUAGE: 'zh-Hans',
      INPUT_FAIL_ON: 'any', INPUT_SARIF_FILE: sarif,
      INPUT_POLICY_FILE: policy,
      GITHUB_STEP_SUMMARY: summary,
    },
  })
  assert.equal(result.status, 0, result.stderr)
  const values = readFileSync(output, 'utf8')
  assert.match(values, /sarif-file=/)
  assert.match(values, /exit-code=1/)
  assert.match(values, /audit-passed=false/)
  assert.match(values, /finding-count=1/)
  assert.match(values, /annotation-count=1/)
  assert.match(result.stdout, /::warning file=/)
  const jobSummary = readFileSync(summary, 'utf8')
  assert.match(jobSummary, /## DSH glossary audit/)
  assert.match(jobSummary, /Coverage:/)
  assert.match(jobSummary, /Quality policy: 0\/2 thresholds passed/)
  assert.match(jobSummary, /glossary-unused-term/)
  const sarifReport = JSON.parse(readFileSync(sarif, 'utf8'))
  assert.equal(sarifReport.version, '2.1.0')
  assert.equal(sarifReport.runs[0].properties.ciPolicy.qualityPolicy.checks.length, 2)
})

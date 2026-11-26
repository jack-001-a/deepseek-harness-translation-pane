import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  assert.match(values, /policy-diff-passed=true/)
  assert.match(values, /policy-diff-exit-code=0/)
  assert.match(values, /policy-diff-failure-count=0/)
  assert.match(result.stdout, /::warning file=/)
  const jobSummary = readFileSync(summary, 'utf8')
  assert.match(jobSummary, /## DSH glossary audit/)
  assert.match(jobSummary, /Coverage:/)
  assert.match(jobSummary, /0\/2 thresholds passed/)
  assert.match(jobSummary, /glossary-unused-term/)
  const sarifReport = JSON.parse(readFileSync(sarif, 'utf8'))
  assert.equal(sarifReport.version, '2.1.0')
  assert.equal(sarifReport.runs[0].properties.ciPolicy.qualityPolicy.checks.length, 2)
})

test('composite action runner summarizes policy changes from the selected Git base commit', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'translation-pane-policy-action-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const configDirectory = join(directory, 'config')
  mkdirSync(configDirectory, { recursive: true })
  const policyPath = join(configDirectory, 'glossary-policy.json')
  const glossary = join(directory, 'glossary.json')
  const source = join(directory, 'source.txt')
  const output = join(directory, 'github-output')
  const summary = join(directory, 'step-summary.md')
  const sarif = join(directory, 'glossary.sarif')
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }

  git('init', '-q')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.invalid')
  writeFileSync(policyPath, JSON.stringify({
    version: 1,
    minCoveragePercent: 80,
    maxUnusedRules: 2,
  }), 'utf8')
  git('add', '--', 'config/glossary-policy.json')
  git('commit', '-q', '-m', 'base policy')
  const baseRef = git('rev-parse', 'HEAD')

  writeFileSync(policyPath, JSON.stringify({
    $schema: './glossary-policy.schema.json',
    version: 1,
    minCoveragePercent: 70,
    maxUnusedRules: 2,
    maxShadowedOccurrences: 1,
  }), 'utf8')
  writeFileSync(glossary, '[{"source":"API","target":"接口"}]', 'utf8')
  writeFileSync(source, 'API', 'utf8')
  writeFileSync(output, '', 'utf8')
  writeFileSync(summary, '', 'utf8')

  const result = spawnSync(process.execPath, [ACTION_RUNNER], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env, GITHUB_OUTPUT: output,
      INPUT_GLOSSARY_FILE: glossary, INPUT_SOURCE_FILE: source,
      INPUT_SOURCE_LANGUAGE: 'en', INPUT_TARGET_LANGUAGE: 'zh-Hans',
      INPUT_FAIL_ON: 'none', INPUT_SARIF_FILE: sarif,
      INPUT_POLICY_FILE: 'config/glossary-policy.json',
      INPUT_POLICY_BASE_REF: baseRef,
      INPUT_POLICY_DIFF_FAIL_ON: 'none',
      GITHUB_STEP_SUMMARY: summary,
    },
  })
  assert.equal(result.status, 0, result.stderr)
  const values = readFileSync(output, 'utf8')
  assert.match(values, /policy-diff-count=2/)
  assert.match(values, /policy-diff-added-count=1/)
  assert.match(values, /policy-diff-removed-count=0/)
  assert.match(values, /policy-diff-changed-count=1/)
  assert.match(values, /policy-diff-tightened-count=1/)
  assert.match(values, /policy-diff-relaxed-count=1/)
  assert.match(values, /policy-schema-changed=true/)
  const jobSummary = readFileSync(summary, 'utf8')
  assert.match(jobSummary, /## DSH quality policy diff/)
  assert.match(jobSummary, /minCoveragePercent/)
  assert.match(jobSummary, /80/)
  assert.match(jobSummary, /70/)
  assert.match(jobSummary, /maxShadowedOccurrences/)
  assert.match(jobSummary, /tightened, 1 relaxed/)
  assert.match(jobSummary, /Impact \| Change/)
  assert.match(jobSummary, /JSON Schema reference/)
  assert.match(jobSummary, /selected policy diff gate passed/)

  writeFileSync(output, '', 'utf8')
  writeFileSync(summary, '', 'utf8')
  const gated = spawnSync(process.execPath, [ACTION_RUNNER], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env, GITHUB_OUTPUT: output,
      INPUT_GLOSSARY_FILE: glossary, INPUT_SOURCE_FILE: source,
      INPUT_SOURCE_LANGUAGE: 'en', INPUT_TARGET_LANGUAGE: 'zh-Hans',
      INPUT_FAIL_ON: 'none', INPUT_SARIF_FILE: sarif,
      INPUT_POLICY_FILE: 'config/glossary-policy.json',
      INPUT_POLICY_BASE_REF: baseRef,
      INPUT_POLICY_DIFF_FAIL_ON: 'relaxed',
      GITHUB_STEP_SUMMARY: summary,
    },
  })
  assert.equal(gated.status, 0, gated.stderr)
  const gatedOutputs = readFileSync(output, 'utf8')
  assert.match(gatedOutputs, /policy-diff-passed=false/)
  assert.match(gatedOutputs, /policy-diff-exit-code=1/)
  assert.match(gatedOutputs, /policy-diff-failure-count=1/)
  const gatedSummary = readFileSync(summary, 'utf8')
  assert.match(gatedSummary, /Review gate:\*\* FAIL/)
  assert.match(gatedSummary, /selected policy diff gate failed/)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REVIEW_RUNNER = fileURLToPath(new URL('../scripts/run-glossary-policy-review-action.mjs', import.meta.url))

function createRepository(t, currentPolicy) {
  const directory = mkdtempSync(join(tmpdir(), 'translation-pane-policy-review-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const config = join(directory, 'config')
  mkdirSync(config, { recursive: true })
  const policy = join(config, 'glossary-policy.json')
  const output = join(directory, 'github-output')
  const summary = join(directory, 'step-summary.md')
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }

  git('init', '-q')
  git('config', 'user.name', 'Policy Review Test')
  git('config', 'user.email', 'policy-review@example.invalid')
  writeFileSync(policy, JSON.stringify({
    version: 1,
    minCoveragePercent: 80,
    maxUnusedRules: 2,
  }), 'utf8')
  git('add', '--', 'config/glossary-policy.json')
  git('commit', '-q', '-m', 'baseline policy')
  const baseRef = git('rev-parse', 'HEAD')
  writeFileSync(policy, JSON.stringify(currentPolicy), 'utf8')
  writeFileSync(output, '', 'utf8')
  writeFileSync(summary, '', 'utf8')
  return { directory, policy, output, summary, baseRef }
}

function runReview(fixture, failOn) {
  return spawnSync(process.execPath, [REVIEW_RUNNER], {
    cwd: fixture.directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_OUTPUT: fixture.output,
      GITHUB_STEP_SUMMARY: fixture.summary,
      INPUT_POLICY_FILE: 'config/glossary-policy.json',
      INPUT_POLICY_BASE_REF: fixture.baseRef,
      INPUT_FAIL_ON: failOn,
    },
  })
}

test('standalone policy review action reports threshold impact and passes a tightened-only change', (t) => {
  const fixture = createRepository(t, {
    $schema: './glossary-policy.schema.json',
    version: 1,
    minCoveragePercent: 90,
    maxUnusedRules: 2,
  })
  const result = runReview(fixture, 'relaxed')
  assert.equal(result.status, 0, result.stderr)

  const outputs = readFileSync(fixture.output, 'utf8')
  assert.match(outputs, /policy-diff-count=1/)
  assert.match(outputs, /policy-diff-added-count=0/)
  assert.match(outputs, /policy-diff-removed-count=0/)
  assert.match(outputs, /policy-diff-changed-count=1/)
  assert.match(outputs, /policy-diff-tightened-count=1/)
  assert.match(outputs, /policy-diff-relaxed-count=0/)
  assert.match(outputs, /policy-diff-passed=true/)
  assert.match(outputs, /policy-diff-exit-code=0/)
  assert.match(outputs, /policy-diff-failure-count=0/)
  assert.match(outputs, /policy-schema-changed=true/)
  assert.match(outputs, new RegExp('policy-diff-base-commit=' + fixture.baseRef))

  const summary = readFileSync(fixture.summary, 'utf8')
  assert.match(summary, /## DSH quality policy review/)
  assert.match(summary, /Review gate:\*\* PASS/)
  assert.match(summary, /80/)
  assert.match(summary, /90/)
  assert.match(summary, /tightened/)
  assert.match(summary, /JSON Schema reference/)
  assert.ok(summary.split(String.fromCharCode(10)).includes('| Threshold | Base value | Current value | Impact | Change |'))
})

test('standalone policy review action fails relaxed changes but still writes outputs and summary', (t) => {
  const fixture = createRepository(t, {
    version: 1,
    minCoveragePercent: 70,
    maxUnusedRules: 2,
  })
  const result = runReview(fixture, 'relaxed')
  assert.equal(result.status, 1)

  const outputs = readFileSync(fixture.output, 'utf8')
  assert.match(outputs, /policy-diff-count=1/)
  assert.match(outputs, /policy-diff-tightened-count=0/)
  assert.match(outputs, /policy-diff-relaxed-count=1/)
  assert.match(outputs, /policy-diff-passed=false/)
  assert.match(outputs, /policy-diff-exit-code=1/)
  assert.match(outputs, /policy-diff-failure-count=1/)

  const summary = readFileSync(fixture.summary, 'utf8')
  assert.match(summary, /Review gate:\*\* FAIL/)
  assert.match(summary, /selected policy review gate failed/)
  assert.match(summary, /Current value/)
  assert.ok(summary.split(String.fromCharCode(10)).includes('| Threshold | Base value | Current value | Impact | Change |'))
})

test('standalone policy review action rejects invalid modes and policy paths outside the checkout', (t) => {
  const fixture = createRepository(t, {
    version: 1,
    minCoveragePercent: 90,
    maxUnusedRules: 2,
  })
  const invalidMode = runReview(fixture, 'not-a-mode')
  assert.notEqual(invalidMode.status, 0)
  assert.match(invalidMode.stderr, /INPUT_FAIL_ON must be/)

  const outsidePath = spawnSync(process.execPath, [REVIEW_RUNNER], {
    cwd: fixture.directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_OUTPUT: fixture.output,
      INPUT_POLICY_FILE: '../outside.json',
      INPUT_POLICY_BASE_REF: fixture.baseRef,
      INPUT_FAIL_ON: 'none',
    },
  })
  assert.notEqual(outsidePath.status, 0)
  assert.match(outsidePath.stderr, /inside the Git checkout/)
})

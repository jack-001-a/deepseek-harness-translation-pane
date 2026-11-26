import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const cliPath = resolve(scriptDirectory, 'glossary-cli.mjs')

function required(name) {
  const value = process.env[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Missing required action environment value: ' + name)
  }
  if (value.includes(String.fromCharCode(10)) || value.includes(String.fromCharCode(13))) {
    throw new Error('Action inputs must not contain newline characters: ' + name)
  }
  return value
}

function output(name, value, outputFile) {
  const text = String(value)
  if (/[\\r\\n]/u.test(text)) {
    throw new Error('Action output contains a newline: ' + name)
  }
  appendFileSync(outputFile, name + '=' + text + '\n', 'utf8')
}

function markdownEscape(value) {
  return String(value ?? '')
    .replaceAll(String.fromCharCode(13), ' ')
    .replaceAll(String.fromCharCode(10), ' ')
    .replaceAll('|', '\\|')
    .replaceAll(String.fromCharCode(96), '\\' + String.fromCharCode(96))
}

const githubOutput = required('GITHUB_OUTPUT')
const policyFile = required('INPUT_POLICY_FILE')
const baseRef = required('INPUT_POLICY_BASE_REF')
const failOn = process.env.INPUT_FAIL_ON || 'none'
if (failOn.includes(String.fromCharCode(10)) || failOn.includes(String.fromCharCode(13))) {
  throw new Error('Action inputs must not contain newline characters: INPUT_FAIL_ON')
}
if (!['none', 'relaxed', 'tightened', 'any'].includes(failOn)) {
  throw new Error('INPUT_FAIL_ON must be none, relaxed, tightened or any.')
}
const nodeMajor = Number(process.versions.node.split('.')[0])
if (nodeMajor < 22) throw new Error('The glossary policy review action requires Node.js 22 or newer.')

const absolutePolicyFile = resolve(process.cwd(), policyFile)
const gitPolicyPath = relative(process.cwd(), absolutePolicyFile)
if (!gitPolicyPath || gitPolicyPath === '..' || gitPolicyPath.startsWith('..' + sep) ||
  isAbsolute(gitPolicyPath)) {
  throw new Error('The policy-file must resolve to a file inside the Git checkout.')
}

const resolvedBase = spawnSync('git', [
  'rev-parse', '--verify', '--end-of-options', baseRef + '^{commit}',
], { cwd: process.cwd(), encoding: 'utf8' })
if (resolvedBase.error || resolvedBase.status !== 0) {
  throw new Error('Unable to resolve policy-base-ref as a Git commit: ' +
    String(resolvedBase.stderr || resolvedBase.error?.message || '').trim())
}
const baseCommit = resolvedBase.stdout.trim()
const baseline = spawnSync('git', [
  'show', baseCommit + ':' + gitPolicyPath.split(sep).join('/'),
], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
if (baseline.error || baseline.status !== 0) {
  throw new Error('Unable to read policy-file from policy-base-ref: ' +
    String(baseline.stderr || baseline.error?.message || '').trim())
}

const tempDirectory = mkdtempSync(join(tmpdir(), 'dsh-glossary-policy-review-'))
let exitCode = 2
try {
  const baselineFile = resolve(tempDirectory, 'baseline-policy.json')
  writeFileSync(baselineFile, baseline.stdout, 'utf8')
  const result = spawnSync(process.execPath, [
    cliPath, 'policy', 'diff', baselineFile, absolutePolicyFile,
    '--format', 'json', '--fail-on', failOn,
  ], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  if (result.error || ![0, 1].includes(result.status)) {
    throw new Error('Unable to compare quality policies: ' +
      String(result.stderr || result.error?.message || '').trim())
  }

  let report
  try {
    report = JSON.parse(result.stdout)
  } catch {
    throw new Error('The policy diff command returned invalid JSON.')
  }
  if (report.valid !== true || !report.summary || !Array.isArray(report.changes) ||
    !report.gate || typeof report.gate.passed !== 'boolean' ||
    !Number.isInteger(report.gate.failureCount)) {
    throw new Error('The policy diff command returned an incomplete report.')
  }
  if ((result.status === 0) !== report.gate.passed) {
    throw new Error('The policy diff exit code does not match its review gate result.')
  }

  const summary = report.summary
  const changed = report.changes.filter((item) => item.change !== 'unchanged')
  const outputs = {
    'policy-diff-count': summary.added + summary.removed + summary.changed,
    'policy-diff-added-count': summary.added,
    'policy-diff-removed-count': summary.removed,
    'policy-diff-changed-count': summary.changed,
    'policy-diff-tightened-count': summary.tightened,
    'policy-diff-relaxed-count': summary.relaxed,
    'policy-diff-passed': report.gate.passed,
    'policy-diff-exit-code': result.status,
    'policy-diff-failure-count': report.gate.failureCount,
    'policy-schema-changed': report.schemaChanged === true,
    'policy-diff-base-commit': baseCommit,
  }
  for (const [name, value] of Object.entries(outputs)) output(name, value, githubOutput)

  const summaryFile = process.env.GITHUB_STEP_SUMMARY
  if (summaryFile) {
    const tick = String.fromCharCode(96)
    const display = (value) => value === null || value === undefined
      ? '—'
      : markdownEscape(value)
    const lines = [
      '## DSH quality policy review',
      '',
      '- **Base commit:** ' + tick + baseCommit.slice(0, 12) + tick,
      '- **Review gate:** ' + (report.gate.passed ? 'PASS' : 'FAIL') +
        ' (' + tick + '--fail-on ' + failOn + tick + '; ' +
        report.gate.failureCount + ' blocking changes)',
      '- **Threshold changes:** ' + outputs['policy-diff-count'] + ' (' +
        summary.added + ' added, ' + summary.removed + ' removed, ' +
        summary.changed + ' changed; ' + summary.tightened + ' tightened, ' +
        summary.relaxed + ' relaxed)',
    ]
    if (changed.length) {
      lines.push(
        '',
        '| Threshold | Base value | Current value | Impact | Change |',
        '| --- | ---: | ---: | --- | --- |',
      )
      for (const item of changed) {
        lines.push('| ' + tick + markdownEscape(item.field) + tick + ' | ' +
          display(item.before) + ' | ' + display(item.after) + ' | ' +
          item.impact + ' | ' + item.change + ' |')
      }
    } else {
      lines.push('', 'No threshold changes detected.')
    }
    if (report.schemaChanged) {
      lines.push('', '- **JSON Schema reference:** ' + tick + display(report.schemaBefore) +
        tick + ' → ' + tick + display(report.schemaAfter) + tick)
    }
    lines.push('', report.gate.passed
      ? 'The selected policy review gate passed.'
      : 'The selected policy review gate failed; review the threshold changes before merging.', '')
    appendFileSync(summaryFile, lines.join('\n'), 'utf8')
  }
  exitCode = result.status
} finally {
  rmSync(tempDirectory, { recursive: true, force: true })
}

process.exitCode = exitCode

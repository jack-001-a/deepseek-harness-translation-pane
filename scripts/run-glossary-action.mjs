import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const cliPath = resolve(scriptDirectory, 'glossary-cli.mjs')

function required(name) {
  const value = process.env[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Missing required action environment value: ' + name)
  }
  if (value.includes('\n') || value.includes('\r')) {
    throw new Error('Action inputs must not contain newline characters: ' + name)
  }
  return value
}

function output(name, value, outputFile) {
  if (String(value).includes('\n') || String(value).includes('\r')) {
    throw new Error('Action output contains a newline: ' + name)
  }
  appendFileSync(outputFile, name + '=' + String(value) + '\n', 'utf8')
}

const githubOutput = required('GITHUB_OUTPUT')
const glossaryFile = required('INPUT_GLOSSARY_FILE')
const sourceFile = required('INPUT_SOURCE_FILE')
const sourceLanguage = process.env.INPUT_SOURCE_LANGUAGE || 'auto'
const targetLanguage = process.env.INPUT_TARGET_LANGUAGE || 'zh-Hans'
const failOn = process.env.INPUT_FAIL_ON || 'none'
const policyFile = process.env.INPUT_POLICY_FILE || ''
const policyBaseRef = process.env.INPUT_POLICY_BASE_REF || ''
const sarifFile = process.env.INPUT_SARIF_FILE || 'glossary-audit.sarif'

for (const [name, value] of [
  ['INPUT_SOURCE_LANGUAGE', sourceLanguage],
  ['INPUT_TARGET_LANGUAGE', targetLanguage],
  ['INPUT_FAIL_ON', failOn],
  ['INPUT_POLICY_FILE', policyFile],
  ['INPUT_POLICY_BASE_REF', policyBaseRef],
  ['INPUT_SARIF_FILE', sarifFile],
]) {
  if (value.includes('\n') || value.includes('\r')) {
    throw new Error('Action inputs must not contain newline characters: ' + name)
  }
}

const nodeMajor = Number(process.versions.node.split('.')[0])
if (nodeMajor < 22) throw new Error('The glossary audit action requires Node.js 22 or newer.')

rmSync(sarifFile, { force: true })
const cliArgs = [
  cliPath, 'audit', glossaryFile, '--text-file', sourceFile,
  '--source-language', sourceLanguage,
  '--target-language', targetLanguage,
  '--fail-on', failOn,
  '--format', 'sarif', '--output', sarifFile,
]
if (policyFile) cliArgs.push('--policy', policyFile)
const result = spawnSync(process.execPath, cliArgs, { cwd: process.cwd(), stdio: 'inherit' })

const exitCode = result.error || result.status === null ? 2 : result.status
const exists = existsSync(sarifFile)
let findingCount = 0
let sarifReport = null
if (exists) {
  try {
    sarifReport = JSON.parse(readFileSync(sarifFile, 'utf8'))
    findingCount = Array.isArray(sarifReport.runs?.[0]?.results) ? sarifReport.runs[0].results.length : 0
  } catch {
    findingCount = 0
  }
}
output('sarif-file', exists ? sarifFile : '', githubOutput)
output('exit-code', exitCode, githubOutput)
output('audit-passed', exitCode === 0, githubOutput)
output('finding-count', findingCount, githubOutput)

const run = sarifReport?.runs?.[0]
const findings = Array.isArray(run?.results) ? run.results : []

function commandEscape(value) {
  return String(value)
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A')
}

function propertyEscape(value) {
  return commandEscape(value).replaceAll(':', '%3A').replaceAll(',', '%2C')
}

function markdownEscape(value) {
  return String(value ?? '')
    .replace(/[\r\n]+/gu, ' ')
    .replaceAll('|', '\\|')
    .replaceAll(String.fromCharCode(96), '\\' + String.fromCharCode(96))
}

let annotationCount = 0
const annotationLimit = 50
for (const finding of findings.slice(0, annotationLimit)) {
  const command = finding.level === 'error'
    ? 'error'
    : finding.level === 'note'
      ? 'notice'
      : 'warning'
  const physical = finding.locations?.[0]?.physicalLocation
  const uri = physical?.artifactLocation?.uri
  const region = physical?.region
  const properties = []
  if (typeof uri === 'string' && uri.length > 0) properties.push('file=' + propertyEscape(uri))
  if (Number.isInteger(region?.startLine) && region.startLine > 0) properties.push('line=' + region.startLine)
  if (Number.isInteger(region?.startColumn) && region.startColumn > 0) properties.push('col=' + region.startColumn)
  const message = finding.message?.text ?? finding.ruleId ?? 'Glossary audit finding'
  process.stdout.write('::' + command + (properties.length ? ' ' + properties.join(',') : '') +
    '::' + commandEscape(message) + '\n')
  annotationCount += 1
}
if (findings.length > annotationLimit) {
  process.stdout.write('::notice::' + (findings.length - annotationLimit) +
    ' additional glossary findings were omitted from inline annotations; see SARIF and Job Summary.\n')
}

const summaryFile = process.env.GITHUB_STEP_SUMMARY
if (summaryFile) {
  const summary = run?.properties?.summary ?? {}
  const policy = run?.properties?.ciPolicy ?? {}
  const levels = findings.reduce((counts, item) => {
    counts[item.level] = (counts[item.level] ?? 0) + 1
    return counts
  }, {})
  const grouped = new Map()
  for (const finding of findings) {
    const key = finding.ruleId ?? 'glossary-finding'
    grouped.set(key, (grouped.get(key) ?? 0) + 1)
  }
  const status = policy.passed === false ? 'FAIL' : 'PASS'
  const tick = String.fromCharCode(96)
  const summaryLines = [
    '## DSH glossary audit',
    '',
    '- **Policy:** ' + status + ' (' + tick + '--fail-on ' + markdownEscape(policy.failOn ?? failOn) + tick + ')',
    '- **Coverage:** ' + (Number.isFinite(summary.coveragePercent) ? summary.coveragePercent + '%' : 'not available'),
    '- **Rules:** ' + (summary.totalRules ?? 0) + ' total; ' + (summary.activeRules ?? 0) + ' active; ' +
      (summary.fullyShadowedRules ?? 0) + ' fully shadowed; ' + (summary.unusedRules ?? 0) + ' unused',
    '- **Quality policy:** ' + (policy.qualityPolicy ? policy.qualityPolicy.checks.filter((check) => check.passed).length + '/' + policy.qualityPolicy.checks.length + ' thresholds passed' : 'not configured'),
    '- **Findings:** ' + findings.length + ' total; ' + (levels.error ?? 0) + ' errors; ' +
      (levels.warning ?? 0) + ' warnings; ' + (levels.note ?? 0) + ' notices',
    '',
    '| Rule | Findings |',
    '| --- | ---: |',
    ...[...grouped.entries()].sort((left, right) => right[1] - left[1])
      .map(([ruleId, count]) => '| ' + tick + markdownEscape(ruleId) + tick + ' | ' + count + ' |'),
    '',
    'SARIF: ' + tick + markdownEscape(sarifFile) + tick,
    '',
  ]
  appendFileSync(summaryFile, summaryLines.join('\n'), 'utf8')
}

const policyDiffCounts = {
  added: 0, removed: 0, changed: 0, total: 0,
  tightened: 0, relaxed: 0, schemaChanged: false,
}
if (policyBaseRef) {
  if (!policyFile) {
    throw new Error('INPUT_POLICY_BASE_REF requires INPUT_POLICY_FILE.')
  }
  const absolutePolicyFile = resolve(process.cwd(), policyFile)
  const gitPolicyPath = relative(process.cwd(), absolutePolicyFile)
  if (!gitPolicyPath || gitPolicyPath === '..' || gitPolicyPath.startsWith('..' + sep) || isAbsolute(gitPolicyPath)) {
    throw new Error('The policy-file must resolve to a file inside the Git checkout when policy-base-ref is set.')
  }

  const resolvedBase = spawnSync('git', [
    'rev-parse', '--verify', '--end-of-options', policyBaseRef + '^{commit}',
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

  const tempDirectory = mkdtempSync(resolve(tmpdir(), 'dsh-glossary-policy-diff-'))
  try {
    const baselineFile = resolve(tempDirectory, 'baseline-policy.json')
    writeFileSync(baselineFile, baseline.stdout, 'utf8')
    const diffResult = spawnSync(process.execPath, [
      cliPath, 'policy', 'diff', baselineFile, absolutePolicyFile, '--format', 'json',
    ], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
    if (diffResult.error || diffResult.status !== 0) {
      throw new Error('Unable to compare quality policies: ' +
        String(diffResult.stderr || diffResult.error?.message || '').trim())
    }

    let policyDiff
    try {
      policyDiff = JSON.parse(diffResult.stdout)
    } catch {
      throw new Error('The policy diff command returned invalid JSON.')
    }
    if (policyDiff.valid !== true || !policyDiff.summary || !Array.isArray(policyDiff.changes)) {
      throw new Error('The policy diff command returned an incomplete report.')
    }
    policyDiffCounts.added = policyDiff.summary.added
    policyDiffCounts.removed = policyDiff.summary.removed
    policyDiffCounts.changed = policyDiff.summary.changed
    policyDiffCounts.tightened = policyDiff.summary.tightened
    policyDiffCounts.relaxed = policyDiff.summary.relaxed
    policyDiffCounts.total = policyDiffCounts.added + policyDiffCounts.removed + policyDiffCounts.changed
    policyDiffCounts.schemaChanged = policyDiff.schemaChanged === true

    output('policy-diff-count', policyDiffCounts.total, githubOutput)
    output('policy-diff-added-count', policyDiffCounts.added, githubOutput)
    output('policy-diff-removed-count', policyDiffCounts.removed, githubOutput)
    output('policy-diff-changed-count', policyDiffCounts.changed, githubOutput)
    output('policy-diff-tightened-count', policyDiffCounts.tightened, githubOutput)
    output('policy-diff-relaxed-count', policyDiffCounts.relaxed, githubOutput)
    output('policy-schema-changed', policyDiffCounts.schemaChanged, githubOutput)

    if (summaryFile) {
      const tick = String.fromCharCode(96)
      const display = (value) => value === null || value === undefined ? '—' : markdownEscape(value)
      const changed = policyDiff.changes.filter((item) => item.change !== 'unchanged')
      const lines = [
        '',
        '## DSH quality policy diff',
        '',
        '- **Base commit:** ' + tick + baseCommit.slice(0, 12) + tick,
        '- **Threshold changes:** ' + policyDiffCounts.total + ' (' +
          policyDiffCounts.added + ' added, ' + policyDiffCounts.removed + ' removed, ' +
          policyDiffCounts.changed + ' changed; ' + policyDiffCounts.tightened +
          ' tightened, ' + policyDiffCounts.relaxed + ' relaxed)',
      ]
      if (changed.length) {
        lines.push('', '| Threshold | Base value | PR value | Impact | Change |', '| --- | ---: | ---: | --- | --- |')
        for (const item of changed) {
          lines.push('| ' + tick + markdownEscape(item.field) + tick + ' | ' +
            display(item.before) + ' | ' + display(item.after) + ' | ' +
            item.impact + ' | ' + item.change + ' |')
        }
      } else {
        lines.push('', 'No threshold changes detected.')
      }
      if (policyDiffCounts.schemaChanged) {
        lines.push('', '- **JSON Schema reference:** ' + tick + display(policyDiff.schemaBefore) +
          tick + ' → ' + tick + display(policyDiff.schemaAfter) + tick)
      }
      lines.push('', 'This comparison is informational; threshold changes do not fail the audit by themselves.', '')
      appendFileSync(summaryFile, lines.join('\n'), 'utf8')
    }
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true })
  }
} else {
  output('policy-diff-count', 0, githubOutput)
  output('policy-diff-added-count', 0, githubOutput)
  output('policy-diff-removed-count', 0, githubOutput)
  output('policy-diff-changed-count', 0, githubOutput)
  output('policy-schema-changed', false, githubOutput)
}

output('annotation-count', annotationCount, githubOutput)

import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
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
const sarifFile = process.env.INPUT_SARIF_FILE || 'glossary-audit.sarif'

for (const [name, value] of [
  ['INPUT_SOURCE_LANGUAGE', sourceLanguage],
  ['INPUT_TARGET_LANGUAGE', targetLanguage],
  ['INPUT_FAIL_ON', failOn],
  ['INPUT_SARIF_FILE', sarifFile],
]) {
  if (value.includes('\n') || value.includes('\r')) {
    throw new Error('Action inputs must not contain newline characters: ' + name)
  }
}

const nodeMajor = Number(process.versions.node.split('.')[0])
if (nodeMajor < 22) throw new Error('The glossary audit action requires Node.js 22 or newer.')

rmSync(sarifFile, { force: true })
const result = spawnSync(process.execPath, [
  cliPath, 'audit', glossaryFile, '--text-file', sourceFile,
  '--source-language', sourceLanguage,
  '--target-language', targetLanguage,
  '--fail-on', failOn,
  '--format', 'sarif', '--output', sarifFile,
], { cwd: process.cwd(), stdio: 'inherit' })

const exitCode = result.error || result.status === null ? 2 : result.status
const exists = existsSync(sarifFile)
let findingCount = 0
if (exists) {
  try {
    const report = JSON.parse(readFileSync(sarifFile, 'utf8'))
    findingCount = Array.isArray(report.runs?.[0]?.results) ? report.runs[0].results.length : 0
  } catch {
    findingCount = 0
  }
}
output('sarif-file', exists ? sarifFile : '', githubOutput)
output('exit-code', exitCode, githubOutput)
output('audit-passed', exitCode === 0, githubOutput)
output('finding-count', findingCount, githubOutput)

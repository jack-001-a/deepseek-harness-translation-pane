import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const testDirectory = dirname(fileURLToPath(import.meta.url))
const testTitlePattern = /^test\(\s*(['"])(.*?)(?<!\\)\1\s*,/gm

test('quality: test titles are unique within each file', () => {
  const files = readdirSync(testDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map((entry) => entry.name)
    .sort()

  for (const file of files) {
    const source = readFileSync(join(testDirectory, file), 'utf8')
    const seen = new Set()
    const duplicates = []
    for (const match of source.matchAll(testTitlePattern)) {
      const title = match[2]
      if (seen.has(title)) duplicates.push(title)
      else seen.add(title)
    }
    assert.deepEqual(duplicates, [], `${file} contains duplicate test titles`)
  }
})

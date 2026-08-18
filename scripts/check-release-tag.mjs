import { readFile } from 'node:fs/promises'
import process from 'node:process'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const expected = `v${packageJson.version}`
const actual = process.env.GITHUB_REF_NAME || process.argv[2]

if (actual !== expected) {
  process.stderr.write(`release tag mismatch: expected ${expected}, got ${actual || '<missing>'}\n`)
  process.exit(1)
}

process.stdout.write(`release tag: ${actual}\n`)

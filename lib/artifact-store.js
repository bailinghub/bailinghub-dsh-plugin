import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, link, unlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const error = () => Object.assign(new Error('Artifact recovery metadata could not be saved or restored.'), { code: 'storage_error' })
const fileName = id => { if (!/^[a-f0-9]{64}$/.test(id)) throw error(); return `${id}.json` }
function checked(value, id) {
  const json = JSON.stringify(value)
  if (json.length > 16384 || value?.uploadId !== id || !value.metadata || !value.binding || !value.artifactRef || !value.sessionId) throw error()
  return JSON.parse(json)
}
/** Test/ephemeral hosts only. Production hosts must persist the immutable recovery record. */
export function createMemoryArtifactStore() {
  const records = new Map()
  return { async get(id) { return structuredClone(records.get(id) ?? null) }, async reserve(value) {
    if (!records.has(value.uploadId)) records.set(value.uploadId, checked(value, value.uploadId))
    return structuredClone(records.get(value.uploadId))
  } }
}
/** Atomic write-once receipts; no credentials or file bytes. Keep this directory across restarts. */
export function createFileArtifactStore({ directory } = {}) {
  if (typeof directory !== 'string' || !directory) throw error()
  const root = resolve(directory)
  async function prepare() {
    await mkdir(root, { recursive: true, mode: 0o700 })
    const stat = await lstat(root)
    if (!stat.isDirectory() || (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700)) throw error()
  }
  async function get(id) {
    try {
      await prepare()
      let handle
      try { handle = await open(join(root, fileName(id)), constants.O_RDONLY | constants.O_NOFOLLOW) }
      catch (e) { if (e.code === 'ENOENT') return null; throw e }
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.size > 16384 || (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600)) throw error()
        return checked(JSON.parse(await handle.readFile('utf8')), id)
      } finally { await handle.close() }
    } catch { throw error() }
  }
  return { get, async reserve(value) {
    const data = checked(value, value.uploadId)
    let temporary
    try {
      await prepare()
      temporary = join(root, `${randomUUID()}.tmp`)
      const handle = await open(temporary, 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify(data)); await handle.sync() } finally { await handle.close() }
      try { await link(temporary, join(root, fileName(value.uploadId))) } catch (e) { if (e.code !== 'EEXIST') throw e }
      if (process.platform !== 'win32') { const dir = await open(root, 'r'); try { await dir.sync() } finally { await dir.close() } }
      return await get(value.uploadId)
    } catch { throw error() } finally { if (temporary) await unlink(temporary).catch(() => {}) }
  } }
}

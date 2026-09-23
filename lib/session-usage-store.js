import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { isProxy } from 'node:util/types'

const SCHEMAS = new Set(['bailing.usage-session.v1'])
const RECORD_KEYS = new Set(['schema', 'sessionId', 'revision', 'entries'])
const MAX_BYTES = 8 * 1024 * 1024
const LOCK_TIMEOUT_MS = 1_000
const PRIVATE_KEYS = new Set([
  'token', 'tokens', 'accesstoken', 'refreshtoken', 'password', 'clientsecret',
  'authorization', 'credential', 'credentials', 'secret', 'apikey',
  'args', 'arguments', 'content', 'contents', 'body', 'prompt', 'messages',
])
const MAX_DEPTH = 128

function storeError(code = 'USAGE_STORE_UNAVAILABLE') {
  const error = new Error(code === 'USAGE_STORE_CONFLICT'
    ? 'The usage binding changed or is being saved. Read it again before retrying.'
    : 'The usage binding store is unavailable. Recovery metadata was not safely confirmed.')
  error.code = code
  return error
}

function safeError(error) {
  return ['USAGE_STORE_CONFLICT', 'USAGE_STORE_UNAVAILABLE'].includes(error?.code)
    ? error : storeError()
}

function sessionKey(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.length || sessionId.length > 4_096) throw storeError()
  return createHash('sha256').update(sessionId).digest('hex')
}

// The coordinator validates each original execution binding. This boundary accepts
// only JSON metadata and refuses credential or business payload fields. Tool names
// are values, so a tool named "content" or "arguments" remains valid metadata.
function snapshotJson(value, seen = new Set(), depth = 0) {
  if (depth > MAX_DEPTH) throw storeError()
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return value
  if (!value || typeof value !== 'object' || seen.has(value) || isProxy(value)) throw storeError()
  const array = Array.isArray(value)
  if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw storeError()
  seen.add(value)
  try {
    const entries = Reflect.ownKeys(value).filter((key) => !array || key !== 'length')
    if (array && (entries.length !== value.length || entries.some((key, index) => key !== String(index)))) throw storeError()
    const copy = array ? [] : {}
    for (const key of entries) {
      const property = Object.getOwnPropertyDescriptor(value, key)
      if (typeof key !== 'string' || !property.enumerable || !Object.hasOwn(property, 'value') ||
        PRIVATE_KEYS.has(key.replace(/[_-]/gu, '').toLowerCase()) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw storeError()
      copy[key] = snapshotJson(property.value, seen, depth + 1)
    }
    return copy
  } finally {
    seen.delete(value)
  }
}

function snapshotRecord(sessionId, record) {
  const copy = snapshotJson(record)
  if (!copy || Array.isArray(copy) || !SCHEMAS.has(copy.schema) || copy.sessionId !== sessionId ||
    !Number.isSafeInteger(copy.revision) || copy.revision < 1 || !Array.isArray(copy.entries) ||
    Object.keys(copy).some((key) => !RECORD_KEYS.has(key))) throw storeError()
  const request = copy.entries[0]?.request
  if (copy.entries.length !== 1 || !request || request.metadata?.schema !== 'bailing.model-request.v1'
    || typeof request.metadata.operationId !== 'string' || !copy.sessionId.startsWith('model:')
    || !['prepared', 'completed', 'cancelled', 'rejected', 'unknown', 'closed_unresolved'].includes(request.state)
    || Object.keys(copy.entries[0]).some(key => key !== 'request')) throw storeError()
  if (Buffer.byteLength(JSON.stringify(copy)) > MAX_BYTES) throw storeError()
  return copy
}

function nextRecord(sessionId, record, expectedRevision) {
  sessionKey(sessionId)
  if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) throw storeError()
  const copy = snapshotRecord(sessionId, record)
  if (copy.revision !== (expectedRevision ?? 0) + 1) throw storeError()
  return copy
}

function assertRevision(current, expectedRevision) {
  if ((current?.revision ?? null) !== expectedRevision) throw storeError('USAGE_STORE_CONFLICT')
}

function assertOwned(stat, kind) {
  if (!(kind === 'directory' ? stat.isDirectory() : stat.isFile()) ||
    (kind === 'file' && stat.nlink !== 1) ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
    (process.platform !== 'win32' && (stat.mode & 0o777) !== (kind === 'directory' ? 0o700 : 0o600))) throw storeError()
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino
}

function defaultDirectory() {
  const configured = process.env.DSH_HOME
  const base = typeof configured === 'string' && configured.trim() ? configured : join(homedir(), '.dsh')
  const expanded = base === '~' ? homedir() : /^~[/\\]/u.test(base) ? join(homedir(), base.slice(2)) : base
  return join(resolve(expanded), 'plugins', 'dsh-bailinghub', 'session-usage')
}

async function ensureDirectory(directory, create) {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 })
  let stat
  try {
    stat = await lstat(directory)
  } catch (error) {
    if (!create && error.code === 'ENOENT') return false
    throw error
  }
  assertOwned(stat, 'directory')
  return true
}

async function readRecord(path, sessionId) {
  let before
  try {
    before = await lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  assertOwned(before, 'file')
  if (before.size > MAX_BYTES) throw storeError()
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = await file.stat()
    assertOwned(opened, 'file')
    if (!sameFile(before, opened) || opened.size > MAX_BYTES) throw storeError()
    // Bound the read even if an abnormal writer grows the file after fstat.
    const bytes = Buffer.alloc(MAX_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length)
      if (!result.bytesRead) break
      length += result.bytesRead
    }
    if (length > MAX_BYTES) throw storeError()
    return snapshotRecord(sessionId, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))))
  } finally {
    await file.close()
  }
}

async function acquireLock(path) {
  const deadline = performance.now() + LOCK_TIMEOUT_MS
  while (true) {
    let file
    let stat
    try {
      file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      stat = await file.stat()
      await file.chmod(0o600)
      assertOwned(await file.stat(), 'file')
      return { file, stat }
    } catch (error) {
      if (file) {
        if (stat) await releaseLock(path, { file, stat })
        else await file.close().catch(() => {})
      }
      if (error.code !== 'EEXIST') throw error
      try {
        assertOwned(await lstat(path), 'file')
      } catch (inspectionError) {
        if (inspectionError.code === 'ENOENT') continue
        throw inspectionError
      }
      if (performance.now() >= deadline) throw storeError('USAGE_STORE_CONFLICT')
      // Never infer staleness or remove another process's lock.
      await delay(20)
    }
  }
}

async function releaseLock(path, lock) {
  try {
    const current = await lstat(path)
    if (!sameFile(current, lock.stat) || !current.isFile()) throw storeError()
    await unlink(path)
  } finally {
    await lock.file.close()
  }
}

async function syncDirectory(directory) {
  // Windows does not expose fsync on directory handles through Node.
  if (process.platform === 'win32') return
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    assertOwned(await handle.stat(), 'directory')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Durable model request metadata only. No user directory is touched until load/save. */
export function createFileSessionUsageStore({ directory } = {}) {
  if (directory !== undefined && (typeof directory !== 'string' || !directory.trim())) throw storeError()
  const root = directory === undefined ? defaultDirectory() : resolve(directory)
  return {
    async load(sessionId) {
      try {
        const key = sessionKey(sessionId)
        if (!await ensureDirectory(root, false)) return null
        return await readRecord(join(root, `${key}.json`), sessionId)
      } catch (error) {
        throw safeError(error)
      }
    },
    async save(sessionId, record, expectedRevision) {
      let lock
      let temporaryPath
      const key = sessionKey(sessionId)
      const path = join(root, `${key}.json`)
      const lockPath = join(root, `${key}.lock`)
      try {
        const copy = nextRecord(sessionId, record, expectedRevision)
        await ensureDirectory(root, true)
        lock = await acquireLock(lockPath)
        assertRevision(await readRecord(path, sessionId), expectedRevision)
        temporaryPath = join(root, `.${key}.${randomUUID()}.tmp`)
        const temporary = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        try {
          await temporary.chmod(0o600)
          assertOwned(await temporary.stat(), 'file')
          await temporary.writeFile(JSON.stringify(copy), 'utf8')
          await temporary.sync()
        } finally {
          await temporary.close()
        }
        await rename(temporaryPath, path)
        temporaryPath = undefined
        await syncDirectory(root)
        return snapshotRecord(sessionId, copy)
      } catch (error) {
        throw safeError(error)
      } finally {
        try {
          if (temporaryPath) await unlink(temporaryPath).catch((error) => {
            if (error.code !== 'ENOENT') throw storeError()
          })
        } finally {
          if (lock) {
            try {
              await releaseLock(lockPath, lock)
            } catch {
              throw storeError()
            }
          }
        }
      }
    },
  }
}

/** Explicit in-memory adapter: CAS-compatible, but never survives process restart. */
export function createMemorySessionUsageStore() {
  const records = new Map()
  return {
    async load(sessionId) {
      sessionKey(sessionId)
      const record = records.get(sessionId)
      return record ? snapshotRecord(sessionId, record) : null
    },
    async save(sessionId, record, expectedRevision) {
      const copy = nextRecord(sessionId, record, expectedRevision)
      assertRevision(records.get(sessionId), expectedRevision)
      records.set(sessionId, copy)
      return snapshotRecord(sessionId, copy)
    },
  }
}

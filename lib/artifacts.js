import { createHash } from 'node:crypto'

const digest = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
const fail = code => Object.assign(new Error(code), { code })
const descriptor = v => {
  if (!v || typeof v.artifactRef !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(v.artifactRef) || typeof v.name !== 'string' || !v.name || v.name.length > 128 || /[\\/\u0000-\u001f\u007f]/.test(v.name) ||
    !['image/png', 'image/jpeg', 'image/webp'].includes(v.mime) || !Number.isInteger(v.bytes) || v.bytes < 1 || v.bytes > 6291456 || !/^[a-f0-9]{64}$/.test(v.sha256)) throw fail('artifact_invalid_source')
  return { artifactRef: v.artifactRef, name: v.name, mime: v.mime, bytes: v.bytes, sha256: v.sha256 }
}
export async function listArtifacts(source, sessionId) {
  if (typeof source?.list !== 'function') throw fail('artifact_source_unsupported')
  const values = await source.list({ sessionId })
  if (!Array.isArray(values) || values.length > 100) throw fail('artifact_invalid_source')
  const result = values.map(descriptor)
  if (new Set(result.map(x => x.artifactRef)).size !== result.length) throw fail('artifact_invalid_source')
  return result
}
/** One immutable original target per receipt. This never invokes a business operation. */
export async function deliverArtifact({ source, store, transport, sessionId, artifactRef, binding, options, metadata, assertActive }) {
  if (!store?.get || !store?.reserve) throw fail('storage_error')
  if (!transport?.uploadArtifact || !transport?.getArtifact) throw fail('artifact_unsupported')
  const uploadId = digest('bailing.artifact.v1', sessionId, options.connectionKey, artifactRef)
  const validateStored = record => {
    if (!record || record.sessionId !== sessionId || record.artifactRef !== artifactRef || record.uploadId !== uploadId || JSON.stringify(record.binding) !== JSON.stringify(binding)) throw fail('artifact_conflict')
    return record
  }
  let record
  try { record = await store.get(uploadId) } catch { throw fail('storage_error') }
  if (record) {
    validateStored(record)
    await assertActive()
    try {
      const result = await transport.getArtifact(uploadId, options)
      if (result.state === 'ready') {
        if (result.sha256 !== record.metadata.sha256) throw fail('artifact_conflict')
        await assertActive()
        return { artifact_ref: artifactRef, ...result }
      }
    } catch (e) { if (e.publicCode !== 'artifact_not_found') throw e }
  }
  await assertActive()
  if (typeof source?.read !== 'function') throw fail('artifact_source_unsupported')
  const item = (await listArtifacts(source, sessionId)).find(x => x.artifactRef === artifactRef)
  if (!item) throw fail('artifact_not_found_local')
  if (record && (record.metadata.sha256 !== item.sha256 || record.metadata.name !== item.name || record.metadata.mime !== item.mime || record.metadata.bytes !== item.bytes)) throw fail('artifact_content_changed')
  const raw = await source.read({ sessionId, artifactRef })
  if (!(raw instanceof Uint8Array)) throw fail('artifact_invalid_source')
  if (raw.byteLength !== item.bytes) throw fail('artifact_content_changed')
  const body = Buffer.from(raw)
  if (body.length !== item.bytes || createHash('sha256').update(body).digest('hex') !== item.sha256) throw fail('artifact_content_changed')
  if (!record) {
    try { record = await store.reserve({ uploadId, sessionId, artifactRef, binding, metadata: { ...metadata, name: item.name, mime: item.mime, bytes: item.bytes, sha256: item.sha256 } }) }
    catch { throw fail('storage_error') }
    validateStored(record)
    if (record.metadata.sha256 !== item.sha256) throw fail('artifact_content_changed')
  }
  await assertActive()
  const result = await transport.uploadArtifact({ uploadId, body, ...record.metadata }, options)
  await assertActive()
  return { artifact_ref: artifactRef, ...result }
}

export function artifactFailure(error, artifactRef) {
  const candidate = error?.publicCode ?? error?.code
  const known = new Set(['storage_error', 'artifact_unsupported', 'artifact_source_unsupported', 'artifact_invalid_source', 'artifact_not_found_local', 'artifact_content_changed',
    'artifact_conflict', 'artifact_invalid_request', 'artifact_content_mismatch', 'artifact_type_not_allowed', 'artifact_too_large', 'artifact_run_mismatch',
    'artifact_storage_changed', 'artifact_upload_disabled', 'artifact_storage_unavailable', 'artifact_upload_pending', 'artifact_invalid_receipt',
    'agent_request_timeout', 'agent_transport_unavailable', 'unauthorized', 'route_not_allowed', 'agent_request_cancelled'])
  const code = known.has(candidate) ? candidate : 'artifact_delivery_blocked'
  const pending = ['artifact_upload_pending', 'agent_request_timeout', 'agent_transport_unavailable'].includes(code)
  return { artifact_ref: artifactRef, state: pending ? 'pending' : 'blocked', error: code,
    next_action: pending ? 'retry_same_artifact_and_authorization' : code === 'storage_error' ? 'repair_local_storage' : 'resolve_error',
    business_operation_performed: false }
}

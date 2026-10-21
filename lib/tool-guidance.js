import { Buffer } from 'node:buffer'
import { declarationKey } from './authorizations.js'

const invalid = () => Object.assign(new Error('Tool guidance does not match the current authorized declaration'), { publicCode: 'agent_invalid_response' })

/** Custom transports need the same bounded reference and binding checks as the SDK. */
export function normalizeToolGuidance(value, { route, capabilityRevision, tool, normalizeSearch }) {
  try {
    if (!value || value.schema_version !== 'bailing.agent-tool-detail.v1' || value.route !== route ||
      value.capability_revision !== capabilityRevision || value.tool?.name !== tool.name) throw invalid()
    const normalized = normalizeSearch({ schema_version: 'bailing.agent-capability-search.v1',
      capability_revision: capabilityRevision, tools: [value.tool] }).tools[0]
    if (declarationKey(normalized) !== declarationKey(tool)) throw invalid()
    const guidance = value.usage_guidance
    if (!guidance || typeof guidance.text !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(guidance.text) ||
      typeof guidance.truncated !== 'boolean' || guidance.max_chars !== 32768 || guidance.max_bytes !== 65536 ||
      !Number.isSafeInteger(guidance.source_chars) || !Number.isSafeInteger(guidance.source_bytes)) throw invalid()
    const chars = [...guidance.text].length
    const bytes = Buffer.byteLength(guidance.text, 'utf8')
    if (chars > guidance.max_chars || bytes > guidance.max_bytes || guidance.source_chars < chars || guidance.source_bytes < bytes ||
      guidance.truncated !== (guidance.source_chars > chars || guidance.source_bytes > bytes)) throw invalid()
    return { text: guidance.text, truncated: guidance.truncated, source_chars: guidance.source_chars,
      max_chars: guidance.max_chars, source_bytes: guidance.source_bytes, max_bytes: guidance.max_bytes }
  } catch {
    throw invalid()
  }
}

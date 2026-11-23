import { pool } from './db/pool.js'
import { maskDeep } from './pii.js'

export type AuditEvent = 'chat' | 'tool_call' | 'altrum_verdict' | 'staff_decision' | 'memory_deleted' | 'error'

// Writes an audit record. PII is masked before it is stored.
export async function audit(sessionId: string | null, event: AuditEvent, detail: Record<string, unknown>) {
  try {
    await pool.query('INSERT INTO audit_log (session_id, event, detail) VALUES ($1, $2, $3)', [
      sessionId,
      event,
      JSON.stringify(maskDeep(detail)),
    ])
  } catch (err) {
    console.error('[audit] failed to write audit record', err)
  }
}

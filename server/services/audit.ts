import { db } from '../db/db.ts';
import { clock } from '../lib/clock.ts';
import { newId } from '../lib/ids.ts';
import type { Actor } from '../auth/middleware.ts';

/**
 * Append-only audit trail. `details` must never contain secrets, PINs or raw CRB payloads.
 */
export function audit(actor: Actor, action: string, summary: string, opts: { entityType?: string; entityId?: string; details?: unknown; ip?: string } = {}) {
  db.insert('audit_logs', {
    id: newId('aud'),
    organization_id: actor.organizationId,
    actor_type: actor.type,
    actor_id: actor.id,
    actor_name: actor.name,
    action,
    entity_type: opts.entityType ?? null,
    entity_id: opts.entityId ?? null,
    summary,
    details: opts.details === undefined ? null : JSON.stringify(opts.details),
    ip: opts.ip ?? null,
    created_at: clock.nowIso(),
  });
}

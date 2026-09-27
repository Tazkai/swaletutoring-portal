import type { DB } from './db.js';

// Every write goes through here, inside the same transaction as the write itself,
// so a change can never land without its audit row.
export function audit(
  db: DB,
  actorUserId: number | null,
  action: string,
  entity: string,
  entityId: number | null,
  detail?: Record<string, unknown>,
): void {
  db.prepare(
    `INSERT INTO audit_log (actor_user_id, action, entity, entity_id, detail)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(actorUserId, action, entity, entityId, detail ? JSON.stringify(detail) : null);
}

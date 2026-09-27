import { isOversight, type AuthUser } from './auth.js';
import type { DB } from './db.js';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

// A tutor sees only pupils linked to them in pupil_tutors with active = 1.
// Hidden pupils answer 404, not 403, so IDs can't be probed.
export function assertPupilVisible(db: DB, user: AuthUser, pupilId: number): void {
  const row = isOversight(user)
    ? db.prepare('SELECT 1 FROM pupils WHERE id = ?').get(pupilId)
    : db
        .prepare(
          `SELECT 1 FROM pupil_tutors
           WHERE pupil_id = ? AND user_id = ? AND active = 1`,
        )
        .get(pupilId, user.id);
  if (!row) throw new HttpError(404, 'pupil not found');
}

export function londonDate(iso: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

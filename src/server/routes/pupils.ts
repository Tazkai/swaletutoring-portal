import type { FastifyInstance } from 'fastify';
import { isOversight } from '../auth.js';
import { KEY_INFO_FIELDS, type KeyInfoView } from '../../shared/types.js';
import { assertPupilVisible, HttpError, londonDate } from '../access.js';
import { audit } from '../audit.js';
import type { DB } from '../db.js';

// Path params arrive as strings and type coercion is off (see app.ts).
const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', pattern: '^[1-9][0-9]{0,9}$' } },
} as const;

export function pupilRoutes(app: FastifyInstance, db: DB): void {
  // Tutors get names and reference only: no DOB or commissioner detail on the phone.
  const lastVenue = `(SELECT s.venue FROM sessions s
      WHERE s.pupil_id = p.id AND s.tutor_id = @me AND s.venue IS NOT NULL
      ORDER BY s.started_at DESC LIMIT 1) AS last_venue`;

  // Whether this tutor has a finished record (lesson or non-attendance) for today, UK time.
  const doneToday = `EXISTS (SELECT 1 FROM sessions s
      WHERE s.pupil_id = p.id AND s.tutor_id = @me AND s.submitted_at IS NOT NULL
        AND s.session_date = @today) AS done_today`;

  // Key information status: the current version, and whether this tutor has confirmed it.
  const keyInfo = `
      (SELECT MAX(k.version) FROM pupil_key_info k WHERE k.pupil_id = p.id) AS key_info_version,
      EXISTS (SELECT 1 FROM key_info_confirmations c
        WHERE c.user_id = @me AND c.key_info_id =
          (SELECT k.id FROM pupil_key_info k WHERE k.pupil_id = p.id ORDER BY k.version DESC LIMIT 1)
      ) AS key_info_confirmed`;
  const columns = `p.id, p.reference, p.first_name, p.last_name, p.preferred_name,
      p.looked_after AS first_aider_required, ${lastVenue}, ${doneToday}, ${keyInfo}`;

  const tutorPupils = db.prepare(
    `SELECT ${columns}
     FROM pupils p
     JOIN pupil_tutors pt ON pt.pupil_id = p.id AND pt.user_id = @me AND pt.active = 1
     WHERE p.status = 'active'
     ORDER BY p.first_name, p.last_name`,
  );
  const allPupils = db.prepare(
    `SELECT ${columns}
     FROM pupils p
     WHERE p.status = 'active'
     ORDER BY p.first_name, p.last_name`,
  );

  app.get('/api/pupils', async (request) => {
    const me = request.user;
    const today = londonDate(new Date().toISOString());
    return (isOversight(me) ? allPupils : tutorPupils).all({ me: me.id, today });
  });

  app.get<{ Params: { id: string } }>(
    '/api/pupils/:id',
    { schema: { params: idParams } },
    async (request) => {
      assertPupilVisible(db, request.user, Number(request.params.id));
      return db
        .prepare('SELECT id, reference, first_name, last_name, status FROM pupils WHERE id = ?')
        .get(Number(request.params.id));
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/pupils/:id/sessions',
    { schema: { params: idParams } },
    async (request) => {
      const me = request.user;
      assertPupilVisible(db, me, Number(request.params.id));
      // Tutors see their own sessions with this pupil; oversight roles see every tutor's.
      return db
        .prepare(
          `SELECT s.client_uuid, s.session_date, s.started_at, s.ended_at, s.venue,
                  s.attendance_status, s.reported_by, s.non_attendance_note,
                  s.submitted_at, u.display_name AS tutor_name,
                  lr.lesson_summary, lr.engagement, lr.needs_followup
           FROM sessions s
           JOIN users u ON u.id = s.tutor_id
           LEFT JOIN lesson_records lr ON lr.session_id = s.id
           WHERE s.pupil_id = @pupil ${isOversight(me) ? '' : 'AND s.tutor_id = @me'}
           ORDER BY s.session_date DESC, s.started_at DESC
           LIMIT 100`,
        )
        .all({ pupil: Number(request.params.id), me: me.id });
    },
  );

  // The pupil's key information and current targets, for the assigned tutor
  // (Back_Office_Scope.md §4). The phone caches this for use without signal.
  app.get<{ Params: { id: string } }>(
    '/api/pupils/:id/key-info',
    { schema: { params: idParams } },
    async (request): Promise<KeyInfoView | null> => {
      const me = request.user;
      const pupilId = Number(request.params.id);
      assertPupilVisible(db, me, pupilId);
      const row = db
        .prepare('SELECT * FROM pupil_key_info WHERE pupil_id = ? ORDER BY version DESC LIMIT 1')
        .get(pupilId) as Record<string, unknown> | undefined;
      const lookedAfter = db.prepare('SELECT looked_after FROM pupils WHERE id = ?').pluck().get(pupilId);
      const targets = db
        .prepare(
          `SELECT id, ehcp_outcome, target, measure, review_date FROM pupil_targets
           WHERE pupil_id = ? AND status = 'active' ORDER BY id`,
        )
        .all(pupilId) as KeyInfoView['targets'];
      if (!row && targets.length === 0) return null;
      const confirmedAt = row
        ? (db
            .prepare('SELECT confirmed_at FROM key_info_confirmations WHERE key_info_id = ? AND user_id = ?')
            .pluck()
            .get(row.id, me.id) as string | undefined)
        : undefined;
      return {
        version: Number(row?.version ?? 0),
        fields: row ? Object.fromEntries(KEY_INFO_FIELDS.map((f) => [f, (row[f] as string | null) ?? null])) : {},
        confirmed_at: confirmedAt ?? null,
        first_aider_required: lookedAfter === 1,
        targets,
      };
    },
  );

  // "I have read this." Idempotent, so an offline confirmation can be replayed safely.
  app.post<{ Params: { id: string }; Body: { version: number } }>(
    '/api/pupils/:id/key-info/confirm',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['version'],
          properties: { version: { type: 'integer', minimum: 1 } },
        },
      },
    },
    async (request) => {
      const me = request.user;
      const pupilId = Number(request.params.id);
      return db.transaction(() => {
        assertPupilVisible(db, me, pupilId);
        const row = db
          .prepare('SELECT id FROM pupil_key_info WHERE pupil_id = ? AND version = ?')
          .get(pupilId, request.body.version) as { id: number } | undefined;
        if (!row) throw new HttpError(404, 'that version of the key information does not exist');
        const info = db
          .prepare('INSERT OR IGNORE INTO key_info_confirmations (key_info_id, user_id) VALUES (?, ?)')
          .run(row.id, me.id);
        if (info.changes) {
          audit(db, me.id, 'key_info.confirm', 'pupils', pupilId, { version: request.body.version });
        }
        const current = db.prepare('SELECT MAX(version) FROM pupil_key_info WHERE pupil_id = ?').pluck().get(pupilId);
        return { confirmed_version: request.body.version, current_version: current };
      })();
    },
  );
}

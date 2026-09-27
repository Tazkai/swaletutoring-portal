import type { FastifyInstance } from 'fastify';
import { isOversight } from '../auth.js';
import { assertPupilVisible } from '../access.js';
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

  const tutorPupils = db.prepare(
    `SELECT p.id, p.reference, p.first_name, p.last_name, ${lastVenue}
     FROM pupils p
     JOIN pupil_tutors pt ON pt.pupil_id = p.id AND pt.user_id = @me AND pt.active = 1
     WHERE p.status = 'active'
     ORDER BY p.first_name, p.last_name`,
  );
  const allPupils = db.prepare(
    `SELECT p.id, p.reference, p.first_name, p.last_name, ${lastVenue}
     FROM pupils p
     WHERE p.status = 'active'
     ORDER BY p.first_name, p.last_name`,
  );

  app.get('/api/pupils', async (request) => {
    const me = request.user;
    return (isOversight(me) ? allPupils : tutorPupils).all({ me: me.id });
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
}

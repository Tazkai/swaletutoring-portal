import type { FastifyInstance } from 'fastify';
import {
  ATTENDED_STATUSES,
  VENUES,
  type EndSessionBody,
  type LessonRecordBody,
  type SessionView,
  type StartSessionBody,
} from '../../shared/types.js';
import type { AuthUser } from '../auth.js';
import { assertPupilVisible, HttpError, londonDate } from '../access.js';
import { audit } from '../audit.js';
import type { DB } from '../db.js';

// Every write here is idempotent on the device-generated client_uuid, so a phone
// replaying its offline queue updates the same row instead of creating another.

const uuid = { type: 'string', format: 'uuid' } as const;
const timestamp = { type: 'string', format: 'date-time' } as const;
const text = (max: number) => ({ type: 'string', maxLength: max }) as const;

const uuidParams = {
  type: 'object',
  required: ['uuid'],
  properties: { uuid },
} as const;

const startSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['client_uuid', 'pupil_id', 'venue', 'started_at'],
    properties: {
      client_uuid: uuid,
      pupil_id: { type: 'integer', minimum: 1 },
      venue: { type: 'string', enum: VENUES },
      started_at: timestamp,
    },
  },
} as const;

const endSchema = {
  params: uuidParams,
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['ended_at'],
    properties: { ended_at: timestamp },
  },
} as const;

const recordSchema = {
  params: uuidParams,
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['lesson_summary', 'planned_lesson', 'engagement'],
    properties: {
      started_at: timestamp,
      ended_at: timestamp,
      attendance_status: { type: 'string', enum: ATTENDED_STATUSES },
      lesson_summary: { type: 'string', minLength: 1, maxLength: 4000 },
      planned_lesson: { type: 'boolean' },
      substitution_reason: text(4000),
      next_lesson: text(4000),
      problems: text(4000),
      engagement: { type: 'integer', enum: [1, 2, 3] },
      issues: text(4000),
      needs_followup: { type: 'boolean' },
    },
  },
} as const;

// A phone clock a little fast is fine; a timestamp hours ahead is a bug.
const FUTURE_TOLERANCE_MS = 10 * 60 * 1000;

function notInFuture(iso: string, field: string): void {
  if (Date.parse(iso) > Date.now() + FUTURE_TOLERANCE_MS) {
    throw new HttpError(400, `${field} is in the future`);
  }
}

const blankToNull = (v: string | undefined): string | null => (v && v.trim() ? v.trim() : null);

interface SessionRow {
  id: number;
  client_uuid: string;
  pupil_id: number;
  tutor_id: number;
  started_at: string | null;
  ended_at: string | null;
  submitted_at: string | null;
}

export function sessionRoutes(app: FastifyInstance, db: DB): void {
  const byUuid = db.prepare(
    `SELECT id, client_uuid, pupil_id, tutor_id, started_at, ended_at, submitted_at
     FROM sessions WHERE client_uuid = ?`,
  );
  const viewByUuid = db.prepare(
    `SELECT s.client_uuid, s.pupil_id, p.first_name || ' ' || p.last_name AS pupil_name,
            s.session_date, s.started_at, s.ended_at, s.venue, s.attendance_status, s.submitted_at
     FROM sessions s JOIN pupils p ON p.id = s.pupil_id
     WHERE s.client_uuid = ?`,
  );

  // The caller's own session, or 404. Nobody edits another tutor's session, whatever their role.
  const ownSession = (user: AuthUser, clientUuid: string): SessionRow => {
    const row = byUuid.get(clientUuid) as SessionRow | undefined;
    if (!row || row.tutor_id !== user.id) throw new HttpError(404, 'session not found');
    return row;
  };
  const view = (clientUuid: string) => viewByUuid.get(clientUuid) as SessionView;

  app.get('/api/sessions/open', async (request) => {
    return db
      .prepare(
        `SELECT s.client_uuid, s.pupil_id, p.first_name || ' ' || p.last_name AS pupil_name,
                s.session_date, s.started_at, s.ended_at, s.venue, s.attendance_status, s.submitted_at
         FROM sessions s JOIN pupils p ON p.id = s.pupil_id
         WHERE s.tutor_id = ? AND s.started_at IS NOT NULL AND s.submitted_at IS NULL
         ORDER BY s.started_at`,
      )
      .all(request.user.id);
  });

  app.post<{ Body: StartSessionBody }>(
    '/api/sessions/start',
    { schema: startSchema },
    async (request) => {
      const me = request.user;
      const b = request.body;
      notInFuture(b.started_at, 'started_at');

      return db.transaction(() => {
        const existing = byUuid.get(b.client_uuid) as SessionRow | undefined;
        if (existing && (existing.tutor_id !== me.id || existing.pupil_id !== b.pupil_id)) {
          throw new HttpError(409, 'session id already used');
        }
        assertPupilVisible(db, me, b.pupil_id);

        db.prepare(
          `INSERT INTO sessions
             (client_uuid, pupil_id, tutor_id, session_date, started_at, venue, attendance_status)
           VALUES (@uuid, @pupil, @me, @date, @started, @venue, 'present')
           ON CONFLICT(client_uuid) DO UPDATE SET
             started_at = excluded.started_at,
             session_date = excluded.session_date,
             venue = excluded.venue
           WHERE sessions.submitted_at IS NULL`,
        ).run({
          uuid: b.client_uuid,
          pupil: b.pupil_id,
          me: me.id,
          date: londonDate(b.started_at),
          started: b.started_at,
          venue: b.venue,
        });

        const row = byUuid.get(b.client_uuid) as SessionRow;
        audit(db, me.id, existing ? 'session.start.replay' : 'session.start', 'sessions', row.id, {
          venue: b.venue,
          started_at: b.started_at,
        });
        return view(b.client_uuid);
      })();
    },
  );

  app.post<{ Params: { uuid: string }; Body: EndSessionBody }>(
    '/api/sessions/:uuid/end',
    { schema: endSchema },
    async (request) => {
      const me = request.user;
      const { ended_at } = request.body;
      notInFuture(ended_at, 'ended_at');

      return db.transaction(() => {
        const row = ownSession(me, request.params.uuid);
        if (row.started_at && Date.parse(ended_at) < Date.parse(row.started_at)) {
          throw new HttpError(400, 'ended_at is before started_at');
        }
        // Once the record is submitted, a late replay of "end" changes nothing.
        db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ? AND submitted_at IS NULL').run(
          ended_at,
          row.id,
        );
        audit(db, me.id, 'session.end', 'sessions', row.id, { ended_at });
        return view(row.client_uuid);
      })();
    },
  );

  app.post<{ Params: { uuid: string }; Body: LessonRecordBody }>(
    '/api/sessions/:uuid/record',
    { schema: recordSchema },
    async (request) => {
      const me = request.user;
      const b = request.body;
      if (b.started_at) notInFuture(b.started_at, 'started_at');
      if (b.ended_at) notInFuture(b.ended_at, 'ended_at');

      return db.transaction(() => {
        const row = ownSession(me, request.params.uuid);
        const startedAt = b.started_at ?? row.started_at;
        const endedAt = b.ended_at ?? row.ended_at;
        if (!startedAt || !endedAt) throw new HttpError(400, 'session needs a start and end time');
        if (Date.parse(endedAt) < Date.parse(startedAt)) {
          throw new HttpError(400, 'ended_at is before started_at');
        }

        db.prepare(
          `UPDATE sessions SET
             started_at = @started,
             session_date = @date,
             ended_at = @ended,
             attendance_status = @status,
             submitted_at = COALESCE(submitted_at, @now)
           WHERE id = @id`,
        ).run({
          id: row.id,
          started: startedAt,
          date: londonDate(startedAt),
          ended: endedAt,
          status: b.attendance_status ?? 'present',
          now: new Date().toISOString(),
        });

        db.prepare(
          `INSERT INTO lesson_records
             (session_id, lesson_summary, substitution_reason, next_lesson, problems,
              engagement, issues, needs_followup)
           VALUES (@session, @summary, @substitution, @next, @problems, @engagement, @issues, @followup)
           ON CONFLICT(session_id) DO UPDATE SET
             lesson_summary = excluded.lesson_summary,
             substitution_reason = excluded.substitution_reason,
             next_lesson = excluded.next_lesson,
             problems = excluded.problems,
             engagement = excluded.engagement,
             issues = excluded.issues,
             needs_followup = excluded.needs_followup`,
        ).run({
          session: row.id,
          summary: b.lesson_summary.trim(),
          substitution: b.planned_lesson ? null : blankToNull(b.substitution_reason),
          next: blankToNull(b.next_lesson),
          problems: blankToNull(b.problems),
          engagement: b.engagement,
          issues: blankToNull(b.issues),
          followup: b.needs_followup ? 1 : 0,
        });

        audit(
          db,
          me.id,
          row.submitted_at ? 'lesson_record.update' : 'lesson_record.submit',
          'sessions',
          row.id,
          { engagement: b.engagement, needs_followup: !!b.needs_followup },
        );
        return view(row.client_uuid);
      })();
    },
  );
}

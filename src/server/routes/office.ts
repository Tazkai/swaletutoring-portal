import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import {
  DOCUMENT_CATEGORIES,
  FUNDING_ROUTES,
  KEY_INFO_FIELDS,
  OFFICE_PUPIL_FIELDS,
  ROLES,
  type DocumentCategory,
  type KeyInfoField,
} from '../../shared/types.js';
import { isOversight } from '../auth.js';
import { HttpError } from '../access.js';
import { audit } from '../audit.js';
import type { DB } from '../db.js';

// Back office API (09_IT_Systems/Back_Office_Scope.md §3). Every route here is under
// /api/office/, which auth.ts only serves to an office-app token with an office role.

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const nstr = (max: number) => ({ type: ['string', 'null'], maxLength: max }) as const;
const ndate = { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] } as const;
const idParam = (name: string) =>
  ({
    type: 'object',
    required: [name],
    properties: { [name]: { type: 'string', pattern: '^[1-9][0-9]{0,9}$' } },
  }) as const;

const pupilProperties = {
  first_name: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' },
  last_name: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' },
  preferred_name: nstr(100),
  pronouns: nstr(50),
  date_of_birth: ndate,
  year_group: nstr(20),
  commissioner: { type: 'string', enum: ['kcc', 'school', 'other'] },
  commissioner_ref: nstr(200),
  funding_route: { anyOf: [{ type: 'string', enum: FUNDING_ROUTES }, { type: 'null' }] },
  caseworker_name: nstr(200),
  caseworker_email: nstr(200),
  caseworker_phone: nstr(50),
  kcc_urn: nstr(100),
  po_number: nstr(100),
  school_name: nstr(200),
  senco_name: nstr(200),
  senco_contact: nstr(200),
  hours_per_week: { anyOf: [{ type: 'number', minimum: 0, maximum: 40 }, { type: 'null' }] },
  delivery_mode: nstr(100),
  ehcp: { type: 'boolean' },
  ehcp_reference: nstr(100),
  looked_after: { type: 'boolean' },
  vsk_lot3: { type: 'boolean' },
  primary_presentation: nstr(2000),
  office_notes: nstr(4000),
  status: { type: 'string', enum: ['active', 'paused', 'exited'] },
  start_date: ndate,
  end_date: ndate,
} as const;

const keyInfoProperties = Object.fromEntries(KEY_INFO_FIELDS.map((f) => [f, nstr(4000)]));

const targetProperties = {
  ehcp_outcome: nstr(1000),
  target: { type: 'string', minLength: 1, maxLength: 1000, pattern: '\\S' },
  measure: nstr(1000),
  review_date: ndate,
  status: { type: 'string', enum: ['active', 'met', 'dropped'] },
} as const;

// Attendance as KCC reads it: sessions offered vs attended. A session we or the school
// cancelled was never offered, so it doesn't count against the pupil.
export const ATTENDANCE_SQL = `
  SUM(CASE WHEN s.submitted_at IS NOT NULL AND s.attendance_status IN ('present','late','left_early') THEN 1 ELSE 0 END) AS attended,
  SUM(CASE WHEN s.submitted_at IS NOT NULL AND s.attendance_status NOT IN ('cancelled_us','cancelled_school') THEN 1 ELSE 0 END) AS offered`;

type Row = Record<string, unknown>;

const toDbValue = (v: unknown) => (typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'string' ? v.trim() || null : v);

// Light content sniffing so a renamed file can't masquerade as a PDF or image.
function sniff(buf: Buffer, filename: string): { mime: string; ext: string } | null {
  const ext = path.extname(filename).toLowerCase();
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return { mime: 'application/pdf', ext: '.pdf' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: '.jpg' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: 'image/png', ext: '.png' };
  }
  if (buf[0] === 0x50 && buf[1] === 0x4b && ext === '.docx') {
    return { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: '.docx' };
  }
  return null;
}

export async function officeRoutes(app: FastifyInstance, db: DB, filesDir: string): Promise<void> {
  const docsDir = path.join(filesDir, 'documents');
  fs.mkdirSync(docsDir, { recursive: true, mode: 0o750 });

  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5, fieldSize: 1000 },
  });

  const getPupil = (id: number) => {
    const row = db.prepare('SELECT * FROM pupils WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new HttpError(404, 'pupil not found');
    return row;
  };
  const getUser = (id: number) => {
    const row = db.prepare('SELECT id, email, display_name, role, phone, active FROM users WHERE id = ?').get(id) as
      | Row
      | undefined;
    if (!row) throw new HttpError(404, 'user not found');
    return row;
  };
  const currentKeyInfo = (pupilId: number) =>
    db.prepare('SELECT * FROM pupil_key_info WHERE pupil_id = ? ORDER BY version DESC LIMIT 1').get(pupilId) as
      | Row
      | undefined;

  // ---------- pupils ----------

  app.get('/api/office/pupils', async () => {
    return db
      .prepare(
        `SELECT p.id, p.reference, p.first_name, p.last_name, p.preferred_name, p.status,
                p.commissioner, p.ehcp, p.looked_after, p.hours_per_week, p.start_date,
                (SELECT GROUP_CONCAT(u.display_name, ', ') FROM pupil_tutors pt
                   JOIN users u ON u.id = pt.user_id
                   WHERE pt.pupil_id = p.id AND pt.active = 1) AS tutors,
                (SELECT MAX(s.session_date) FROM sessions s WHERE s.pupil_id = p.id) AS last_session_date,
                (SELECT MAX(version) FROM pupil_key_info k WHERE k.pupil_id = p.id) AS key_info_version,
                att.attended, att.offered
         FROM pupils p
         LEFT JOIN (SELECT s.pupil_id, ${ATTENDANCE_SQL} FROM sessions s GROUP BY s.pupil_id) att
           ON att.pupil_id = p.id
         ORDER BY CASE p.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, p.last_name, p.first_name`,
      )
      .all();
  });

  app.post<{ Body: Row }>(
    '/api/office/pupils',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['first_name', 'last_name', 'commissioner'],
          properties: pupilProperties,
        },
      },
    },
    async (request, reply) => {
      const me = request.user;
      const b = request.body;
      const created = db.transaction(() => {
        const last = db
          .prepare(
            "SELECT MAX(CAST(SUBSTR(reference, 5) AS INTEGER)) FROM pupils WHERE reference GLOB 'STS-[0-9]*'",
          )
          .pluck()
          .get() as number | null;
        const reference = `STS-${String((last ?? 0) + 1).padStart(4, '0')}`;
        const cols = ['reference', ...Object.keys(b)];
        const info = db
          .prepare(
            `INSERT INTO pupils (${cols.join(', ')}, updated_at)
             VALUES (${cols.map((c) => `@${c}`).join(', ')}, datetime('now'))`,
          )
          .run({ reference, ...Object.fromEntries(Object.entries(b).map(([k, v]) => [k, toDbValue(v)])) });
        const id = Number(info.lastInsertRowid);
        audit(db, me.id, 'pupil.create', 'pupils', id, { reference, fields: Object.keys(b) });
        return getPupil(id);
      })();
      return reply.code(201).send(created);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/office/pupils/:id',
    { schema: { params: idParam('id') } },
    async (request) => {
      const id = Number(request.params.id);
      const pupil = getPupil(id);
      const keyInfo = currentKeyInfo(id);
      const tutors = db
        .prepare(
          `SELECT u.id, u.display_name, u.email, u.role, u.active AS user_active, pt.active,
                  ${keyInfo ? `(SELECT confirmed_at FROM key_info_confirmations c WHERE c.key_info_id = ${Number(keyInfo.id)} AND c.user_id = u.id)` : 'NULL'} AS key_info_confirmed_at
           FROM pupil_tutors pt JOIN users u ON u.id = pt.user_id
           WHERE pt.pupil_id = ? ORDER BY pt.active DESC, u.display_name`,
        )
        .all(id);
      const targets = db.prepare('SELECT * FROM pupil_targets WHERE pupil_id = ? ORDER BY status, id').all(id);
      const documents = db
        .prepare(
          `SELECT d.id, d.category, d.title, d.original_name, d.mime_type, d.size_bytes, d.uploaded_at,
                  u.display_name AS uploaded_by_name
           FROM documents d JOIN users u ON u.id = d.uploaded_by
           WHERE d.pupil_id = ? AND d.deleted_at IS NULL ORDER BY d.uploaded_at DESC`,
        )
        .all(id);
      const sessions = db
        .prepare(
          `SELECT s.client_uuid, s.session_date, s.started_at, s.ended_at, s.venue, s.attendance_status,
                  s.reported_by, s.non_attendance_note, s.submitted_at, u.display_name AS tutor_name,
                  lr.lesson_summary, lr.engagement, lr.next_lesson, lr.problems, lr.issues, lr.needs_followup
           FROM sessions s JOIN users u ON u.id = s.tutor_id
           LEFT JOIN lesson_records lr ON lr.session_id = s.id
           WHERE s.pupil_id = ? ORDER BY s.session_date DESC, s.started_at DESC LIMIT 200`,
        )
        .all(id);
      const attendance = db.prepare(`SELECT ${ATTENDANCE_SQL} FROM sessions s WHERE s.pupil_id = ?`).get(id);
      return { pupil, key_info: keyInfo ?? null, tutors, targets, documents, sessions, attendance };
    },
  );

  app.patch<{ Params: { id: string }; Body: Row }>(
    '/api/office/pupils/:id',
    {
      schema: {
        params: idParam('id'),
        body: { type: 'object', additionalProperties: false, minProperties: 1, properties: pupilProperties },
      },
    },
    async (request) => {
      const id = Number(request.params.id);
      const b = request.body;
      return db.transaction(() => {
        getPupil(id);
        const keys = Object.keys(b).filter((k) => (OFFICE_PUPIL_FIELDS as readonly string[]).includes(k));
        db.prepare(
          `UPDATE pupils SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = datetime('now')
           WHERE id = @id`,
        ).run({ id, ...Object.fromEntries(keys.map((k) => [k, toDbValue(b[k])])) });
        // Field names only: the audit log is not a second copy of the pupil's record.
        audit(db, request.user.id, 'pupil.update', 'pupils', id, { fields: keys });
        return getPupil(id);
      })();
    },
  );

  // ---------- key information (versioned) ----------

  app.put<{ Params: { id: string }; Body: Partial<Record<KeyInfoField, string | null>> }>(
    '/api/office/pupils/:id/key-info',
    {
      schema: {
        params: idParam('id'),
        body: { type: 'object', additionalProperties: false, properties: keyInfoProperties },
      },
    },
    async (request) => {
      const id = Number(request.params.id);
      const b = request.body;
      return db.transaction(() => {
        getPupil(id);
        const current = currentKeyInfo(id);
        const next = Object.fromEntries(KEY_INFO_FIELDS.map((f) => [f, toDbValue(b[f] ?? null)]));
        // An unchanged save doesn't create a new version, so tutors aren't asked to re-read.
        if (current && KEY_INFO_FIELDS.every((f) => (current[f] ?? null) === next[f])) return current;
        const version = Number(current?.version ?? 0) + 1;
        const info = db
          .prepare(
            `INSERT INTO pupil_key_info (pupil_id, version, created_by, ${KEY_INFO_FIELDS.join(', ')})
             VALUES (@pupil, @version, @by, ${KEY_INFO_FIELDS.map((f) => `@${f}`).join(', ')})`,
          )
          .run({ pupil: id, version, by: request.user.id, ...next });
        audit(db, request.user.id, 'key_info.version', 'pupils', id, {
          version,
          key_info_id: Number(info.lastInsertRowid),
        });
        return currentKeyInfo(id);
      })();
    },
  );

  // ---------- targets ----------

  app.post<{ Params: { id: string }; Body: Row }>(
    '/api/office/pupils/:id/targets',
    {
      schema: {
        params: idParam('id'),
        body: { type: 'object', additionalProperties: false, required: ['target'], properties: targetProperties },
      },
    },
    async (request, reply) => {
      const id = Number(request.params.id);
      const b = request.body;
      const target = db.transaction(() => {
        getPupil(id);
        const cols = Object.keys(b);
        const info = db
          .prepare(
            `INSERT INTO pupil_targets (pupil_id, ${cols.join(', ')}) VALUES (@pupil, ${cols.map((c) => `@${c}`).join(', ')})`,
          )
          .run({ pupil: id, ...Object.fromEntries(cols.map((c) => [c, toDbValue(b[c])])) });
        const targetId = Number(info.lastInsertRowid);
        audit(db, request.user.id, 'target.create', 'pupils', id, { target_id: targetId });
        return db.prepare('SELECT * FROM pupil_targets WHERE id = ?').get(targetId);
      })();
      return reply.code(201).send(target);
    },
  );

  app.patch<{ Params: { targetId: string }; Body: Row }>(
    '/api/office/targets/:targetId',
    {
      schema: {
        params: idParam('targetId'),
        body: { type: 'object', additionalProperties: false, minProperties: 1, properties: targetProperties },
      },
    },
    async (request) => {
      const targetId = Number(request.params.targetId);
      const b = request.body;
      return db.transaction(() => {
        const existing = db.prepare('SELECT pupil_id FROM pupil_targets WHERE id = ?').get(targetId) as
          | { pupil_id: number }
          | undefined;
        if (!existing) throw new HttpError(404, 'target not found');
        const cols = Object.keys(b);
        db.prepare(
          `UPDATE pupil_targets SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_at = datetime('now') WHERE id = @id`,
        ).run({ id: targetId, ...Object.fromEntries(cols.map((c) => [c, toDbValue(b[c])])) });
        audit(db, request.user.id, 'target.update', 'pupils', existing.pupil_id, { target_id: targetId, fields: cols });
        return db.prepare('SELECT * FROM pupil_targets WHERE id = ?').get(targetId);
      })();
    },
  );

  // ---------- assignments ----------

  const assignParams = {
    type: 'object',
    required: ['id', 'userId'],
    properties: {
      id: { type: 'string', pattern: '^[1-9][0-9]{0,9}$' },
      userId: { type: 'string', pattern: '^[1-9][0-9]{0,9}$' },
    },
  } as const;

  app.put<{ Params: { id: string; userId: string } }>(
    '/api/office/pupils/:id/tutors/:userId',
    { schema: { params: assignParams } },
    async (request) => {
      const pupilId = Number(request.params.id);
      const userId = Number(request.params.userId);
      return db.transaction(() => {
        getPupil(pupilId);
        const user = getUser(userId);
        if (!user.active) throw new HttpError(409, 'that user is deactivated');
        db.prepare(
          `INSERT INTO pupil_tutors (pupil_id, user_id, active) VALUES (?, ?, 1)
           ON CONFLICT(pupil_id, user_id) DO UPDATE SET active = 1`,
        ).run(pupilId, userId);
        audit(db, request.user.id, 'pupil.assign', 'pupils', pupilId, { user_id: userId });
        return { pupil_id: pupilId, user_id: userId, active: 1 };
      })();
    },
  );

  app.delete<{ Params: { id: string; userId: string } }>(
    '/api/office/pupils/:id/tutors/:userId',
    { schema: { params: assignParams } },
    async (request) => {
      const pupilId = Number(request.params.id);
      const userId = Number(request.params.userId);
      return db.transaction(() => {
        const info = db
          .prepare('UPDATE pupil_tutors SET active = 0 WHERE pupil_id = ? AND user_id = ?')
          .run(pupilId, userId);
        if (!info.changes) throw new HttpError(404, 'assignment not found');
        audit(db, request.user.id, 'pupil.unassign', 'pupils', pupilId, { user_id: userId });
        return { pupil_id: pupilId, user_id: userId, active: 0 };
      })();
    },
  );

  // ---------- users ----------

  app.get('/api/office/users', async () => {
    return db
      .prepare(
        `SELECT u.id, u.email, u.display_name, u.role, u.phone, u.active, u.created_at,
                (SELECT COUNT(*) FROM pupil_tutors pt JOIN pupils p ON p.id = pt.pupil_id
                   WHERE pt.user_id = u.id AND pt.active = 1 AND p.status = 'active') AS active_pupils
         FROM users u ORDER BY u.active DESC, u.display_name`,
      )
      .all();
  });

  const userEditable = {
    display_name: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' },
    role: { type: 'string', enum: ROLES },
    phone: nstr(50),
  } as const;

  app.post<{ Body: { email: string; display_name: string; role: string; phone?: string | null } }>(
    '/api/office/users',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['email', 'display_name', 'role'],
          properties: { ...userEditable, email: { type: 'string', format: 'email', maxLength: 200 } },
        },
      },
    },
    async (request, reply) => {
      const b = request.body;
      const created = db.transaction(() => {
        const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(b.email.trim());
        if (exists) throw new HttpError(409, 'a user with that email already exists');
        const info = db
          .prepare('INSERT INTO users (email, display_name, role, phone) VALUES (?, ?, ?, ?)')
          .run(b.email.trim(), b.display_name.trim(), b.role, toDbValue(b.phone ?? null));
        const id = Number(info.lastInsertRowid);
        audit(db, request.user.id, 'user.create', 'users', id, { role: b.role });
        return getUser(id);
      })();
      return reply.code(201).send({ ...created, access_policy_reminder: 'add' });
    },
  );

  app.patch<{ Params: { id: string }; Body: Row }>(
    '/api/office/users/:id',
    {
      schema: {
        params: idParam('id'),
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: { ...userEditable, active: { type: 'boolean' } },
        },
      },
    },
    async (request) => {
      const id = Number(request.params.id);
      const b = request.body;
      const me = request.user;
      return db.transaction(() => {
        const before = getUser(id);
        // Stop someone locking themselves (and possibly everyone) out of the office.
        if (id === me.id && (b.active === false || (typeof b.role === 'string' && b.role === 'tutor'))) {
          throw new HttpError(409, "you can't remove your own office access");
        }
        const cols = Object.keys(b);
        db.prepare(`UPDATE users SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`).run({
          id,
          ...Object.fromEntries(cols.map((c) => [c, toDbValue(b[c])])),
        });
        if (b.active === false) db.prepare('UPDATE pupil_tutors SET active = 0 WHERE user_id = ?').run(id);
        audit(db, me.id, b.active === false ? 'user.deactivate' : 'user.update', 'users', id, { fields: cols });
        const after = getUser(id);
        const reminder =
          before.active && !after.active ? 'remove' : !before.active && after.active ? 'add' : undefined;
        return { ...after, ...(reminder ? { access_policy_reminder: reminder } : {}) };
      })();
    },
  );

  // ---------- documents ----------

  app.post<{ Params: { id: string } }>(
    '/api/office/pupils/:id/documents',
    { schema: { params: idParam('id') } },
    async (request, reply) => {
      const pupilId = Number(request.params.id);
      getPupil(pupilId);
      if (!request.isMultipart()) throw new HttpError(400, 'expected a file upload');

      let category: string | undefined;
      let title: string | undefined;
      let file: { buffer: Buffer; filename: string } | undefined;
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          if (file) throw new HttpError(400, 'one file at a time');
          const buffer = await part.toBuffer();
          if (part.file.truncated) throw new HttpError(413, 'file is larger than 20 MB');
          file = { buffer, filename: part.filename };
        } else if (part.fieldname === 'category') {
          category = String(part.value);
        } else if (part.fieldname === 'title') {
          title = String(part.value).trim();
        }
      }
      if (!file || file.buffer.length === 0) throw new HttpError(400, 'no file');
      if (!category || !(DOCUMENT_CATEGORIES as readonly string[]).includes(category)) {
        throw new HttpError(400, 'unknown category');
      }
      const kind = sniff(file.buffer, file.filename);
      if (!kind) throw new HttpError(415, 'only PDF, Word (.docx), JPEG or PNG files');

      const storedName = `${randomUUID()}${kind.ext}`;
      const sha256 = createHash('sha256').update(file.buffer).digest('hex');
      const originalName = path.basename(file.filename).replace(/[^\w.\- ()]/g, '_').slice(0, 200) || `document${kind.ext}`;
      fs.writeFileSync(path.join(docsDir, storedName), file.buffer, { mode: 0o640, flag: 'wx' });

      try {
        const doc = db.transaction(() => {
          const info = db
            .prepare(
              `INSERT INTO documents (pupil_id, category, title, stored_name, original_name, mime_type, size_bytes, sha256, uploaded_by)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              pupilId,
              category as DocumentCategory,
              (title || originalName).slice(0, 200),
              storedName,
              originalName,
              kind.mime,
              file!.buffer.length,
              sha256,
              request.user.id,
            );
          const docId = Number(info.lastInsertRowid);
          audit(db, request.user.id, 'document.upload', 'pupils', pupilId, { document_id: docId, category });
          return db
            .prepare('SELECT id, category, title, original_name, mime_type, size_bytes, uploaded_at FROM documents WHERE id = ?')
            .get(docId);
        })();
        return reply.code(201).send(doc);
      } catch (err) {
        fs.rmSync(path.join(docsDir, storedName), { force: true });
        throw err;
      }
    },
  );

  app.get<{ Params: { docId: string } }>(
    '/api/office/documents/:docId',
    { schema: { params: idParam('docId') } },
    async (request, reply) => {
      const doc = db
        .prepare('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL')
        .get(Number(request.params.docId)) as Row | undefined;
      if (!doc) throw new HttpError(404, 'document not found');
      const file = path.join(docsDir, String(doc.stored_name));
      if (!fs.existsSync(file)) throw new HttpError(410, 'file missing from storage');
      audit(db, request.user.id, 'document.view', 'pupils', Number(doc.pupil_id), { document_id: doc.id });
      const safeName = String(doc.original_name).replace(/["\\\r\n]/g, '_');
      return reply
        .header('Content-Type', String(doc.mime_type))
        .header('Content-Disposition', `attachment; filename="${safeName}"`)
        .send(fs.createReadStream(file));
    },
  );

  app.delete<{ Params: { docId: string } }>(
    '/api/office/documents/:docId',
    { schema: { params: idParam('docId') } },
    async (request) => {
      const docId = Number(request.params.docId);
      const doc = db.transaction(() => {
        const row = db.prepare('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL').get(docId) as
          | Row
          | undefined;
        if (!row) throw new HttpError(404, 'document not found');
        db.prepare("UPDATE documents SET deleted_at = datetime('now'), deleted_by = ? WHERE id = ?").run(
          request.user.id,
          docId,
        );
        // The row stays as the disposal record the Retention policy requires.
        audit(db, request.user.id, 'document.dispose', 'pupils', Number(row.pupil_id), { document_id: docId });
        return row;
      })();
      fs.rmSync(path.join(docsDir, String(doc.stored_name)), { force: true });
      return { id: docId, disposed: true };
    },
  );

  // ---------- audit log ----------

  app.get<{ Querystring: { entity?: string; entity_id?: string; limit?: string } }>(
    '/api/office/audit',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            entity: { type: 'string', enum: ['pupils', 'sessions', 'users'] },
            entity_id: { type: 'string', pattern: '^[1-9][0-9]{0,9}$' },
            limit: { type: 'string', pattern: '^[1-9][0-9]{0,3}$' },
          },
        },
      },
    },
    async (request) => {
      const q = request.query;
      const where: string[] = [];
      const params: Record<string, unknown> = { limit: Math.min(Number(q.limit ?? 200), 1000) };
      if (q.entity) {
        where.push('a.entity = @entity');
        params.entity = q.entity;
      }
      if (q.entity_id) {
        where.push('a.entity_id = @entity_id');
        params.entity_id = Number(q.entity_id);
      }
      return db
        .prepare(
          `SELECT a.id, a.action, a.entity, a.entity_id, a.detail, a.created_at, u.display_name AS actor
           FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
           ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
           ORDER BY a.id DESC LIMIT @limit`,
        )
        .all(params);
    },
  );

  app.get('/api/office/me', async (request) => ({ user: request.user, is_office: isOversight(request.user) }));
}

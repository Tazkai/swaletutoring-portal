import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { isoMinutesAgo, makeHarness, type Harness } from './helpers.js';

const A = 'tutor-a@example.test';
const B = 'tutor-b@example.test';
const DSL = 'dsl@example.test';

describe('sessions, pupils and access rules', () => {
  let h: Harness;
  before(async () => {
    h = await makeHarness();
  });
  after(async () => {
    await h.app.close();
  });

  const call = async (email: string, method: 'GET' | 'POST', url: string, payload?: object) =>
    h.app.inject({ method, url, headers: await h.as(email), payload });

  const start = (email: string, pupil: number, uuid = randomUUID(), minutesAgo = 60) =>
    call(email, 'POST', '/api/sessions/start', {
      client_uuid: uuid,
      pupil_id: pupil,
      venue: 'home',
      started_at: isoMinutesAgo(minutesAgo),
    });

  const record = (email: string, uuid: string, extra: object = {}) =>
    call(email, 'POST', `/api/sessions/${uuid}/record`, {
      ended_at: isoMinutesAgo(1),
      lesson_summary: 'Fractions: equivalent fractions with pizza diagrams.',
      planned_lesson: true,
      engagement: 2,
      ...extra,
    });

  const count = (sql: string, ...params: unknown[]) =>
    h.db.prepare(sql).pluck().get(...params) as number;

  // ---- AT3 ----
  describe('AT3: Tutor A cannot reach Tutor B’s pupil by any route', () => {
    test('pupil list contains only A’s pupils', async () => {
      const res = await call(A, 'GET', '/api/pupils');
      assert.equal(res.statusCode, 200);
      const ids = res.json().map((p: { id: number }) => p.id).sort();
      assert.deepEqual(ids, [h.pupils.a1, h.pupils.a2].sort());
    });

    test('GET /api/pupils/:id for B’s pupil is 404', async () => {
      assert.equal((await call(A, 'GET', `/api/pupils/${h.pupils.b1}`)).statusCode, 404);
    });

    test('GET /api/pupils/:id/sessions for B’s pupil is 404', async () => {
      assert.equal((await call(A, 'GET', `/api/pupils/${h.pupils.b1}/sessions`)).statusCode, 404);
    });

    test('guessed pupil IDs all 404 (no difference between hidden and non-existent)', async () => {
      for (const id of [h.pupils.b1, 999, 1_000_000]) {
        assert.equal((await call(A, 'GET', `/api/pupils/${id}`)).statusCode, 404);
      }
    });

    test('A cannot start a session for B’s pupil', async () => {
      const res = await start(A, h.pupils.b1);
      assert.equal(res.statusCode, 404);
      assert.equal(count('SELECT COUNT(*) FROM sessions WHERE pupil_id = ?', h.pupils.b1), 0);
    });

    test('A cannot end, record or hijack B’s session, even knowing its uuid', async () => {
      const uuid = randomUUID();
      assert.equal((await start(B, h.pupils.b1, uuid)).statusCode, 200);

      assert.equal(
        (await call(A, 'POST', `/api/sessions/${uuid}/end`, { ended_at: isoMinutesAgo(1) })).statusCode,
        404,
      );
      assert.equal((await record(A, uuid)).statusCode, 404);
      // Replaying B's uuid against A's own pupil must not take the row over.
      assert.equal((await start(A, h.pupils.a1, uuid)).statusCode, 409);

      const row = h.db
        .prepare('SELECT pupil_id, ended_at, submitted_at FROM sessions WHERE client_uuid = ?')
        .get(uuid) as { pupil_id: number; ended_at: string | null; submitted_at: string | null };
      assert.equal(row.pupil_id, h.pupils.b1);
      assert.equal(row.ended_at, null);
      assert.equal(row.submitted_at, null);
    });

    test('B’s open session does not appear in A’s open sessions', async () => {
      const res = await call(A, 'GET', '/api/sessions/open');
      for (const s of res.json()) assert.notEqual(s.pupil_id, h.pupils.b1);
    });

    test('the DSL can see every pupil', async () => {
      const res = await call(DSL, 'GET', '/api/pupils');
      assert.equal(res.json().length, 3);
    });
  });

  // ---- AT4 (server half) ----
  test('AT4 (server half): an open session is returned by /api/sessions/open until submitted', async () => {
    const uuid = randomUUID();
    await start(A, h.pupils.a2, uuid);
    let open = (await call(A, 'GET', '/api/sessions/open')).json();
    assert.ok(open.some((s: { client_uuid: string }) => s.client_uuid === uuid));

    assert.equal((await record(A, uuid)).statusCode, 200);
    open = (await call(A, 'GET', '/api/sessions/open')).json();
    assert.ok(!open.some((s: { client_uuid: string }) => s.client_uuid === uuid));
  });

  // ---- AT5 ----
  test('AT5: replaying the same client_uuid creates exactly one row', async () => {
    const uuid = randomUUID();
    const startedAt = isoMinutesAgo(50);
    const body = { client_uuid: uuid, pupil_id: h.pupils.a1, venue: 'community', started_at: startedAt };

    for (let i = 0; i < 2; i++) {
      assert.equal((await call(A, 'POST', '/api/sessions/start', body)).statusCode, 200);
    }
    for (let i = 0; i < 2; i++) {
      const res = await call(A, 'POST', `/api/sessions/${uuid}/end`, { ended_at: isoMinutesAgo(2) });
      assert.equal(res.statusCode, 200);
    }
    for (let i = 0; i < 2; i++) {
      assert.equal((await record(A, uuid)).statusCode, 200);
    }

    assert.equal(count('SELECT COUNT(*) FROM sessions WHERE client_uuid = ?', uuid), 1);
    assert.equal(
      count(
        'SELECT COUNT(*) FROM lesson_records lr JOIN sessions s ON s.id = lr.session_id WHERE s.client_uuid = ?',
        uuid,
      ),
      1,
    );

    // A replayed "start" after submission changes nothing.
    await call(A, 'POST', '/api/sessions/start', { ...body, venue: 'online', started_at: isoMinutesAgo(5) });
    const row = h.db
      .prepare('SELECT venue, started_at FROM sessions WHERE client_uuid = ?')
      .get(uuid) as { venue: string; started_at: string };
    assert.equal(row.venue, 'community');
    assert.equal(row.started_at, startedAt);
  });

  // ---- AT6 ----
  describe('AT6: engagement must be 1, 2 or 3', () => {
    for (const good of [1, 2, 3]) {
      test(`accepts ${good}`, async () => {
        const uuid = randomUUID();
        await start(A, h.pupils.a1, uuid);
        assert.equal((await record(A, uuid, { engagement: good })).statusCode, 200);
        const saved = h.db
          .prepare(
            'SELECT lr.engagement FROM lesson_records lr JOIN sessions s ON s.id = lr.session_id WHERE s.client_uuid = ?',
          )
          .pluck()
          .get(uuid);
        assert.equal(saved, good);
      });
    }
    for (const bad of [0, 4, -1, 1.5, '2', null, 'excellent']) {
      test(`rejects ${JSON.stringify(bad)}`, async () => {
        const uuid = randomUUID();
        await start(A, h.pupils.a1, uuid);
        assert.equal((await record(A, uuid, { engagement: bad })).statusCode, 400);
        assert.equal(
          count(
            'SELECT COUNT(*) FROM lesson_records lr JOIN sessions s ON s.id = lr.session_id WHERE s.client_uuid = ?',
            uuid,
          ),
          0,
        );
      });
    }
    test('missing engagement is rejected', async () => {
      const uuid = randomUUID();
      await start(A, h.pupils.a1, uuid);
      const res = await call(A, 'POST', `/api/sessions/${uuid}/record`, {
        ended_at: isoMinutesAgo(1),
        lesson_summary: 'x',
        planned_lesson: true,
      });
      assert.equal(res.statusCode, 400);
    });
    test('the database itself refuses engagement outside 1-3', () => {
      assert.throws(() =>
        h.db.prepare('INSERT INTO lesson_records (session_id, engagement) VALUES (1, 4)').run(),
      );
    });
  });

  // ---- AT7 ----
  test('AT7: every write appears in audit_log', async () => {
    const before = count('SELECT COUNT(*) FROM audit_log');
    const uuid = randomUUID();
    await start(A, h.pupils.a1, uuid);
    await call(A, 'POST', `/api/sessions/${uuid}/end`, { ended_at: isoMinutesAgo(1) });
    await record(A, uuid);
    await record(A, uuid, { engagement: 1 }); // an edit is a write too

    const sessionId = count('SELECT id FROM sessions WHERE client_uuid = ?', uuid);
    const actions = h.db
      .prepare("SELECT action FROM audit_log WHERE entity = 'sessions' AND entity_id = ? ORDER BY id")
      .pluck()
      .all(sessionId);
    assert.deepEqual(actions, [
      'session.start',
      'session.end',
      'lesson_record.submit',
      'lesson_record.update',
    ]);
    assert.equal(count('SELECT COUNT(*) FROM audit_log') - before, 4);
    // The actor is recorded, and lesson content is not copied into the log.
    const rows = h.db.prepare('SELECT actor_user_id, detail FROM audit_log WHERE entity_id = ?').all(sessionId) as {
      actor_user_id: number;
      detail: string;
    }[];
    for (const r of rows) {
      assert.ok(r.actor_user_id);
      assert.ok(!r.detail.includes('Fractions'));
    }
  });

  test('a rejected write leaves no audit row', async () => {
    const before = count('SELECT COUNT(*) FROM audit_log');
    await start(A, h.pupils.b1);
    assert.equal(count('SELECT COUNT(*) FROM audit_log'), before);
  });

  // ---- other validation ----
  test('the substitution reason is dropped when the planned lesson was delivered', async () => {
    const uuid = randomUUID();
    await start(A, h.pupils.a1, uuid);
    await record(A, uuid, { planned_lesson: true, substitution_reason: 'should not be kept' });
    const saved = h.db
      .prepare(
        'SELECT substitution_reason FROM lesson_records lr JOIN sessions s ON s.id = lr.session_id WHERE s.client_uuid = ?',
      )
      .pluck()
      .get(uuid);
    assert.equal(saved, null);
  });

  test('end before start, future timestamps and unknown fields are rejected', async () => {
    const uuid = randomUUID();
    await start(A, h.pupils.a1, uuid, 30);
    assert.equal(
      (await call(A, 'POST', `/api/sessions/${uuid}/end`, { ended_at: isoMinutesAgo(60) })).statusCode,
      400,
    );
    assert.equal((await start(A, h.pupils.a1, randomUUID(), -120)).statusCode, 400);
    assert.equal((await record(A, uuid, { gps: '51.3,0.7' })).statusCode, 400);
  });

  test('a record cannot be submitted for a session with no end time', async () => {
    const uuid = randomUUID();
    await start(A, h.pupils.a1, uuid);
    const res = await call(A, 'POST', `/api/sessions/${uuid}/record`, {
      lesson_summary: 'x',
      planned_lesson: true,
      engagement: 1,
    });
    assert.equal(res.statusCode, 400);
  });
});

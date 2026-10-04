import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, multipart, type Harness } from './helpers.js';

const A = 'tutor-a@example.test';
const B = 'tutor-b@example.test';
const DSL = 'dsl@example.test';

describe('back office API', () => {
  let h: Harness;
  before(async () => {
    h = await makeHarness();
  });
  after(async () => {
    await h.app.close();
  });

  const office = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object, email = DSL) =>
    h.app.inject({ method, url, headers: await h.asOffice(email), payload });
  const portal = async (method: 'GET' | 'POST', url: string, email: string, payload?: object) =>
    h.app.inject({ method, url, headers: await h.as(email), payload });
  const count = (sql: string, ...params: unknown[]) => h.db.prepare(sql).pluck().get(...params) as number;
  const userId = (email: string) => count('SELECT id FROM users WHERE email = ?', email);

  // ---------- the two locks ----------
  describe('access: office-app token AND office role', () => {
    test('a portal-app token is refused, even for the DSL', async () => {
      const res = await portal('GET', '/api/office/pupils', DSL);
      assert.equal(res.statusCode, 403);
    });

    test('an office-app token for a tutor is refused', async () => {
      const res = await office('GET', '/api/office/pupils', undefined, A);
      assert.equal(res.statusCode, 403);
    });

    test('an office-app token for the DSL is accepted', async () => {
      assert.equal((await office('GET', '/api/office/pupils')).statusCode, 200);
    });

    test('percent-encoded paths cannot slip past the check', async () => {
      for (const url of ['/%61pi/office/pupils', '/api/%6Fffice/pupils', '/api/office%2Fpupils', '/API/office/pupils']) {
        const res = await h.app.inject({ method: 'GET', url, headers: await h.as(DSL) });
        assert.notEqual(res.statusCode, 200, `${url} returned 200`);
        const noToken = await h.app.inject({ method: 'GET', url });
        assert.notEqual(noToken.statusCode, 200, `${url} without a token returned 200`);
      }
    });

    test('no token at all is refused', async () => {
      assert.equal((await h.app.inject({ method: 'GET', url: '/api/office/pupils' })).statusCode, 403);
    });

    test('with the office not configured, an office token is refused everywhere', async () => {
      const off = await makeHarness({ officeEnabled: false });
      try {
        const headers = await off.asOffice(DSL);
        assert.equal((await off.app.inject({ method: 'GET', url: '/api/office/pupils', headers })).statusCode, 403);
        assert.equal((await off.app.inject({ method: 'GET', url: '/api/me', headers })).statusCode, 403);
      } finally {
        await off.app.close();
      }
    });
  });

  // ---------- pupils ----------
  describe('pupils', () => {
    let pupilId: number;

    test('creating a pupil assigns the next STS reference', async () => {
      const res = await office('POST', '/api/office/pupils', {
        first_name: 'Erin',
        last_name: 'Example',
        commissioner: 'kcc',
        ehcp: true,
        hours_per_week: 10,
        date_of_birth: '2012-03-04',
      });
      assert.equal(res.statusCode, 201);
      const p = res.json();
      assert.equal(p.reference, 'STS-0001');
      assert.equal(p.ehcp, 1);
      pupilId = p.id;
      const second = await office('POST', '/api/office/pupils', { first_name: 'Finn', last_name: 'Fixture', commissioner: 'school' });
      assert.equal(second.json().reference, 'STS-0002');
    });

    test('bad input is rejected', async () => {
      for (const body of [
        { last_name: 'X', commissioner: 'kcc' },
        { first_name: ' ', last_name: 'X', commissioner: 'kcc' },
        { first_name: 'A', last_name: 'X', commissioner: 'council' },
        { first_name: 'A', last_name: 'X', commissioner: 'kcc', hours_per_week: 99 },
        { first_name: 'A', last_name: 'X', commissioner: 'kcc', reference: 'STS-9999' },
        { first_name: 'A', last_name: 'X', commissioner: 'kcc', date_of_birth: '04/03/2012' },
      ]) {
        assert.equal((await office('POST', '/api/office/pupils', body)).statusCode, 400, JSON.stringify(body));
      }
    });

    test('editing records the changed field names in the audit log, not the values', async () => {
      const res = await office('PATCH', `/api/office/pupils/${pupilId}`, { looked_after: true, office_notes: 'Secret note' });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().looked_after, 1);
      const detail = h.db
        .prepare("SELECT detail FROM audit_log WHERE action = 'pupil.update' ORDER BY id DESC LIMIT 1")
        .pluck()
        .get() as string;
      assert.match(detail, /office_notes/);
      assert.doesNotMatch(detail, /Secret note/);
    });

    test('a 404 for an unknown pupil', async () => {
      assert.equal((await office('GET', '/api/office/pupils/9999')).statusCode, 404);
      assert.equal((await office('PATCH', '/api/office/pupils/9999', { status: 'paused' })).statusCode, 404);
    });

    test('the detail view brings the record together', async () => {
      const res = await office('GET', `/api/office/pupils/${pupilId}`);
      assert.equal(res.statusCode, 200);
      const body = res.json();
      for (const k of ['pupil', 'key_info', 'tutors', 'targets', 'documents', 'sessions', 'attendance']) {
        assert.ok(k in body, k);
      }
    });

    // ---------- assignments + key information ----------
    test('assigning a tutor makes the pupil appear on their phone', async () => {
      assert.equal((await office('PUT', `/api/office/pupils/${pupilId}/tutors/${userId(B)}`)).statusCode, 200);
      const list = (await portal('GET', '/api/pupils', B)).json();
      const p = list.find((x: { id: number }) => x.id === pupilId);
      assert.ok(p);
      assert.equal(p.key_info_version, null);
      assert.equal(p.first_aider_required, 1); // looked_after was set above
    });

    test('key information is versioned, and an unchanged save keeps the version', async () => {
      const v1 = await office('PUT', `/api/office/pupils/${pupilId}/key-info`, { allergies: 'Peanuts', triggers: 'Loud noise' });
      assert.equal(v1.json().version, 1);
      const same = await office('PUT', `/api/office/pupils/${pupilId}/key-info`, { allergies: 'Peanuts', triggers: 'Loud noise' });
      assert.equal(same.json().version, 1);
      const v2 = await office('PUT', `/api/office/pupils/${pupilId}/key-info`, { allergies: 'Peanuts, sesame', triggers: 'Loud noise' });
      assert.equal(v2.json().version, 2);
    });

    test('the tutor reads and confirms the current version; replays are harmless', async () => {
      let info = (await portal('GET', `/api/pupils/${pupilId}/key-info`, B)).json();
      assert.equal(info.version, 2);
      assert.equal(info.fields.allergies, 'Peanuts, sesame');
      assert.equal(info.confirmed_at, null);
      assert.equal(info.first_aider_required, true);

      for (let i = 0; i < 2; i++) {
        const res = await portal('POST', `/api/pupils/${pupilId}/key-info/confirm`, B, { version: 2 });
        assert.equal(res.statusCode, 200);
      }
      assert.equal(
        count("SELECT COUNT(*) FROM audit_log WHERE action = 'key_info.confirm' AND entity_id = ?", pupilId),
        1,
      );
      info = (await portal('GET', `/api/pupils/${pupilId}/key-info`, B)).json();
      assert.ok(info.confirmed_at);
      const p = (await portal('GET', '/api/pupils', B)).json().find((x: { id: number }) => x.id === pupilId);
      assert.equal(p.key_info_confirmed, 1);

      // A new version needs a fresh confirmation.
      await office('PUT', `/api/office/pupils/${pupilId}/key-info`, { allergies: 'Peanuts, sesame', triggers: 'Loud noise, crowds' });
      const p2 = (await portal('GET', '/api/pupils', B)).json().find((x: { id: number }) => x.id === pupilId);
      assert.equal(p2.key_info_version, 3);
      assert.equal(p2.key_info_confirmed, 0);
    });

    test('the office sees which tutor confirmed which version', async () => {
      const body = (await office('GET', `/api/office/pupils/${pupilId}`)).json();
      assert.equal(body.key_info.version, 3);
      const b = body.tutors.find((t: { email: string }) => t.email === B);
      assert.equal(b.key_info_confirmed_at, null); // confirmed v2, not the current v3
    });

    test('an unassigned tutor cannot read or confirm key information', async () => {
      assert.equal((await portal('GET', `/api/pupils/${pupilId}/key-info`, A)).statusCode, 404);
      assert.equal((await portal('POST', `/api/pupils/${pupilId}/key-info/confirm`, A, { version: 3 })).statusCode, 404);
    });

    test('targets: created by the office; tutors see the active ones', async () => {
      const t1 = await office('POST', `/api/office/pupils/${pupilId}/targets`, {
        ehcp_outcome: 'Communication',
        target: 'Ask for help using a card',
        review_date: '2026-11-01',
      });
      assert.equal(t1.statusCode, 201);
      const t2 = await office('POST', `/api/office/pupils/${pupilId}/targets`, { target: 'Read for 10 minutes' });
      await office('PATCH', `/api/office/targets/${t2.json().id}`, { status: 'met' });
      const info = (await portal('GET', `/api/pupils/${pupilId}/key-info`, B)).json();
      assert.deepEqual(info.targets.map((t: { target: string }) => t.target), ['Ask for help using a card']);
      assert.equal((await office('POST', `/api/office/pupils/${pupilId}/targets`, { measure: 'x' })).statusCode, 400);
    });

    test('unassigning removes the pupil from the tutor', async () => {
      assert.equal((await office('DELETE', `/api/office/pupils/${pupilId}/tutors/${userId(B)}`)).statusCode, 200);
      const list = (await portal('GET', '/api/pupils', B)).json();
      assert.ok(!list.some((x: { id: number }) => x.id === pupilId));
      assert.equal((await portal('GET', `/api/pupils/${pupilId}/key-info`, B)).statusCode, 404);
    });

    // ---------- documents ----------
    describe('documents', () => {
      const pdf = Buffer.from('%PDF-1.4\n% fabricated test document\n%%EOF\n');
      let docId: number;

      test('a PDF uploads, and downloads byte-for-byte as an attachment', async () => {
        const body = multipart({ category: 'ehcp', title: 'EHCP 2026' }, { name: 'ehcp.pdf', content: pdf, type: 'application/pdf' });
        const up = await h.app.inject({
          method: 'POST',
          url: `/api/office/pupils/${pupilId}/documents`,
          headers: { ...(await h.asOffice(DSL)), ...body.headers },
          payload: body.payload,
        });
        assert.equal(up.statusCode, 201, up.body);
        docId = up.json().id;
        const stored = fs.readdirSync(path.join(h.filesDir, 'documents'));
        assert.equal(stored.length, 1);
        assert.match(stored[0] ?? '', /^[0-9a-f-]{36}\.pdf$/); // random name, not the upload's

        const down = await office('GET', `/api/office/documents/${docId}`);
        assert.equal(down.statusCode, 200);
        assert.deepEqual(down.rawPayload, pdf);
        assert.match(String(down.headers['content-disposition']), /^attachment; filename="ehcp.pdf"/);
        assert.equal(down.headers['cache-control'], 'no-store');
      });

      test('a file that is not really a PDF/Word/image is refused', async () => {
        const fake = multipart({ category: 'other' }, { name: 'report.pdf', content: Buffer.from('MZ\x90\x00 not a pdf') });
        const res = await h.app.inject({
          method: 'POST',
          url: `/api/office/pupils/${pupilId}/documents`,
          headers: { ...(await h.asOffice(DSL)), ...fake.headers },
          payload: fake.payload,
        });
        assert.equal(res.statusCode, 415);
      });

      test('an unknown category or a path-like filename is handled safely', async () => {
        const bad = multipart({ category: 'secret' }, { name: 'a.pdf', content: pdf });
        const res = await h.app.inject({
          method: 'POST',
          url: `/api/office/pupils/${pupilId}/documents`,
          headers: { ...(await h.asOffice(DSL)), ...bad.headers },
          payload: bad.payload,
        });
        assert.equal(res.statusCode, 400);
        const sneaky = multipart({ category: 'other' }, { name: '../../etc/passwd.pdf', content: pdf });
        const ok = await h.app.inject({
          method: 'POST',
          url: `/api/office/pupils/${pupilId}/documents`,
          headers: { ...(await h.asOffice(DSL)), ...sneaky.headers },
          payload: sneaky.payload,
        });
        assert.equal(ok.statusCode, 201);
        assert.equal(ok.json().original_name, 'passwd.pdf');
        assert.ok(!fs.existsSync(path.join(h.filesDir, '..', 'etc')));
        await office('DELETE', `/api/office/documents/${ok.json().id}`);
      });

      test('a tutor cannot download documents', async () => {
        const res = await h.app.inject({ method: 'GET', url: `/api/office/documents/${docId}`, headers: await h.as(B) });
        assert.equal(res.statusCode, 403);
      });

      test('disposal removes the file but keeps the record of it', async () => {
        assert.equal((await office('DELETE', `/api/office/documents/${docId}`)).statusCode, 200);
        assert.equal(fs.readdirSync(path.join(h.filesDir, 'documents')).length, 0);
        assert.equal((await office('GET', `/api/office/documents/${docId}`)).statusCode, 404);
        assert.ok(count('SELECT COUNT(*) FROM documents WHERE id = ? AND deleted_at IS NOT NULL', docId));
        assert.ok(count("SELECT COUNT(*) FROM audit_log WHERE action = 'document.dispose'"));
      });
    });
  });

  // ---------- users ----------
  describe('users', () => {
    test('add a tutor; a duplicate email is refused', async () => {
      const res = await office('POST', '/api/office/users', { email: 'new.tutor@example.test', display_name: 'New Tutor', role: 'tutor' });
      assert.equal(res.statusCode, 201);
      assert.equal(res.json().access_policy_reminder, 'add');
      const dup = await office('POST', '/api/office/users', { email: 'NEW.tutor@example.test', display_name: 'Dup', role: 'tutor' });
      assert.equal(dup.statusCode, 409);
      assert.equal((await office('POST', '/api/office/users', { email: 'not-an-email', display_name: 'X', role: 'tutor' })).statusCode, 400);
    });

    test('you cannot remove your own office access', async () => {
      const me = userId(DSL);
      assert.equal((await office('PATCH', `/api/office/users/${me}`, { active: false })).statusCode, 409);
      assert.equal((await office('PATCH', `/api/office/users/${me}`, { role: 'tutor' })).statusCode, 409);
    });

    test('deactivating a tutor ends their assignments and their access', async () => {
      const a = userId(A);
      const res = await office('PATCH', `/api/office/users/${a}`, { active: false });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().access_policy_reminder, 'remove');
      assert.equal(count('SELECT COUNT(*) FROM pupil_tutors WHERE user_id = ? AND active = 1', a), 0);
      assert.equal((await portal('GET', '/api/me', A)).statusCode, 403);
      // A deactivated user can't be assigned.
      assert.equal((await office('PUT', `/api/office/pupils/${h.pupils.a1}/tutors/${a}`)).statusCode, 409);
    });
  });

  test('the audit log lists recent office actions', async () => {
    const res = await office('GET', '/api/office/audit?limit=50');
    assert.equal(res.statusCode, 200);
    const actions = res.json().map((r: { action: string }) => r.action);
    for (const a of ['pupil.create', 'pupil.update', 'key_info.version', 'pupil.assign', 'user.create', 'user.deactivate']) {
      assert.ok(actions.includes(a), a);
    }
    assert.equal((await office('GET', '/api/office/audit?limit=abc')).statusCode, 400);
  });
});

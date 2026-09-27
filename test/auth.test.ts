import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, TEAM, type Harness } from './helpers.js';

// Acceptance tests 1 and 2, plus the other ways a token must fail.
describe('auth: Cloudflare Access JWT verification', () => {
  let h: Harness;
  before(async () => {
    h = await makeHarness();
  });
  after(async () => {
    await h.app.close();
  });

  const get = (headers: Record<string, string> = {}) =>
    h.app.inject({ method: 'GET', url: '/api/me', headers });

  test('AT1: no Access JWT is rejected with 403', async () => {
    const res = await get();
    assert.equal(res.statusCode, 403);
  });

  test('AT2: a forged JWT (valid shape, wrong signature) is rejected', async () => {
    const res = await get({ 'cf-access-jwt-assertion': await h.forgedToken('tutor-a@example.test') });
    assert.equal(res.statusCode, 403);
  });

  test('a token with its payload tampered is rejected', async () => {
    const [header, , signature] = (await h.token('tutor-a@example.test')).split('.');
    const payload = Buffer.from(
      JSON.stringify({ email: 'dsl@example.test', aud: 'x', iss: `https://${TEAM}` }),
    ).toString('base64url');
    const res = await get({ 'cf-access-jwt-assertion': `${header}.${payload}.${signature}` });
    assert.equal(res.statusCode, 403);
  });

  test('an unsigned alg=none token is rejected', async () => {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const exp = Math.floor(Date.now() / 1000) + 600;
    const token = `${enc({ alg: 'none' })}.${enc({ email: 'dsl@example.test', exp })}.`;
    const res = await get({ 'cf-access-jwt-assertion': token });
    assert.equal(res.statusCode, 403);
  });

  test('wrong audience (another Access app) is rejected', async () => {
    const res = await get({
      'cf-access-jwt-assertion': await h.token('tutor-a@example.test', { aud: 'some-other-app' }),
    });
    assert.equal(res.statusCode, 403);
  });

  test('wrong issuer is rejected', async () => {
    const res = await get({
      'cf-access-jwt-assertion': await h.token('tutor-a@example.test', {
        iss: 'https://evil.cloudflareaccess.com',
      }),
    });
    assert.equal(res.statusCode, 403);
  });

  test('an expired token is rejected', async () => {
    const res = await get({
      'cf-access-jwt-assertion': await h.token('tutor-a@example.test', { expiresIn: '-1m' }),
    });
    assert.equal(res.statusCode, 403);
  });

  test('a valid token for an email not in users is rejected', async () => {
    const res = await get(await h.as('stranger@example.test'));
    assert.equal(res.statusCode, 403);
  });

  test('a valid token for a deactivated user is rejected', async () => {
    const res = await get(await h.as('gone@example.test'));
    assert.equal(res.statusCode, 403);
  });

  test('a valid token for an active user is accepted, email case-insensitive', async () => {
    const res = await get(await h.as('Tutor-A@Example.TEST'));
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.user.role, 'tutor');
    assert.equal(body.dsl_phone, '01795 608506');
  });

  test('the Cf-Access-Authenticated-User-Email header alone grants nothing', async () => {
    const res = await get({ 'cf-access-authenticated-user-email': 'dsl@example.test' });
    assert.equal(res.statusCode, 403);
  });
});

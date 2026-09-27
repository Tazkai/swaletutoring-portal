// DEVELOPMENT ONLY. Runs the real app behind a stand-in for Cloudflare Access so the
// phone UI can be tried before the tunnel exists. The JWT check is not bypassed: this
// script makes its own key pair, gives the app only that public key, and a small proxy
// signs a token per request. Production trusts only Cloudflare's keys, so these tokens
// are worthless there.
//
//   npx tsx scripts/dev-server.ts          then open http://127.0.0.1:3199
//   http://127.0.0.1:3199/__as/tutor-b@example.test   switches the signed-in user
//
// Uses its own throwaway database (DEV_DB_PATH, default ~/dev-data/dev.db) with fabricated data.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { buildApp } from '../src/server/app.js';
import { APP_ROOT } from '../src/server/config.js';
import { migrate, openDb } from '../src/server/db.js';

const TEAM = 'dev.invalid';
const AUD = 'dev-aud';
const APP_PORT = 3198;
const PROXY_PORT = 3199;

const dbPath = process.env.DEV_DB_PATH ?? path.join(os.homedir(), 'dev-data/dev.db');
if (dbPath.startsWith('/srv/portal/data')) throw new Error('Refusing to use the live data directory');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = openDb(dbPath);
migrate(db);

if (!db.prepare('SELECT COUNT(*) FROM users').pluck().get()) {
  const user = db.prepare('INSERT INTO users (email, display_name, role) VALUES (?, ?, ?)');
  const a = Number(user.run('tutor-a@example.test', 'Test Tutor A', 'tutor').lastInsertRowid);
  const b = Number(user.run('tutor-b@example.test', 'Test Tutor B', 'tutor').lastInsertRowid);
  user.run('dsl@example.test', 'Test DSL', 'dsl');
  const pupil = db.prepare(
    "INSERT INTO pupils (reference, first_name, last_name, commissioner) VALUES (?, ?, ?, 'kcc')",
  );
  const link = db.prepare('INSERT INTO pupil_tutors (pupil_id, user_id) VALUES (?, ?)');
  for (const [ref, first, last, tutor] of [
    ['TEST-001', 'Alfie', 'Testcase', a],
    ['TEST-002', 'Bea', 'Sample', a],
    ['TEST-003', 'Cal', 'Placeholder', a],
    ['TEST-004', 'Dot', 'Fixture', b],
  ] as const) {
    link.run(Number(pupil.run(ref, first, last).lastInsertRowid), tutor);
  }
  console.log('Seeded fabricated dev data.');
}

const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
const jwk = { ...(await exportJWK(publicKey)), kid: 'dev', alg: 'RS256' };

const app = await buildApp({
  db,
  accessTeamDomain: TEAM,
  accessAud: AUD,
  dslPhone: '01795 608506',
  clientDir: path.join(APP_ROOT, 'dist/client'),
  accessKeys: createLocalJWKSet({ keys: [jwk] }),
  logger: false,
});
await app.listen({ host: '127.0.0.1', port: APP_PORT });

const sign = (email: string) =>
  new SignJWT({ email })
    .setProtectedHeader({ alg: 'RS256', kid: 'dev' })
    .setIssuer(`https://${TEAM}`)
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);

http
  .createServer(async (req, res) => {
    const switchTo = req.url?.match(/^\/__as\/([^/?#]+)/)?.[1];
    if (switchTo) {
      res.writeHead(302, { 'set-cookie': `dev_as=${switchTo}; Path=/; SameSite=Strict`, location: '/' });
      return res.end();
    }
    const email = decodeURIComponent(
      req.headers.cookie?.match(/(?:^|;\s*)dev_as=([^;]+)/)?.[1] ?? 'tutor-a%40example.test',
    );
    const headers = { ...req.headers, 'cf-access-jwt-assertion': await sign(email) };
    const upstream = http.request(
      { host: '127.0.0.1', port: APP_PORT, path: req.url, method: req.method, headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  })
  .listen(PROXY_PORT, '127.0.0.1', () => {
    console.log(`Dev portal on http://127.0.0.1:${PROXY_PORT} (db ${dbPath})`);
  });

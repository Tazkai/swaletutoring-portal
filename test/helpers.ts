import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { migrate, openDb, type DB } from '../src/server/db.js';

export const TEAM = 'swale-test.cloudflareaccess.com';
export const AUD = 'test-aud-0123456789abcdef';
export const OFFICE_AUD = 'test-office-aud-fedcba9876543210';

export interface Harness {
  app: FastifyInstance;
  db: DB;
  filesDir: string;
  pupils: { a1: number; a2: number; b1: number };
  token: (email: string, opts?: TokenOpts) => Promise<string>;
  forgedToken: (email: string) => Promise<string>;
  as: (email: string) => Promise<Record<string, string>>;
  asOffice: (email: string) => Promise<Record<string, string>>;
}

export interface HarnessOptions {
  officeEnabled?: boolean;
}

interface TokenOpts {
  aud?: string;
  iss?: string;
  expiresIn?: string;
  alg?: 'RS256';
}

// Stands in for Cloudflare Access: a real RS256 key pair whose public half is the
// only key the app trusts, and a second "attacker" key pair it must reject.
export async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const real = await generateKeyPair('RS256', { extractable: true });
  const attacker = await generateKeyPair('RS256', { extractable: true });
  const kid = 'test-key-1';
  const jwk = { ...(await exportJWK(real.publicKey)), kid, alg: 'RS256', use: 'sig' };
  const keys = createLocalJWKSet({ keys: [jwk] });

  const db = openDb(':memory:');
  migrate(db);
  const addUser = db.prepare(
    'INSERT INTO users (email, display_name, role, active) VALUES (?, ?, ?, ?)',
  );
  const tutorA = Number(addUser.run('tutor-a@example.test', 'Tutor A', 'tutor', 1).lastInsertRowid);
  const tutorB = Number(addUser.run('tutor-b@example.test', 'Tutor B', 'tutor', 1).lastInsertRowid);
  addUser.run('dsl@example.test', 'DSL', 'dsl', 1);
  addUser.run('gone@example.test', 'Former Tutor', 'tutor', 0);

  const addPupil = db.prepare(
    "INSERT INTO pupils (reference, first_name, last_name, commissioner) VALUES (?, ?, ?, 'kcc')",
  );
  const link = db.prepare('INSERT INTO pupil_tutors (pupil_id, user_id) VALUES (?, ?)');
  const a1 = Number(addPupil.run('T-A1', 'Alfie', 'Testcase').lastInsertRowid);
  const a2 = Number(addPupil.run('T-A2', 'Bea', 'Sample').lastInsertRowid);
  const b1 = Number(addPupil.run('T-B1', 'Dot', 'Fixture').lastInsertRowid);
  link.run(a1, tutorA);
  link.run(a2, tutorA);
  link.run(b1, tutorB);

  const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-test-files-'));
  const app = await buildApp({
    db,
    accessTeamDomain: TEAM,
    accessAud: AUD,
    officeAccessAud: options.officeEnabled === false ? undefined : OFFICE_AUD,
    dslPhone: '01795 608506',
    filesDir,
    accessKeys: keys,
  });
  app.addHook('onClose', async () => fs.rmSync(filesDir, { recursive: true, force: true }));

  const sign = (key: CryptoKey, email: string, opts: TokenOpts = {}) =>
    new SignJWT({ email, type: 'app' })
      .setProtectedHeader({ alg: opts.alg ?? 'RS256', kid })
      .setIssuer(opts.iss ?? `https://${TEAM}`)
      .setAudience(opts.aud ?? AUD)
      .setSubject(randomUUID())
      .setIssuedAt()
      .setExpirationTime(opts.expiresIn ?? '10m')
      .sign(key);

  const token = (email: string, opts?: TokenOpts) => sign(real.privateKey, email, opts);
  return {
    app,
    db,
    filesDir,
    pupils: { a1, a2, b1 },
    token,
    forgedToken: (email) => sign(attacker.privateKey, email),
    as: async (email) => ({ 'cf-access-jwt-assertion': await token(email) }),
    asOffice: async (email) => ({ 'cf-access-jwt-assertion': await token(email, { aud: OFFICE_AUD }) }),
  };
}

// Builds a multipart/form-data body for upload tests.
export function multipart(
  fields: Record<string, string>,
  file?: { name: string; content: Buffer; type?: string },
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----portaltest${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
          `Content-Type: ${file.type ?? 'application/octet-stream'}\r\n\r\n`,
      ),
      file.content,
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

export function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

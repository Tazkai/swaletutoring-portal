import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Role } from '../shared/types.js';
import type { DB } from './db.js';

// Cloudflare Access authenticates; this app authorises.
// See Placement_Portal_Build_Brief.md §5.

export interface AuthUser {
  id: number;
  email: string;
  display_name: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser;
  }
}

export interface AccessOptions {
  teamDomain: string; // e.g. swale.cloudflareaccess.com
  audience: string; // the Access application's AUD tag
  keys?: JWTVerifyGetKey; // tests inject a local key set; production fetches Cloudflare's
}

export function accessKeySet(teamDomain: string): JWTVerifyGetKey {
  // jose caches the key set and refetches when it sees an unknown key id.
  return createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
}

export function registerAuth(app: FastifyInstance, db: DB, opts: AccessOptions): void {
  const keys = opts.keys ?? accessKeySet(opts.teamDomain);
  const issuer = `https://${opts.teamDomain}`;
  const findUser = db.prepare(
    `SELECT id, email, display_name, role FROM users WHERE email = ? AND active = 1`,
  );

  const deny = (reply: FastifyReply) => reply.code(403).send({ error: 'forbidden' });

  app.decorateRequest('user', null as unknown as AuthUser);

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.url.startsWith('/api/')) return;

    const token = request.headers['cf-access-jwt-assertion'];
    if (typeof token !== 'string' || token.length === 0) return deny(reply);

    let email: string;
    try {
      // Checks the RS256 signature against Cloudflare's keys, plus iss, aud and exp.
      const { payload } = await jwtVerify(token, keys, {
        issuer,
        audience: opts.audience,
        algorithms: ['RS256'],
      });
      if (typeof payload.email !== 'string' || payload.email.length === 0) return deny(reply);
      email = payload.email;
    } catch (err) {
      request.log.warn({ err: (err as Error).message }, 'rejected Access token');
      return deny(reply);
    }

    const user = findUser.get(email) as AuthUser | undefined;
    if (!user) {
      request.log.warn({ email }, 'valid Access token for unknown or inactive user');
      return deny(reply);
    }
    request.user = user;
  });
}

export function isOversight(user: AuthUser): boolean {
  return user.role === 'dsl' || user.role === 'deputy' || user.role === 'admin';
}

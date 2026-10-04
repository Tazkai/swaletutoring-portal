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

// Which Cloudflare Access application the request came through. Each has its own AUD tag,
// so this can't be spoofed: the office API only accepts tokens issued for the office app.
export type AccessApp = 'portal' | 'office';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser;
    accessApp: AccessApp;
  }
}

export interface AccessOptions {
  teamDomain: string; // e.g. swale.cloudflareaccess.com
  audience: string; // the portal Access application's AUD tag
  officeAudience?: string; // the office Access application's AUD tag; unset = office disabled
  keys?: JWTVerifyGetKey; // tests inject a local key set; production fetches Cloudflare's
}

// True if the request is for a path under `prefix`, judged by the route that actually
// matched AND by the decoded URL. The router decodes %-escapes, so testing the raw URL
// alone would let `/%61pi/...` reach an API handler without passing the check.
export function isUnder(request: FastifyRequest, prefix: string): boolean {
  const route = request.routeOptions?.url;
  let decoded = request.url;
  try {
    decoded = decodeURIComponent(request.url.split('?')[0] ?? '');
  } catch {
    // Malformed escapes: fall back to the raw URL, which the router will reject anyway.
  }
  return (
    (typeof route === 'string' && route.startsWith(prefix)) ||
    decoded.startsWith(prefix) ||
    request.url.startsWith(prefix)
  );
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
  app.decorateRequest('accessApp', 'portal');

  const audiences = [opts.audience, ...(opts.officeAudience ? [opts.officeAudience] : [])];

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isUnder(request, '/api/')) return;

    const token = request.headers['cf-access-jwt-assertion'];
    if (typeof token !== 'string' || token.length === 0) return deny(reply);

    let email: string;
    try {
      // Checks the RS256 signature against Cloudflare's keys, plus iss, aud and exp.
      const { payload } = await jwtVerify(token, keys, {
        issuer,
        audience: audiences,
        algorithms: ['RS256'],
      });
      if (typeof payload.email !== 'string' || payload.email.length === 0) return deny(reply);
      email = payload.email;
      const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      request.accessApp = opts.officeAudience && aud.includes(opts.officeAudience) ? 'office' : 'portal';
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

    // The office API needs both locks: an office-app token AND an office role.
    if (isUnder(request, '/api/office/')) {
      if (request.accessApp !== 'office' || !isOversight(user)) {
        request.log.warn({ email, app: request.accessApp, role: user.role }, 'office API refused');
        return deny(reply);
      }
    }
  });
}

export function isOversight(user: AuthUser): boolean {
  return user.role === 'dsl' || user.role === 'deputy' || user.role === 'admin';
}

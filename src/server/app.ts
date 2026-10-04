import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { JWTVerifyGetKey } from 'jose';
import type { Me } from '../shared/types.js';
import { isUnder, registerAuth } from './auth.js';
import { HttpError } from './access.js';
import type { DB } from './db.js';
import { pupilRoutes } from './routes/pupils.js';
import { officeRoutes } from './routes/office.js';
import { sessionRoutes } from './routes/sessions.js';

export interface AppOptions {
  db: DB;
  accessTeamDomain: string;
  accessAud: string;
  officeAccessAud?: string; // unset = the office API refuses every request
  dslPhone: string;
  filesDir: string;
  clientDir?: string;
  accessKeys?: JWTVerifyGetKey;
  logger?: boolean;
}

// The office front end is served on office.* hostnames; everything else gets the tutor app.
const isOfficeHost = (hostname: string) => hostname.toLowerCase().startsWith('office.');

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 64 * 1024,
    // Behind Cloudflare Tunnel, every request arrives from cloudflared on localhost.
    trustProxy: '127.0.0.1',
    // Reject bad input rather than "fixing" it: no "2" → 2 coercion, and unknown
    // fields are an error instead of being silently stripped.
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('Content-Security-Policy', CSP);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
    if (isUnder(request, '/api/')) reply.header('Cache-Control', 'no-store');
  });

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    const e = err as { validation?: unknown; statusCode?: number; message: string };
    if (e.validation) return reply.code(400).send({ error: e.message });
    if (e.statusCode && e.statusCode < 500) {
      return reply.code(e.statusCode).send({ error: e.message });
    }
    request.log.error(err);
    return reply.code(500).send({ error: 'internal error' });
  });

  registerAuth(app, opts.db, {
    teamDomain: opts.accessTeamDomain,
    audience: opts.accessAud,
    officeAudience: opts.officeAccessAud,
    keys: opts.accessKeys,
  });

  app.get('/api/me', async (request): Promise<Me> => ({
    user: request.user,
    dsl_phone: opts.dslPhone,
  }));
  pupilRoutes(app, opts.db);
  sessionRoutes(app, opts.db);
  await officeRoutes(app, opts.db, opts.filesDir);

  app.all('/api/*', async (_request, reply) => reply.code(404).send({ error: 'not found' }));

  if (opts.clientDir && fs.existsSync(opts.clientDir)) {
    await app.register(fastifyStatic, {
      root: opts.clientDir,
      index: false,
      setHeaders(res, filePath) {
        const name = path.basename(filePath);
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (name === 'sw.js' || name.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    });
    // Single-page apps: the root and any unknown non-API path get the right shell for the host.
    const shell = (hostname: string) => (isOfficeHost(hostname) ? 'office.html' : 'index.html');
    app.get('/', (request, reply) => reply.header('Cache-Control', 'no-cache').sendFile(shell(request.hostname)));
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !isUnder(request, '/api/')) {
        return reply.header('Cache-Control', 'no-cache').sendFile(shell(request.hostname));
      }
      return reply.code(404).send({ error: 'not found' });
    });
  }

  return app;
}

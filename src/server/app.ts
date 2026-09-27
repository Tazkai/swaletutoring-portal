import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { JWTVerifyGetKey } from 'jose';
import type { Me } from '../shared/types.js';
import { registerAuth } from './auth.js';
import { HttpError } from './access.js';
import type { DB } from './db.js';
import { pupilRoutes } from './routes/pupils.js';
import { sessionRoutes } from './routes/sessions.js';

export interface AppOptions {
  db: DB;
  accessTeamDomain: string;
  accessAud: string;
  dslPhone: string;
  clientDir?: string;
  accessKeys?: JWTVerifyGetKey;
  logger?: boolean;
}

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
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
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
    keys: opts.accessKeys,
  });

  app.get('/api/me', async (request): Promise<Me> => ({
    user: request.user,
    dsl_phone: opts.dslPhone,
  }));
  pupilRoutes(app, opts.db);
  sessionRoutes(app, opts.db);

  app.all('/api/*', async (_request, reply) => reply.code(404).send({ error: 'not found' }));

  if (opts.clientDir && fs.existsSync(opts.clientDir)) {
    await app.register(fastifyStatic, {
      root: opts.clientDir,
      index: 'index.html',
      setHeaders(res, filePath) {
        const name = path.basename(filePath);
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (name === 'sw.js' || name === 'index.html') {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    });
    // Single-page app: unknown non-API paths get the shell.
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) {
        return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not found' });
    });
  }

  return app;
}

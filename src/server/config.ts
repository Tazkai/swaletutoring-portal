import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  host: string;
  port: number;
  dbPath: string;
  clientDir: string;
  accessTeamDomain: string;
  accessAud: string;
  dslPhone: string;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

// Repo root: src/server/config.ts and dist/server/config.js are both two levels down.
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (key: string): string => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`Missing required environment variable ${key}`);
    return value;
  };

  const host = env.HOST?.trim() || '127.0.0.1';
  // The only way in is through the Cloudflare Tunnel. Never listen publicly.
  if (!LOOPBACK.has(host)) {
    throw new Error(`HOST must be a loopback address, got "${host}"`);
  }

  const teamDomain = required('ACCESS_TEAM_DOMAIN').replace(/^https?:\/\//, '').replace(/\/+$/, '');

  return {
    host,
    port: Number(env.PORT ?? 3100),
    dbPath: required('DB_PATH'),
    clientDir: env.CLIENT_DIR?.trim() || path.join(APP_ROOT, 'dist/client'),
    accessTeamDomain: teamDomain,
    accessAud: required('ACCESS_AUD'),
    dslPhone: required('DSL_PHONE'),
  };
}

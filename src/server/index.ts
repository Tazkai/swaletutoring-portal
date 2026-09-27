import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { migrate, openDb } from './db.js';

const config = loadConfig();
const db = openDb(config.dbPath);
const applied = migrate(db);

const app = await buildApp({
  db,
  accessTeamDomain: config.accessTeamDomain,
  accessAud: config.accessAud,
  dslPhone: config.dslPhone,
  clientDir: config.clientDir,
  logger: true,
});
if (applied.length) app.log.info({ applied }, 'migrations applied');

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.host, port: config.port });

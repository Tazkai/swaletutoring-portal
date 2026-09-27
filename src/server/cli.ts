// Admin commands, run on the server as the portal user:
//   npm run cli -- migrate
//   npm run cli -- user-add <email> "<display name>" <tutor|dsl|deputy|admin> [phone]
//   npm run cli -- user-deactivate <email>
//   npm run cli -- users
//   npm run cli -- assign <pupil reference> <tutor email>
//   npm run cli -- unassign <pupil reference> <tutor email>
//   npm run cli -- seed-test
//   npm run cli -- retention-due
import { ROLES, type Role } from '../shared/types.js';
import { audit } from './audit.js';
import { migrate, openDb, type DB } from './db.js';

const dbPath = process.env.DB_PATH;
if (!dbPath) {
  console.error('DB_PATH is not set. Run with the portal .env loaded, e.g. `set -a; . ./.env; set +a`.');
  process.exit(1);
}
const db = openDb(dbPath);
migrate(db);

const [command, ...args] = process.argv.slice(2);

function usage(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function userId(email: string): number {
  const id = db.prepare('SELECT id FROM users WHERE email = ?').pluck().get(email) as number | undefined;
  if (!id) usage(`No user with email ${email}`);
  return id;
}

function pupilId(reference: string): number {
  const id = db.prepare('SELECT id FROM pupils WHERE reference = ?').pluck().get(reference) as
    | number
    | undefined;
  if (!id) usage(`No pupil with reference ${reference}`);
  return id;
}

function addUser(db: DB, email: string, name: string, role: Role, phone: string | null): number {
  db.prepare(
    `INSERT INTO users (email, display_name, role, phone) VALUES (?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET display_name = excluded.display_name,
       role = excluded.role, phone = excluded.phone, active = 1`,
  ).run(email, name, role, phone);
  const id = userId(email);
  audit(db, null, 'user.upsert', 'users', id, { role, via: 'cli' });
  return id;
}

switch (command) {
  case 'migrate':
    console.log('Schema up to date.');
    break;

  case 'user-add': {
    const [email, name, role, phone] = args;
    if (!email || !name || !role) usage('user-add <email> "<display name>" <role> [phone]');
    if (!ROLES.includes(role as Role)) usage(`role must be one of: ${ROLES.join(', ')}`);
    db.transaction(() => addUser(db, email, name, role as Role, phone ?? null))();
    console.log(`Saved ${email} as ${role}. Also add them to the Cloudflare Access policy.`);
    break;
  }

  case 'user-deactivate': {
    const [email] = args;
    if (!email) usage('user-deactivate <email>');
    db.transaction(() => {
      const id = userId(email);
      db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(id);
      db.prepare('UPDATE pupil_tutors SET active = 0 WHERE user_id = ?').run(id);
      audit(db, null, 'user.deactivate', 'users', id, { via: 'cli' });
    })();
    console.log(`Deactivated ${email}. Remove them from the Cloudflare Access policy too.`);
    break;
  }

  case 'users':
    console.table(db.prepare('SELECT id, email, display_name, role, active FROM users').all());
    break;

  case 'assign':
  case 'unassign': {
    const [reference, email] = args;
    if (!reference || !email) usage(`${command} <pupil reference> <tutor email>`);
    const active = command === 'assign' ? 1 : 0;
    db.transaction(() => {
      const p = pupilId(reference);
      const u = userId(email);
      db.prepare(
        `INSERT INTO pupil_tutors (pupil_id, user_id, active) VALUES (?, ?, ?)
         ON CONFLICT(pupil_id, user_id) DO UPDATE SET active = excluded.active`,
      ).run(p, u, active);
      audit(db, null, `pupil.${command}`, 'pupils', p, { user_id: u, via: 'cli' });
    })();
    console.log(`${command === 'assign' ? 'Assigned' : 'Unassigned'} ${reference} ↔ ${email}.`);
    break;
  }

  case 'seed-test': {
    // FABRICATED DATA ONLY. No real pupil data goes in until the DPIA is signed off.
    const existing = db.prepare("SELECT COUNT(*) FROM pupils WHERE reference LIKE 'TEST-%'").pluck().get();
    if (existing) usage('Test pupils already exist.');
    db.transaction(() => {
      const a = addUser(db, 'tutor-a@example.test', 'Test Tutor A', 'tutor', null);
      const b = addUser(db, 'tutor-b@example.test', 'Test Tutor B', 'tutor', null);
      const pupils: [string, string, string, number][] = [
        ['TEST-001', 'Alfie', 'Testcase', a],
        ['TEST-002', 'Bea', 'Sample', a],
        ['TEST-003', 'Cal', 'Placeholder', a],
        ['TEST-004', 'Dot', 'Fixture', b],
      ];
      for (const [ref, first, last, tutor] of pupils) {
        const info = db
          .prepare(
            `INSERT INTO pupils (reference, first_name, last_name, commissioner, status)
             VALUES (?, ?, ?, 'kcc', 'active')`,
          )
          .run(ref, first, last);
        const id = Number(info.lastInsertRowid);
        db.prepare('INSERT INTO pupil_tutors (pupil_id, user_id) VALUES (?, ?)').run(id, tutor);
        audit(db, null, 'pupil.create', 'pupils', id, { reference: ref, via: 'seed-test' });
      }
    })();
    console.log('Seeded fabricated tutors (tutor-a/b@example.test) and pupils TEST-001..004.');
    break;
  }

  case 'retention-due': {
    // Retention rule (signed Safeguarding policy): keep until the pupil's 25th birthday,
    // then review for retention or secure disposal. This lists who is due; it deletes nothing.
    const rows = db
      .prepare(
        `SELECT reference, date_of_birth, date(date_of_birth, '+25 years') AS review_from, status
         FROM pupils
         WHERE date_of_birth IS NOT NULL AND date(date_of_birth, '+25 years') <= date('now')
         ORDER BY date_of_birth`,
      )
      .all();
    const noDob = db.prepare('SELECT COUNT(*) FROM pupils WHERE date_of_birth IS NULL').pluck().get();
    if (rows.length) console.table(rows);
    else console.log('No pupil records have reached their retention review date.');
    if (noDob) console.log(`${noDob} pupil(s) have no date of birth, so their review date is unknown.`);
    break;
  }

  default:
    usage(
      'Commands: migrate | user-add | user-deactivate | users | assign | unassign | seed-test | retention-due',
    );
}

db.close();

-- Initial schema, per Placement_Portal_Build_Brief.md §4.
-- journal_mode=WAL and foreign_keys=ON are set on every connection in src/server/db.ts,
-- because PRAGMA journal_mode cannot run inside the migration transaction.

-- People who can log in. Email must match the Cloudflare Access identity.
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('tutor','dsl','deputy','admin')),
  phone         TEXT,                      -- DSL number, used for the one-tap call
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE pupils (
  id               INTEGER PRIMARY KEY,
  reference        TEXT NOT NULL UNIQUE,   -- short code, used in exports to avoid names
  first_name       TEXT NOT NULL,
  last_name        TEXT NOT NULL,
  date_of_birth    TEXT,
  commissioner     TEXT NOT NULL CHECK (commissioner IN ('kcc','school','other')),
  commissioner_ref TEXT,                   -- school name / KCC case ref
  status           TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','paused','exited')),
  start_date       TEXT,
  end_date         TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Which tutors may see which pupils. A tutor sees ONLY their own.
CREATE TABLE pupil_tutors (
  pupil_id INTEGER NOT NULL REFERENCES pupils(id),
  user_id  INTEGER NOT NULL REFERENCES users(id),
  active   INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (pupil_id, user_id)
);

CREATE TABLE sessions (
  id                     INTEGER PRIMARY KEY,
  client_uuid            TEXT NOT NULL UNIQUE,   -- generated on device; makes sync idempotent
  pupil_id               INTEGER NOT NULL REFERENCES pupils(id),
  tutor_id               INTEGER NOT NULL REFERENCES users(id),
  session_date           TEXT NOT NULL,
  started_at             TEXT,                   -- ISO8601; NULL if non-attendance
  ended_at               TEXT,
  venue                  TEXT CHECK (venue IN ('home','community','school','online')),
  attendance_status      TEXT NOT NULL CHECK (attendance_status IN
                           ('present','late','left_early','no_show','sick_called_in',
                            'cancelled_family','cancelled_school','cancelled_us')),
  non_attendance_note    TEXT,
  reported_by            TEXT,                   -- who told us (for sick/cancelled)
  reported_at            TEXT,
  submitted_at           TEXT,                   -- when the record was completed
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sessions_pupil_date ON sessions(pupil_id, session_date);
CREATE INDEX idx_sessions_tutor_date ON sessions(tutor_id, session_date);

-- The Lesson Summary form, one per attended session.
CREATE TABLE lesson_records (
  id                  INTEGER PRIMARY KEY,
  session_id          INTEGER NOT NULL UNIQUE REFERENCES sessions(id),
  lesson_summary      TEXT,       -- "Lesson Summary (brief description)"
  substitution_reason TEXT,       -- "if not original lesson and why?"
  next_lesson         TEXT,       -- "does it follow on from previous"
  problems            TEXT,       -- "Any problems"
  engagement          INTEGER CHECK (engagement IN (1,2,3)),  -- 1 excellent, 2 OK, 3 poor
  issues              TEXT,       -- "anything I need to deal with - parent contact etc"
  needs_followup      INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Safeguarding concerns. Separate from lesson records by design.
CREATE TABLE concerns (
  id            INTEGER PRIMARY KEY,
  client_uuid   TEXT NOT NULL UNIQUE,
  pupil_id      INTEGER NOT NULL REFERENCES pupils(id),
  session_id    INTEGER REFERENCES sessions(id),
  raised_by     INTEGER NOT NULL REFERENCES users(id),
  raised_at     TEXT NOT NULL,
  detail        TEXT NOT NULL,
  alert_sent_at TEXT,                       -- NULL = the DSL has NOT been emailed
  ack_by        INTEGER REFERENCES users(id),
  ack_at        TEXT,
  action_taken  TEXT,
  closed_at     TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE library_items (
  id                   INTEGER PRIMARY KEY,
  title                TEXT NOT NULL,
  category             TEXT NOT NULL,
  version              TEXT NOT NULL,
  published_at         TEXT NOT NULL,
  file_path            TEXT NOT NULL,       -- relative to /srv/portal/files
  requires_confirmation INTEGER NOT NULL DEFAULT 0,
  active               INTEGER NOT NULL DEFAULT 1
);

-- Doubles as training-record evidence for the DPS / SCR.
CREATE TABLE read_confirmations (
  id              INTEGER PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  library_item_id INTEGER NOT NULL REFERENCES library_items(id),
  version         TEXT NOT NULL,
  confirmed_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, library_item_id, version)
);

CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY,
  actor_user_id INTEGER REFERENCES users(id),
  action        TEXT NOT NULL,
  entity        TEXT NOT NULL,
  entity_id     INTEGER,
  detail        TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

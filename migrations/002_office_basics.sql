-- Back office slice O1 (09_IT_Systems/Back_Office_Scope.md §3).
-- Fields drawn from STS-FRM-002 Initial Learner Assessment and the Key Information Document.

-- Core and commissioning details. Office-only unless noted.
ALTER TABLE pupils ADD COLUMN preferred_name TEXT;            -- shown to the tutor
ALTER TABLE pupils ADD COLUMN pronouns TEXT;                  -- shown to the tutor
ALTER TABLE pupils ADD COLUMN year_group TEXT;
ALTER TABLE pupils ADD COLUMN funding_route TEXT
  CHECK (funding_route IN ('ehcp','eotas','spot_purchase','route_b_package','other'));
ALTER TABLE pupils ADD COLUMN caseworker_name TEXT;
ALTER TABLE pupils ADD COLUMN caseworker_email TEXT;
ALTER TABLE pupils ADD COLUMN caseworker_phone TEXT;
ALTER TABLE pupils ADD COLUMN kcc_urn TEXT;
ALTER TABLE pupils ADD COLUMN po_number TEXT;
ALTER TABLE pupils ADD COLUMN school_name TEXT;               -- referring school (Route B) or named school
ALTER TABLE pupils ADD COLUMN senco_name TEXT;
ALTER TABLE pupils ADD COLUMN senco_contact TEXT;
ALTER TABLE pupils ADD COLUMN hours_per_week REAL;
ALTER TABLE pupils ADD COLUMN delivery_mode TEXT;
ALTER TABLE pupils ADD COLUMN ehcp INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pupils ADD COLUMN ehcp_reference TEXT;
ALTER TABLE pupils ADD COLUMN looked_after INTEGER NOT NULL DEFAULT 0;  -- needs a first-aider at every session
ALTER TABLE pupils ADD COLUMN vsk_lot3 INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pupils ADD COLUMN primary_presentation TEXT;
ALTER TABLE pupils ADD COLUMN office_notes TEXT;
ALTER TABLE pupils ADD COLUMN updated_at TEXT;

-- What the assigned tutor must know before working with the pupil. Versioned: an edit
-- creates a new row, so a confirmation always refers to the exact text that was read.
CREATE TABLE pupil_key_info (
  id              INTEGER PRIMARY KEY,
  pupil_id        INTEGER NOT NULL REFERENCES pupils(id),
  version         INTEGER NOT NULL,
  address         TEXT,
  access_notes    TEXT,      -- access, parking, entry
  household       TEXT,      -- other adults in the home, siblings, pets
  allergies       TEXT,
  medication      TEXT,
  medical_plan    TEXT,      -- first-aid / medical plan
  sensory_needs   TEXT,
  triggers        TEXT,
  what_helps      TEXT,
  what_not_to_do  TEXT,
  de_escalation   TEXT,
  risks           TEXT,      -- home-visit / lone-working risks
  created_by      INTEGER NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (pupil_id, version)
);

-- "I have read this": evidence that the tutor read the current key information.
CREATE TABLE key_info_confirmations (
  id            INTEGER PRIMARY KEY,
  key_info_id   INTEGER NOT NULL REFERENCES pupil_key_info(id),
  user_id       INTEGER NOT NULL REFERENCES users(id),
  confirmed_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (key_info_id, user_id)
);

-- EHCP outcome → target → measure (STS-FRM-003). Shown to the assigned tutor.
CREATE TABLE pupil_targets (
  id            INTEGER PRIMARY KEY,
  pupil_id      INTEGER NOT NULL REFERENCES pupils(id),
  ehcp_outcome  TEXT,
  target        TEXT NOT NULL,
  measure       TEXT,
  review_date   TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','met','dropped')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT
);
CREATE INDEX idx_targets_pupil ON pupil_targets(pupil_id);

-- Pupil documents (EHCP, risk assessment, reports). Files live in /srv/portal/files,
-- outside the repo, named by a random id. Office only; never emailed.
CREATE TABLE documents (
  id             INTEGER PRIMARY KEY,
  pupil_id       INTEGER REFERENCES pupils(id),
  category       TEXT NOT NULL CHECK (category IN
                   ('ehcp','annual_review','risk_assessment','safeguarding','professional_report',
                    'agreement','referral','other')),
  title          TEXT NOT NULL,
  stored_name    TEXT NOT NULL UNIQUE,
  original_name  TEXT NOT NULL,
  mime_type      TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL,
  sha256         TEXT NOT NULL,
  uploaded_by    INTEGER NOT NULL REFERENCES users(id),
  uploaded_at    TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at     TEXT,
  deleted_by     INTEGER REFERENCES users(id)
);
CREATE INDEX idx_documents_pupil ON documents(pupil_id);

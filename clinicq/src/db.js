'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('patient','clinic')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One clinic per clinic-owner account (MVP). closed_on / notice_on make the
-- "closed today" flag and the notice expire automatically at midnight.
-- A "listed" clinic (claimed = 0, owner_id NULL) is a directory entry for a clinic that has not
-- joined ClinicQ yet: patients see its details and a Call button, but cannot book or join a queue.
CREATE TABLE IF NOT EXISTS clinics (
  id         INTEGER PRIMARY KEY,
  owner_id   INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  claimed    INTEGER NOT NULL DEFAULT 1,
  name       TEXT NOT NULL,
  address    TEXT NOT NULL,
  city       TEXT NOT NULL,
  phone      TEXT,
  lat        REAL,
  lng        REAL,
  rating     REAL,
  rating_count INTEGER,
  rating_source TEXT,
  closed_on  TEXT,
  notice     TEXT,
  notice_on  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS doctors (
  id            INTEGER PRIMARY KEY,
  clinic_id     INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  specialization TEXT NOT NULL,
  qualification TEXT,
  fee           INTEGER NOT NULL DEFAULT 0,
  slot_minutes  INTEGER NOT NULL DEFAULT 15,
  status        TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','break','away')),
  status_note   TEXT,
  status_on     TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_doctors_clinic ON doctors(clinic_id);

-- Weekly recurring availability. weekday: 0=Sunday .. 6=Saturday. Times are minutes since midnight.
CREATE TABLE IF NOT EXISTS schedules (
  id         INTEGER PRIMARY KEY,
  doctor_id  INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  weekday    INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_min  INTEGER NOT NULL,
  end_min    INTEGER NOT NULL CHECK (end_min > start_min)
);
CREATE INDEX IF NOT EXISTS idx_schedules_doctor ON schedules(doctor_id, weekday);

CREATE TABLE IF NOT EXISTS time_off (
  id        INTEGER PRIMARY KEY,
  doctor_id INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  date      TEXT NOT NULL,
  reason    TEXT,
  UNIQUE (doctor_id, date)
);

CREATE TABLE IF NOT EXISTS appointments (
  id         INTEGER PRIMARY KEY,
  doctor_id  INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  patient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  start_min  INTEGER NOT NULL,
  end_min    INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','cancelled','completed')),
  reason     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- A slot can only be held by one live booking; cancelled ones free it up again.
CREATE UNIQUE INDEX IF NOT EXISTS uq_slot_booked
  ON appointments(doctor_id, date, start_min) WHERE status = 'booked';
CREATE INDEX IF NOT EXISTS idx_appt_patient ON appointments(patient_id, date);

-- The live queue. Appointments get an entry too (sort_key = slot start), walk-ins and
-- remote joins sort by the minute they joined. token_no is just a stable label.
CREATE TABLE IF NOT EXISTS queue_entries (
  id             INTEGER PRIMARY KEY,
  doctor_id      INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  date           TEXT NOT NULL,
  token_no       INTEGER NOT NULL,
  patient_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  patient_name   TEXT NOT NULL,
  patient_phone  TEXT,
  source         TEXT NOT NULL CHECK (source IN ('appointment','online','walkin')),
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  sort_key       INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','serving','done','skipped','cancelled')),
  notify_position INTEGER NOT NULL DEFAULT 3,
  created_at     TEXT NOT NULL,
  called_at      TEXT,
  completed_at   TEXT,
  UNIQUE (doctor_id, date, token_no)
);
CREATE INDEX IF NOT EXISTS idx_queue_doctor_day ON queue_entries(doctor_id, date, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_patient_queue
  ON queue_entries(doctor_id, date, patient_id)
  WHERE patient_id IS NOT NULL AND status IN ('waiting','serving');
`;

function openDb(file = ':memory:') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb };

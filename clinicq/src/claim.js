'use strict';

/**
 * Hands a listed (directory-only) clinic over to a clinic account, which switches on
 * booking and the live queue for it.
 *
 *   npm run claim -- <clinicId> <ownerPhone>
 *
 * The owner must first sign up in the app as "I run a clinic" and must not have a clinic yet.
 * Find clinic ids with:  npm run claim -- --list
 */

const { openDb } = require('./db');
const { normalizePhone } = require('./util');

const db = openDb(process.env.DB_PATH || './data/clinicq.db');
const [a, b] = process.argv.slice(2);

if (a === '--list') {
  const rows = db.prepare('SELECT id, name, claimed FROM clinics ORDER BY id').all();
  for (const r of rows) console.log(`${String(r.id).padStart(3)}  ${r.claimed ? 'live  ' : 'listed'}  ${r.name}`);
  process.exit(0);
}

const clinicId = Number(a);
const phone = normalizePhone(b);
if (!Number.isInteger(clinicId) || !phone) {
  console.error('Usage: npm run claim -- <clinicId> <ownerPhone>   (or --list)');
  process.exit(1);
}

const clinic = db.prepare('SELECT * FROM clinics WHERE id = ?').get(clinicId);
if (!clinic) fail(`No clinic with id ${clinicId}.`);
if (clinic.claimed) fail('That clinic is already live on ClinicQ.');

const owner = db.prepare("SELECT * FROM users WHERE phone = ? AND role = 'clinic'").get(phone);
if (!owner) fail('No clinic account with that phone. Sign up first as "I run a clinic".');
if (db.prepare('SELECT 1 FROM clinics WHERE owner_id = ?').get(owner.id)) fail('That account already has a clinic.');

db.prepare('UPDATE clinics SET owner_id = ?, claimed = 1 WHERE id = ?').run(owner.id, clinicId);
console.log(`"${clinic.name}" is now managed by ${owner.name} (${owner.phone}). They can log in and open Dashboard.`);

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

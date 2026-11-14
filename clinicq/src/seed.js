'use strict';

/**
 * Demo data so you can click around straight away:  npm run seed
 *
 * Accounts (phone / password):
 *   Patient        9000000100 / patient123
 *   Clinic owner 1 9000000001 / clinic123   (Green Cross Clinic)
 *   Clinic owner 2 9000000002 / clinic123   (CityCare Family Clinic)
 *
 * Coordinates are placed around central Pune; edit them (or register your own clinics in
 * the app, using the "Use my location" button) to try the "nearby" sorting where you live.
 */

const bcrypt = require('bcryptjs');
const { openDb } = require('./db');
const { hmToMin } = require('./util');

const db = openDb(process.env.DB_PATH || './data/clinicq.db');

if (db.prepare('SELECT COUNT(*) AS c FROM users').get().c > 0) {
  console.log('Database already has users, skipping seed. Delete the data/ folder to start fresh.');
  process.exit(0);
}

const hash = (p) => bcrypt.hashSync(p, 10);
const addUser = db.prepare('INSERT INTO users (name, phone, password_hash, role) VALUES (?,?,?,?)');
const addClinic = db.prepare('INSERT INTO clinics (owner_id, name, address, city, phone, lat, lng) VALUES (?,?,?,?,?,?,?)');
const addDoctor = db.prepare('INSERT INTO doctors (clinic_id, name, specialization, qualification, fee, slot_minutes) VALUES (?,?,?,?,?,?)');
const addWindow = db.prepare('INSERT INTO schedules (doctor_id, weekday, start_min, end_min) VALUES (?,?,?,?)');

function schedule(doctorId, days, ranges) {
  for (const d of days) for (const [s, e] of ranges) addWindow.run(doctorId, d, hmToMin(s), hmToMin(e));
}

db.transaction(() => {
  addUser.run('Demo Patient', '9000000100', hash('patient123'), 'patient');

  const o1 = addUser.run('Green Cross Admin', '9000000001', hash('clinic123'), 'clinic').lastInsertRowid;
  const c1 = addClinic.run(o1, 'Green Cross Clinic', '12 MG Road, Camp', 'Pune', '9000000011', 18.5204, 73.8567).lastInsertRowid;
  const d1 = addDoctor.run(c1, 'Dr. Meera Kulkarni', 'General Physician', 'MBBS, MD', 400, 15).lastInsertRowid;
  const d2 = addDoctor.run(c1, 'Dr. Arjun Rao', 'Paediatrician', 'MBBS, DCH', 600, 20).lastInsertRowid;
  schedule(d1, [1, 2, 3, 4, 5, 6], [['09:00', '13:00'], ['17:00', '20:00']]);
  schedule(d2, [1, 3, 5], [['10:00', '14:00']]);

  const o2 = addUser.run('CityCare Admin', '9000000002', hash('clinic123'), 'clinic').lastInsertRowid;
  const c2 = addClinic.run(o2, 'CityCare Family Clinic', '45 FC Road, Shivajinagar', 'Pune', '9000000022', 18.5308, 73.8475).lastInsertRowid;
  const d3 = addDoctor.run(c2, 'Dr. Sana Sheikh', 'Dermatologist', 'MBBS, MD (Derm)', 700, 15).lastInsertRowid;
  const d4 = addDoctor.run(c2, 'Dr. Vikram Joshi', 'Dentist', 'BDS, MDS', 500, 30).lastInsertRowid;
  schedule(d3, [1, 2, 3, 4, 5], [['11:00', '15:00']]);
  schedule(d4, [1, 2, 3, 4, 5, 6], [['10:00', '13:00'], ['16:00', '19:00']]);
})();

console.log('Seeded demo data.');
console.log('  Patient:        9000000100 / patient123');
console.log('  Clinic owner 1: 9000000001 / clinic123');
console.log('  Clinic owner 2: 9000000002 / clinic123');

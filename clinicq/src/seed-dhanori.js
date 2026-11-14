'use strict';

/**
 * Directory listings of general physicians around Dhanori, Pune:  npm run seed:dhanori
 *
 * Source: Google Maps listings, collected 14 Nov 2026 (rating, review count, address, phone, opening
 * hours). Qualifications come from the clinic's own Google listing name or a doctor profile page;
 * where no source stated a degree or fee it is left blank (null / 0) on purpose rather than guessed.
 * Fee 0 means "not known": the app simply hides it.
 *
 * These clinics have NOT joined ClinicQ. They are added as "listed" (claimed = 0): patients see the
 * details and a Call button, but booking and the live queue stay off until the clinic is claimed with
 *   npm run claim -- <clinicId> <ownerPhone>
 *
 * Ratings and hours change. Re-check them before showing this to real patients (see README).
 */

const { openDb } = require('./db');
const { hmToMin } = require('./util');

const SOURCE = 'Google Maps, Nov 2026';
const ALL = [0, 1, 2, 3, 4, 5, 6];
const MON_SAT = [1, 2, 3, 4, 5, 6];

const LISTINGS = [
  {
    clinic: { name: 'Gurukrupa Clinic', address: 'Shop No. 8, Dhanori-Lohegaon Rd, next to Police Chowki, Sai Dham, Laxmi Nagar, Dhanori', phone: '8002018008', lat: 18.5947908, lng: 73.894065, rating: 5.0, rating_count: 355 },
    doctor: { name: 'Dr. Vedant Rajmal Kotkar', specialization: 'General Physician', qualification: 'MD (Medicine), Fellowship in Diabetology', fee: 0 },
    // NOTE: his profile on Eka Care lists registration with the Maharashtra Council of Indian Medicine
    // (the AYUSH council), not the Maharashtra Medical Council. Verify the MD stream before relying on it.
    hours: [[ALL, [['10:30', '13:30'], ['18:30', '22:00']]]],
  },
  {
    clinic: { name: 'Spandan Clinic', address: '133, First floor, Palladium Grand, Phase 2, Dhanori-Lohegaon Rd, Madhav Nagar, Dhanori', phone: '7666340662', lat: 18.5976132, lng: 73.9021104, rating: 4.8, rating_count: 194 },
    doctor: { name: 'Dr. Ranjeet S. Patil', specialization: 'General Physician (Internal Medicine)', qualification: 'MD Medicine, DNB Medicine', fee: 0 },
    hours: [[MON_SAT, [['10:30', '13:30'], ['18:30', '21:30']]]],
  },
  {
    clinic: { name: "Dr Kunal Waghmare's Clinic", address: '104, First Floor, Goodwill Square Mall, Tushar Park, above Axis Bank, Madhav Nagar, Dhanori', phone: '9960176585', lat: 18.5977261, lng: 73.9044984, rating: 4.7, rating_count: 376 },
    // Fee of 500 is from a third-party profile (threebestrated.in), not confirmed with the clinic.
    doctor: { name: 'Dr. Kunal Waghmare', specialization: 'General Physician', qualification: 'MBBS, MD', fee: 500 },
    hours: [[MON_SAT, [['09:30', '13:30'], ['17:30', '21:30']]], [[0], [['11:00', '13:00']]]],
  },
  {
    clinic: { name: 'Sarthak Health Clinic', address: '7th Heaven Rd, 282 Porwal Rd, beside Kamlai Dairy Farm, Kand Nagar, Kutwal Colony, Lohgaon', phone: '8591667926', lat: 18.6027191, lng: 73.9093566, rating: 4.7, rating_count: 613 },
    // Doctor's name is not shown on the listing. A patient review mentions a first-visit fee of about 200.
    doctor: { name: 'Physician, Sarthak Health Clinic', specialization: 'General Physician', qualification: 'MBBS, MD (Physician)', fee: 0 },
    hours: [[ALL, [['10:00', '14:00'], ['17:00', '22:00']]]],
  },
  {
    clinic: { name: 'Sanjivan Clinic', address: 'Shop No. 14, Sky Max, beside Goodwill Square Mall, Dhanori-Lohegaon Rd, Madhav Nagar, Dhanori', phone: '9970180859', lat: 18.5981315, lng: 73.9037572, rating: 4.9, rating_count: 20 },
    doctor: { name: 'Dr. Prachi Shinde', specialization: 'Family Physician', qualification: null, fee: 0 },
    hours: [[[1, 2], [['11:00', '14:00'], ['18:30', '21:30']]], [[3, 4, 5, 6], [['11:00', '14:30'], ['18:30', '21:30']]]],
  },
  {
    clinic: { name: 'Ratan Clinic', address: 'Shop No. 8, Shree Ram Pride, Dhanori-Lohegaon Rd, Madhav Nagar, Dhanori', phone: '9082394118', lat: 18.597089, lng: 73.9015817, rating: 4.7, rating_count: 25 },
    doctor: { name: 'Dr. Kirti Gangar', specialization: 'Family Physician', qualification: null, fee: 0 },
    hours: [[MON_SAT, [['10:00', '12:30'], ['18:00', '21:00']]]],
  },
  {
    clinic: { name: 'Lifecare Polyclinic', address: 'Sr No. 259/18A/4/1, Kalwad Wasti Rd, opp. RK Hotel, Kalwad, Lohgaon', phone: '7387283878', lat: 18.5901918, lng: 73.9048044, rating: 5.0, rating_count: 21 },
    // Reviews mention Dr. Sohail and Dr. Sharukh; full names and degrees are not listed.
    doctor: { name: 'Physician, Lifecare Polyclinic', specialization: 'General Physician', qualification: null, fee: 0 },
    hours: [[ALL, [['09:00', '22:00']]]],
  },
  {
    clinic: { name: 'One Rupee Polyclinic (Satyashiv Foundation)', address: 'Shop No. 1, Shree Hans Society, Gokul Nagar, Dhanori', phone: null, lat: 18.5909144, lng: 73.8917944, rating: 5.0, rating_count: 9 },
    // Charity clinic; reviews say the charge is nominal. Tuesday hours on Google are garbled, so a
    // conservative 10:00 to 21:00 is used for Mon to Sat.
    doctor: { name: 'Dr. Rohit', specialization: 'General Physician', qualification: null, fee: 0 },
    hours: [[MON_SAT, [['10:00', '21:00']]]],
  },
  {
    clinic: { name: "Doctor's Place", address: 'Shop No. 5, Navrang Plaza Society, Tingre Nagar Rd, Vishrantwadi', phone: '9552292700', lat: 18.5790799, lng: 73.8904015, rating: 3.7, rating_count: 129 },
    // Speciality is not stated on the listing. Many reviews complain about the reception.
    doctor: { name: 'Dr. Prasad M. Kelhe', specialization: 'Physician (speciality not confirmed)', qualification: null, fee: 0 },
    hours: [[MON_SAT, [['09:30', '22:00']]]],
  },
  {
    clinic: { name: 'Sathe Multispeciality Clinic', address: 'Porwal Rd, Kutwal Colony, Dhanori', phone: null, lat: 18.599426, lng: 73.909003, rating: 3.7, rating_count: 16 },
    // Google shows inconsistent hours and no phone, so no timings are stored.
    doctor: { name: 'Dr. Ajit Sathe', specialization: 'Physician (speciality not confirmed)', qualification: null, fee: 0 },
    hours: [],
  },
];

const db = openDb(process.env.DB_PATH || './data/clinicq.db');
const exists = db.prepare('SELECT 1 FROM clinics WHERE name = ? AND address = ?');
const addClinic = db.prepare(
  `INSERT INTO clinics (owner_id, claimed, name, address, city, phone, lat, lng, rating, rating_count, rating_source)
   VALUES (NULL, 0, ?, ?, 'Pune', ?, ?, ?, ?, ?, ?)`
);
const addDoctor = db.prepare('INSERT INTO doctors (clinic_id, name, specialization, qualification, fee, slot_minutes) VALUES (?,?,?,?,?,15)');
const addWindow = db.prepare('INSERT INTO schedules (doctor_id, weekday, start_min, end_min) VALUES (?,?,?,?)');

let added = 0;
db.transaction(() => {
  for (const { clinic: c, doctor: d, hours } of LISTINGS) {
    if (exists.get(c.name, c.address)) continue;
    const clinicId = addClinic.run(c.name, c.address, c.phone, c.lat, c.lng, c.rating, c.rating_count, SOURCE).lastInsertRowid;
    const doctorId = addDoctor.run(clinicId, d.name, d.specialization, d.qualification, d.fee).lastInsertRowid;
    for (const [days, ranges] of hours) {
      for (const day of days) for (const [s, e] of ranges) addWindow.run(doctorId, day, hmToMin(s), hmToMin(e));
    }
    added++;
  }
})();

console.log(added ? `Added ${added} listed clinics around Dhanori.` : 'Dhanori listings are already in the database.');
console.log('See them with:  npm run claim -- --list');

'use strict';

const express = require('express');
const { requireRole } = require('../auth');
const {
  HttpError,
  idParam,
  reqStr,
  optStr,
  reqInt,
  hmToMin,
  minToHm,
  isValidDate,
  normalizePhone,
} = require('../util');

function optCoord(body, key, min, max, label) {
  const v = body?.[key];
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${label} is not valid`);
  return n;
}

module.exports = function clinicRoutes({ db, svc }) {
  const r = express.Router();
  r.use('/clinic', requireRole('clinic'));

  // ---- helpers
  const clinicOf = (req) => {
    const c = db.prepare('SELECT * FROM clinics WHERE owner_id = ?').get(req.user.id);
    if (!c) throw new HttpError(404, 'Register your clinic first.');
    return c;
  };
  const doctorOf = (req) => {
    const clinic = clinicOf(req);
    const d = db.prepare('SELECT * FROM doctors WHERE id = ? AND clinic_id = ? AND active = 1').get(idParam(req), clinic.id);
    if (!d) throw new HttpError(404, 'Doctor not found');
    return { clinic, doctor: d };
  };
  const clinicView = (c) => ({
    id: c.id,
    name: c.name,
    address: c.address,
    city: c.city,
    phone: c.phone,
    lat: c.lat,
    lng: c.lng,
    is_open: svc.isOpen(c),
    notice: svc.todayNotice(c),
  });
  const doctorView = (d, c) => ({
    id: d.id,
    name: d.name,
    specialization: d.specialization,
    qualification: d.qualification,
    fee: d.fee,
    slot_minutes: d.slot_minutes,
    status: svc.docStatus(d),
    status_note: svc.docNote(d),
    live: svc.doctorLive(d, c),
    schedule: db
      .prepare('SELECT weekday, start_min, end_min FROM schedules WHERE doctor_id = ? ORDER BY weekday, start_min')
      .all(d.id)
      .map((w) => ({ weekday: w.weekday, start: minToHm(w.start_min), end: minToHm(w.end_min) })),
    time_off: db
      .prepare('SELECT date, reason FROM time_off WHERE doctor_id = ? AND date >= ? ORDER BY date')
      .all(d.id, svc.now().date),
  });

  // ---- clinic profile
  r.get('/clinic', (req, res) => {
    const c = db.prepare('SELECT * FROM clinics WHERE owner_id = ?').get(req.user.id);
    res.json({ clinic: c ? clinicView(c) : null });
  });

  const readClinicBody = (body) => {
    const phone = optStr(body, 'phone', 'Phone', 20);
    if (phone && !normalizePhone(phone)) throw new HttpError(400, 'Clinic phone is not valid.');
    return {
      name: reqStr(body, 'name', 'Clinic name', 2, 100),
      address: reqStr(body, 'address', 'Address', 3, 200),
      city: reqStr(body, 'city', 'City', 2, 80),
      phone: phone ? normalizePhone(phone) : null,
      lat: optCoord(body, 'lat', -90, 90, 'Latitude'),
      lng: optCoord(body, 'lng', -180, 180, 'Longitude'),
    };
  };

  r.post('/clinic', (req, res) => {
    if (db.prepare('SELECT 1 FROM clinics WHERE owner_id = ?').get(req.user.id)) {
      throw new HttpError(409, 'You already registered a clinic.');
    }
    const c = readClinicBody(req.body);
    const info = db
      .prepare('INSERT INTO clinics (owner_id, name, address, city, phone, lat, lng) VALUES (?,?,?,?,?,?,?)')
      .run(req.user.id, c.name, c.address, c.city, c.phone, c.lat, c.lng);
    res.status(201).json({ clinic: clinicView(db.prepare('SELECT * FROM clinics WHERE id = ?').get(info.lastInsertRowid)) });
  });

  r.put('/clinic', (req, res) => {
    const clinic = clinicOf(req);
    const c = readClinicBody(req.body);
    db.prepare('UPDATE clinics SET name=?, address=?, city=?, phone=?, lat=?, lng=? WHERE id=?').run(
      c.name,
      c.address,
      c.city,
      c.phone,
      c.lat,
      c.lng,
      clinic.id
    );
    svc.broadcastClinic(clinic.id);
    res.json({ clinic: clinicView(db.prepare('SELECT * FROM clinics WHERE id = ?').get(clinic.id)) });
  });

  // Open/closed for *today* plus an optional notice ("running 30 min late"). Both reset at midnight.
  r.patch('/clinic/today', (req, res) => {
    const clinic = clinicOf(req);
    const today = svc.now().date;
    const isOpen = req.body?.is_open !== false;
    const notice = optStr(req.body, 'notice', 'Notice', 140);
    db.prepare('UPDATE clinics SET closed_on = ?, notice = ?, notice_on = ? WHERE id = ?').run(
      isOpen ? null : today,
      notice,
      notice ? today : null,
      clinic.id
    );
    svc.broadcastClinic(clinic.id);
    res.json({ clinic: clinicView(db.prepare('SELECT * FROM clinics WHERE id = ?').get(clinic.id)) });
  });

  // ---- doctors
  r.get('/clinic/doctors', (req, res) => {
    const clinic = clinicOf(req);
    const docs = db.prepare('SELECT * FROM doctors WHERE clinic_id = ? AND active = 1 ORDER BY name').all(clinic.id);
    res.json({ doctors: docs.map((d) => doctorView(d, clinic)) });
  });

  const readDoctorBody = (body) => ({
    name: reqStr(body, 'name', 'Doctor name', 2, 80),
    specialization: reqStr(body, 'specialization', 'Specialization', 2, 80),
    qualification: optStr(body, 'qualification', 'Qualification', 120),
    fee: reqInt({ fee: body?.fee ?? 0 }, 'fee', 'Fee', 0, 100000),
    slot_minutes: reqInt({ slot_minutes: body?.slot_minutes ?? 15 }, 'slot_minutes', 'Slot length', 5, 120),
  });

  r.post('/clinic/doctors', (req, res) => {
    const clinic = clinicOf(req);
    const d = readDoctorBody(req.body);
    const info = db
      .prepare('INSERT INTO doctors (clinic_id, name, specialization, qualification, fee, slot_minutes) VALUES (?,?,?,?,?,?)')
      .run(clinic.id, d.name, d.specialization, d.qualification, d.fee, d.slot_minutes);
    const row = db.prepare('SELECT * FROM doctors WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ doctor: doctorView(row, clinic) });
  });

  r.put('/clinic/doctors/:id', (req, res) => {
    const { clinic, doctor } = doctorOf(req);
    const d = readDoctorBody(req.body);
    db.prepare('UPDATE doctors SET name=?, specialization=?, qualification=?, fee=?, slot_minutes=? WHERE id=?').run(
      d.name,
      d.specialization,
      d.qualification,
      d.fee,
      d.slot_minutes,
      doctor.id
    );
    svc.broadcast(doctor.id);
    res.json({ doctor: doctorView(db.prepare('SELECT * FROM doctors WHERE id = ?').get(doctor.id), clinic) });
  });

  r.delete('/clinic/doctors/:id', (req, res) => {
    const { doctor } = doctorOf(req);
    db.transaction(() => {
      db.prepare('UPDATE doctors SET active = 0 WHERE id = ?').run(doctor.id);
      const today = svc.now().date;
      db.prepare("UPDATE appointments SET status = 'cancelled' WHERE doctor_id = ? AND date >= ? AND status = 'booked'").run(doctor.id, today);
      db.prepare("UPDATE queue_entries SET status = 'cancelled' WHERE doctor_id = ? AND date >= ? AND status IN ('waiting','skipped')").run(doctor.id, today);
    })();
    res.json({ ok: true });
  });

  // Today's availability override: available | break | away (+ short note). Resets at midnight.
  r.patch('/clinic/doctors/:id/status', (req, res) => {
    const { clinic, doctor } = doctorOf(req);
    const status = req.body?.status;
    if (!['available', 'break', 'away'].includes(status)) throw new HttpError(400, 'Status must be available, break or away.');
    const note = optStr(req.body, 'status_note', 'Note', 140);
    db.prepare('UPDATE doctors SET status = ?, status_note = ?, status_on = ? WHERE id = ?').run(status, note, svc.now().date, doctor.id);
    svc.broadcast(doctor.id);
    res.json({ doctor: doctorView(db.prepare('SELECT * FROM doctors WHERE id = ?').get(doctor.id), clinic) });
  });

  // ---- weekly schedule (replaces all windows)
  r.put('/clinic/doctors/:id/schedule', (req, res) => {
    const { clinic, doctor } = doctorOf(req);
    const windows = req.body?.windows;
    if (!Array.isArray(windows) || windows.length > 28) throw new HttpError(400, 'Send a list of up to 28 time windows.');
    const parsed = windows.map((w) => {
      const weekday = Number(w?.weekday);
      const start = hmToMin(w?.start);
      const end = hmToMin(w?.end);
      if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new HttpError(400, 'Weekday must be 0 (Sunday) to 6 (Saturday).');
      if (start == null || end == null) throw new HttpError(400, 'Times must look like HH:MM.');
      if (end - start < doctor.slot_minutes) throw new HttpError(400, `Each window must be at least ${doctor.slot_minutes} minutes long.`);
      return { weekday, start, end };
    });
    parsed.sort((a, b) => a.weekday - b.weekday || a.start - b.start);
    for (let day = 0; day < 7; day++) {
      if (parsed.filter((w) => w.weekday === day).length > 2) throw new HttpError(400, 'Up to 2 sessions per day are supported.');
    }
    for (let i = 1; i < parsed.length; i++) {
      if (parsed[i].weekday === parsed[i - 1].weekday && parsed[i].start < parsed[i - 1].end) {
        throw new HttpError(400, 'Time windows on the same day cannot overlap.');
      }
    }
    db.transaction(() => {
      db.prepare('DELETE FROM schedules WHERE doctor_id = ?').run(doctor.id);
      const ins = db.prepare('INSERT INTO schedules (doctor_id, weekday, start_min, end_min) VALUES (?,?,?,?)');
      parsed.forEach((w) => ins.run(doctor.id, w.weekday, w.start, w.end));
    })();
    svc.broadcast(doctor.id);
    res.json({ doctor: doctorView(doctor, clinic) });
  });

  // ---- leave days
  r.post('/clinic/doctors/:id/time-off', (req, res) => {
    const { clinic, doctor } = doctorOf(req);
    const date = String(req.body?.date || '');
    if (!isValidDate(date)) throw new HttpError(400, 'Date must look like YYYY-MM-DD.');
    if (date < svc.now().date) throw new HttpError(400, 'That date is in the past.');
    const reason = optStr(req.body, 'reason', 'Reason', 100);
    db.prepare('INSERT OR REPLACE INTO time_off (doctor_id, date, reason) VALUES (?,?,?)').run(doctor.id, date, reason);
    const affected = db
      .prepare("SELECT COUNT(*) AS c FROM appointments WHERE doctor_id = ? AND date = ? AND status = 'booked'")
      .get(doctor.id, date).c;
    svc.broadcast(doctor.id);
    res.status(201).json({ doctor: doctorView(doctor, clinic), affected_appointments: affected });
  });

  r.delete('/clinic/doctors/:id/time-off/:date', (req, res) => {
    const { clinic, doctor } = doctorOf(req);
    db.prepare('DELETE FROM time_off WHERE doctor_id = ? AND date = ?').run(doctor.id, req.params.date);
    svc.broadcast(doctor.id);
    res.json({ doctor: doctorView(doctor, clinic) });
  });

  // ---- live queue console
  r.get('/clinic/doctors/:id/queue', (req, res) => {
    const { clinic, doctor } = doctorOf(req);
    res.json({ queue: svc.staffQueue(doctor, clinic) });
  });

  r.post('/clinic/doctors/:id/queue', (req, res) => {
    const { clinic, doctor } = doctorOf(req);
    const name = reqStr(req.body, 'name', 'Patient name', 1, 80);
    const phoneRaw = optStr(req.body, 'phone', 'Phone', 20);
    const phone = phoneRaw ? normalizePhone(phoneRaw) : null;
    if (phoneRaw && !phone) throw new HttpError(400, 'Phone number is not valid.');
    const entry = svc.addWalkin(doctor, name, phone);
    res.status(201).json({ token_no: entry.token_no, queue: svc.staffQueue(doctor, clinic) });
  });

  r.post('/clinic/doctors/:id/queue/next', (req, res) => {
    const { clinic, doctor } = doctorOf(req);
    svc.callNext(doctor.id);
    res.json({ queue: svc.staffQueue(doctor, clinic) });
  });

  r.post('/clinic/doctors/:id/queue/:entryId/:action', (req, res) => {
    const { clinic, doctor } = doctorOf(req);
    svc.staffAction(doctor.id, idParam(req, 'entryId'), req.params.action);
    res.json({ queue: svc.staffQueue(doctor, clinic) });
  });

  r.get('/clinic/doctors/:id/appointments', (req, res) => {
    const { doctor } = doctorOf(req);
    const date = req.query.date ? String(req.query.date) : svc.now().date;
    if (!isValidDate(date)) throw new HttpError(400, 'Date must look like YYYY-MM-DD.');
    res.json({ date, appointments: svc.staffAppointments(doctor.id, date) });
  });

  r.post('/clinic/appointments/:id/cancel', (req, res) => {
    const clinic = clinicOf(req);
    res.json({ appointment: svc.cancelAppointment(idParam(req), { clinicId: clinic.id }) });
  });

  return r;
};

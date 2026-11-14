'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');

// Monday 16 Nov 2026, 09:30 in Asia/Kolkata
const MONDAY_0930 = '2026-11-16T04:00:00Z';
const TODAY = '2026-11-16';

/** Spins up the real app on a random port with an in-memory DB and a controllable clock. */
async function start() {
  const clock = { now: new Date(MONDAY_0930) };
  const db = openDb(':memory:');
  const app = createApp({ db, clock: () => clock.now, jwtSecret: 'test-secret', rateLimiting: false });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function api(method, path, body, token) {
    const res = await fetch(base + '/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  let phoneSeq = 9100000000;
  async function register(role, name) {
    const r = await api('POST', '/auth/register', { name, phone: String(phoneSeq++), password: 'secret1', role });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.token;
  }
  const setClock = (iso) => (clock.now = new Date(iso));
  const stop = async () => {
    app.locals.svc.closeStreams();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    db.close();
  };
  return { base, api, register, setClock, stop, db };
}

/** A clinic with one doctor (15 min slots) sitting Mon & Tue 10:00-12:00. */
async function bootstrap(t) {
  const env = await start();
  t.after(env.stop);
  const staff = await env.register('clinic', 'Reception');
  const c = await env.api('POST', '/clinic', { name: 'Test Clinic', address: '1 Main Road', city: 'Pune', phone: '9000000000', lat: 18.52, lng: 73.85 }, staff);
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const d = await env.api('POST', '/clinic/doctors', { name: 'Dr Test', specialization: 'General Physician', fee: 300, slot_minutes: 15 }, staff);
  assert.equal(d.status, 201, JSON.stringify(d.body));
  const doctorId = d.body.doctor.id;
  const s = await env.api(
    'PUT',
    `/clinic/doctors/${doctorId}/schedule`,
    { windows: [1, 2].map((weekday) => ({ weekday, start: '10:00', end: '12:00' })) },
    staff
  );
  assert.equal(s.status, 200, JSON.stringify(s.body));
  return { ...env, staff, doctorId };
}

test('auth: register, duplicate phone, login, wrong password', async (t) => {
  const env = await start();
  t.after(env.stop);
  const body = { name: 'Asha', phone: '98765 43210', password: 'secret1', role: 'patient' };
  const a = await env.api('POST', '/auth/register', body);
  assert.equal(a.status, 201);
  assert.equal(a.body.user.phone, '9876543210');
  assert.equal((await env.api('POST', '/auth/register', body)).status, 409);
  assert.equal((await env.api('POST', '/auth/register', { ...body, phone: '123' })).status, 400);
  assert.equal((await env.api('POST', '/auth/login', { phone: '9876543210', password: 'nope' })).status, 401);
  const ok = await env.api('POST', '/auth/login', { phone: '9876543210', password: 'secret1' });
  assert.equal(ok.status, 200);
  const me = await env.api('GET', '/auth/me', null, ok.body.token);
  assert.equal(me.body.user.name, 'Asha');
});

test('roles: anonymous and patients cannot use clinic endpoints, clinics cannot book', async (t) => {
  const env = await bootstrap(t);
  const patient = await env.register('patient', 'Pat');
  assert.equal((await env.api('GET', '/clinic/doctors')).status, 401);
  assert.equal((await env.api('GET', '/clinic/doctors', null, patient)).status, 403);
  const book = await env.api('POST', `/doctors/${env.doctorId}/appointments`, { date: TODAY, start: '10:00' }, env.staff);
  assert.equal(book.status, 403);
  assert.equal((await env.api('GET', '/nope')).status, 404);
});

test('clinic owners only manage their own doctors', async (t) => {
  const env = await bootstrap(t);
  const other = await env.register('clinic', 'Other');
  await env.api('POST', '/clinic', { name: 'Other Clinic', address: '2 Side Street', city: 'Pune' }, other);
  const r = await env.api('PUT', `/clinic/doctors/${env.doctorId}/schedule`, { windows: [] }, other);
  assert.equal(r.status, 404);
  assert.equal((await env.api('GET', `/clinic/doctors/${env.doctorId}/queue`, null, other)).status, 404);
});

test('search finds doctors by name, speciality, clinic and city, and sorts by distance', async (t) => {
  const env = await bootstrap(t);
  const by = async (qs) => (await env.api('GET', '/clinics?' + qs)).body.clinics;
  assert.equal((await by('q=physician')).length, 1);
  assert.equal((await by('q=dr%20test')).length, 1);
  assert.equal((await by('q=test%20clinic'))[0].doctors.length, 1);
  assert.equal((await by('q=dentist')).length, 0);
  assert.equal((await by('city=mumbai')).length, 0);
  const near = await by('lat=18.5204&lng=73.8567');
  assert.ok(near[0].distance_km < 2);
});

test('slots: generated from schedule, past slots hidden, leave days empty', async (t) => {
  const env = await bootstrap(t);
  const slots = async (date) => (await env.api('GET', `/doctors/${env.doctorId}/slots?date=${date}`)).body;
  let s = await slots(TODAY);
  assert.equal(s.slots.length, 8); // 10:00 .. 11:45
  assert.ok(s.slots.every((x) => x.available));
  env.setClock('2026-11-16T04:50:00Z'); // 10:20 IST
  s = await slots(TODAY);
  assert.deepEqual(s.slots.filter((x) => !x.available).map((x) => x.start), ['10:00', '10:15']);
  assert.equal((await slots('2026-11-17')).slots.length, 8); // Tuesday
  assert.equal((await slots('2026-11-18')).slots.length, 0); // Wednesday: no schedule
  assert.equal((await env.api('GET', `/doctors/${env.doctorId}/slots?date=2026-11-01`)).status, 400); // past
  assert.equal((await env.api('GET', `/doctors/${env.doctorId}/slots?date=2027-06-01`)).status, 400); // too far

  const leave = await env.api('POST', `/clinic/doctors/${env.doctorId}/time-off`, { date: '2026-11-17', reason: 'Conference' }, env.staff);
  assert.equal(leave.status, 201);
  s = await slots('2026-11-17');
  assert.equal(s.on_leave, true);
  assert.equal(s.slots.length, 0);
});

test('booking: one winner per slot, no double booking per day, cancel frees the slot', async (t) => {
  const env = await bootstrap(t);
  const p1 = await env.register('patient', 'P1');
  const p2 = await env.register('patient', 'P2');
  const path = `/doctors/${env.doctorId}/appointments`;

  const a = await env.api('POST', path, { date: '2026-11-17', start: '10:30', reason: 'Fever' }, p1);
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(a.body.appointment.start, '10:30');

  assert.equal((await env.api('POST', path, { date: '2026-11-17', start: '10:30' }, p2)).status, 409); // slot taken
  assert.equal((await env.api('POST', path, { date: '2026-11-17', start: '11:00' }, p1)).status, 409); // same day, same doctor
  assert.equal((await env.api('POST', path, { date: '2026-11-17', start: '10:07' }, p2)).status, 400); // not a slot
  assert.equal((await env.api('POST', path, { date: '2026-11-16', start: '09:00' }, p2)).status, 400); // outside hours

  const slots = (await env.api('GET', `/doctors/${env.doctorId}/slots?date=2026-11-17`)).body.slots;
  assert.equal(slots.find((s) => s.start === '10:30').available, false);

  // p2 cannot cancel p1's appointment
  assert.equal((await env.api('POST', `/appointments/${a.body.appointment.id}/cancel`, null, p2)).status, 404);
  assert.equal((await env.api('POST', `/appointments/${a.body.appointment.id}/cancel`, null, p1)).status, 200);
  assert.equal((await env.api('POST', path, { date: '2026-11-17', start: '10:30' }, p2)).status, 201); // freed

  const mine = await env.api('GET', '/me/appointments', null, p1);
  assert.equal(mine.body.appointments[0].status, 'cancelled');
});

test('live queue: join, call next, positions and ETAs update, completion', async (t) => {
  const env = await bootstrap(t);
  env.setClock('2026-11-16T04:35:00Z'); // 10:05 IST, inside the 10-12 session
  const a = await env.register('patient', 'Anita');
  const b = await env.register('patient', 'Bala');
  const c = await env.register('patient', 'Chitra');
  const join = (tok) => env.api('POST', `/doctors/${env.doctorId}/queue/join`, { notify_position: 2 }, tok);

  const ja = await join(a);
  const jb = await join(b);
  const jc = await join(c);
  assert.equal(ja.status, 201, JSON.stringify(ja.body));
  assert.deepEqual([ja, jb, jc].map((x) => x.body.entry.token_no), [1, 2, 3]);
  assert.equal((await join(a)).status, 409); // cannot hold two tokens
  assert.equal(jc.body.entry.position, 3);
  assert.equal(jc.body.entry.eta_minutes, 30); // 2 people ahead x 15 min

  // Public view exposes tokens only, never names.
  const pub = (await env.api('GET', `/doctors/${env.doctorId}/queue`)).body.queue;
  assert.equal(pub.waiting_count, 3);
  assert.equal(pub.now_serving, null);
  assert.ok(!JSON.stringify(pub).includes('Anita'));

  // Receptionist calls the first patient.
  let q = (await env.api('POST', `/clinic/doctors/${env.doctorId}/queue/next`, null, env.staff)).body.queue;
  assert.equal(q.serving.patient_name, 'Anita');
  assert.equal(q.waiting.length, 2);

  let mine = (await env.api('GET', '/me/queue', null, c)).body.entries[0];
  assert.equal(mine.position, 2);
  assert.equal(mine.now_serving, 1);
  assert.equal(mine.people_ahead, 2); // Bala waiting + Anita in consultation

  // Next: Anita is done, Bala is called, Chitra is now first in line.
  q = (await env.api('POST', `/clinic/doctors/${env.doctorId}/queue/next`, null, env.staff)).body.queue;
  assert.equal(q.serving.patient_name, 'Bala');
  assert.equal(q.done_count, 1);
  mine = (await env.api('GET', '/me/queue', null, c)).body.entries[0];
  assert.equal(mine.position, 1);
  const done = (await env.api('GET', '/me/queue', null, a)).body.entries;
  assert.equal(done.length, 0); // finished tokens disappear from "my live tokens"

  // Skip, then put back in line.
  const waitingId = q.waiting[0].id;
  q = (await env.api('POST', `/clinic/doctors/${env.doctorId}/queue/${waitingId}/skip`, null, env.staff)).body.queue;
  assert.equal(q.skipped.length, 1);
  assert.equal(q.waiting.length, 0);
  q = (await env.api('POST', `/clinic/doctors/${env.doctorId}/queue/${waitingId}/requeue`, null, env.staff)).body.queue;
  assert.equal(q.waiting.length, 1);
});

test('walk-ins added by reception, patient can leave the queue', async (t) => {
  const env = await bootstrap(t);
  env.setClock('2026-11-16T04:35:00Z');
  const w = await env.api('POST', `/clinic/doctors/${env.doctorId}/queue`, { name: 'Walk In Wendy', phone: '9999999999' }, env.staff);
  assert.equal(w.status, 201);
  assert.equal(w.body.token_no, 1);
  assert.equal(w.body.queue.waiting[0].source, 'walkin');

  const p = await env.register('patient', 'Remote Ravi');
  const j = await env.api('POST', `/doctors/${env.doctorId}/queue/join`, {}, p);
  assert.equal(j.body.entry.position, 2);
  assert.equal((await env.api('PATCH', `/queue/${j.body.entry.id}`, { notify_position: 5 }, p)).status, 200);
  assert.equal((await env.api('POST', `/queue/${j.body.entry.id}/leave`, null, p)).status, 200);
  const pub = (await env.api('GET', `/doctors/${env.doctorId}/queue`)).body.queue;
  assert.equal(pub.waiting_count, 1);
});

test('appointments and online joiners share one queue, ordered by time', async (t) => {
  const env = await bootstrap(t);
  const early = await env.register('patient', 'Early Bird');
  const late = await env.register('patient', 'Late Joiner');
  // Booked for 10:30 today (it is 09:30 now), then someone joins the live queue at 10:05.
  const appt = await env.api('POST', `/doctors/${env.doctorId}/appointments`, { date: TODAY, start: '10:30' }, early);
  assert.equal(appt.status, 201);
  env.setClock('2026-11-16T04:35:00Z'); // 10:05
  const j = await env.api('POST', `/doctors/${env.doctorId}/queue/join`, {}, late);
  assert.equal(j.body.entry.position, 1); // joined at 10:05, ahead of the 10:30 slot

  const q = (await env.api('GET', `/clinic/doctors/${env.doctorId}/queue`, null, env.staff)).body.queue;
  assert.deepEqual(q.waiting.map((e) => e.patient_name), ['Late Joiner', 'Early Bird']);
  assert.equal(q.waiting[1].source, 'appointment');

  // Finishing the appointment's consultation marks the appointment completed.
  await env.api('POST', `/clinic/doctors/${env.doctorId}/queue/next`, null, env.staff);
  await env.api('POST', `/clinic/doctors/${env.doctorId}/queue/next`, null, env.staff);
  await env.api('POST', `/clinic/doctors/${env.doctorId}/queue/next`, null, env.staff);
  const mine = (await env.api('GET', '/me/appointments', null, early)).body.appointments;
  assert.equal(mine[0].status, 'completed');
});

test('queue rules: closed clinic, away doctor, outside hours', async (t) => {
  const env = await bootstrap(t);
  const p = await env.register('patient', 'Pat');
  const join = () => env.api('POST', `/doctors/${env.doctorId}/queue/join`, {}, p);
  const live = async () => (await env.api('GET', `/doctors/${env.doctorId}/queue`)).body.queue.live;

  // 08:30: more than 60 min before opening -> cannot join yet
  env.setClock('2026-11-16T03:00:00Z');
  assert.equal((await live()).state, 'opens_later');
  assert.equal((await join()).status, 409);

  // 10:05: inside session
  env.setClock('2026-11-16T04:35:00Z');
  assert.equal((await live()).state, 'in');

  // Doctor goes on a break: still joinable, state reflects it
  await env.api('PATCH', `/clinic/doctors/${env.doctorId}/status`, { status: 'break', status_note: 'Lunch' }, env.staff);
  assert.equal((await live()).state, 'break');

  // Doctor away: not joinable
  await env.api('PATCH', `/clinic/doctors/${env.doctorId}/status`, { status: 'away' }, env.staff);
  assert.equal((await join()).status, 409);

  // Back, but clinic closed for today
  await env.api('PATCH', `/clinic/doctors/${env.doctorId}/status`, { status: 'available' }, env.staff);
  await env.api('PATCH', '/clinic/today', { is_open: false, notice: 'Power cut' }, env.staff);
  assert.equal((await live()).state, 'clinic_closed');
  assert.equal((await join()).status, 409);

  // Reopen
  await env.api('PATCH', '/clinic/today', { is_open: true }, env.staff);
  assert.equal((await join()).status, 201);

  // Next day the closed flag / away status no longer apply on their own
  await env.api('PATCH', `/clinic/doctors/${env.doctorId}/status`, { status: 'away' }, env.staff);
  env.setClock('2026-11-17T04:35:00Z'); // Tuesday 10:05
  assert.equal((await live()).state, 'in');

  // After the session ends
  env.setClock('2026-11-17T07:00:00Z'); // 12:30
  assert.equal((await live()).state, 'finished');
});

test('schedule validation: overlaps, bad times and too-short windows are rejected', async (t) => {
  const env = await bootstrap(t);
  const put = (windows) => env.api('PUT', `/clinic/doctors/${env.doctorId}/schedule`, { windows }, env.staff);
  assert.equal((await put([{ weekday: 1, start: '10:00', end: '12:00' }, { weekday: 1, start: '11:00', end: '13:00' }])).status, 400);
  assert.equal((await put([{ weekday: 9, start: '10:00', end: '12:00' }])).status, 400);
  assert.equal((await put([{ weekday: 1, start: '25:00', end: '12:00' }])).status, 400);
  assert.equal((await put([{ weekday: 1, start: '10:00', end: '10:10' }])).status, 400);
  assert.equal((await put([{ weekday: 1, start: '10:00', end: '12:00' }, { weekday: 1, start: '16:00', end: '19:00' }])).status, 200);
});

test('live stream pushes an update when the queue changes', async (t) => {
  const env = await bootstrap(t);
  env.setClock('2026-11-16T04:35:00Z');
  const p = await env.register('patient', 'Streamer');
  await env.api('POST', `/doctors/${env.doctorId}/queue/join`, {}, p);

  const ctrl = new AbortController();
  t.after(() => ctrl.abort());
  const res = await fetch(`${env.base}/api/doctors/${env.doctorId}/queue/stream`, { signal: ctrl.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const readUntil = async (pred) => {
    while (!pred(buf)) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
    }
  };
  await readUntil((s) => s.includes('event: queue'));
  assert.ok(buf.includes('"now_serving":null'));

  buf = '';
  await env.api('POST', `/clinic/doctors/${env.doctorId}/queue/next`, null, env.staff);
  await readUntil((s) => s.includes('"now_serving":1'));
  assert.ok(buf.includes('"now_serving":1'));
});

test('listed clinics: visible with rating and hours, but no booking or queue until claimed', async (t) => {
  const env = await start();
  t.after(env.stop);
  const { db } = env;
  const cid = db
    .prepare("INSERT INTO clinics (owner_id, claimed, name, address, city, phone, lat, lng, rating, rating_count, rating_source) VALUES (NULL, 0, 'Listed Clinic', '1 Road, Dhanori', 'Pune', '9000000009', 18.59, 73.9, 4.7, 100, 'Google Maps')")
    .run().lastInsertRowid;
  const did = db.prepare("INSERT INTO doctors (clinic_id, name, specialization, qualification, fee, slot_minutes) VALUES (?, 'Dr Listed', 'General Physician', 'MBBS', 0, 15)").run(cid).lastInsertRowid;
  db.prepare('INSERT INTO schedules (doctor_id, weekday, start_min, end_min) VALUES (?,1,600,720)').run(did); // Monday 10:00-12:00
  const patient = await env.register('patient', 'Pat');

  const list = (await env.api('GET', '/clinics?q=listed')).body.clinics[0];
  assert.equal(list.claimed, false);
  assert.equal(list.rating, 4.7);
  assert.equal(list.doctors[0].live.state, 'listed');
  assert.equal(list.doctors[0].live.today_windows[0].start, '10:00');

  env.setClock('2026-11-16T04:35:00Z'); // Monday 10:05, inside the listed hours
  assert.equal((await env.api('GET', `/doctors/${did}/queue`)).body.queue.live.state, 'listed'); // never claims "doctor is in"
  assert.equal((await env.api('POST', `/doctors/${did}/queue/join`, {}, patient)).status, 409);
  assert.equal((await env.api('POST', `/doctors/${did}/appointments`, { date: TODAY, start: '11:00' }, patient)).status, 409);
  assert.deepEqual((await env.api('GET', `/doctors/${did}/slots?date=${TODAY}`)).body.slots, []);

  // Once claimed it behaves like any live clinic.
  const owner = await env.register('clinic', 'Owner');
  const ownerId = db.prepare("SELECT id FROM users WHERE name = 'Owner'").get().id;
  db.prepare('UPDATE clinics SET owner_id = ?, claimed = 1 WHERE id = ?').run(ownerId, cid);
  assert.ok(owner);
  assert.equal((await env.api('POST', `/doctors/${did}/queue/join`, {}, patient)).status, 201);
});

test('seed:dhanori adds the listings once and only rating > 3 clinics', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-seed-'));
  const file = path.join(dir, 't.db');
  const run = () => execFileSync(process.execPath, ['src/seed-dhanori.js'], { env: { ...process.env, DB_PATH: file }, encoding: 'utf8' });
  assert.match(run(), /Added 10 listed clinics/);
  assert.match(run(), /already in the database/);
  const db = openDb(file);
  const rows = db.prepare('SELECT claimed, owner_id, rating FROM clinics').all();
  assert.equal(rows.length, 10);
  assert.ok(rows.every((r) => r.claimed === 0 && r.owner_id === null && r.rating > 3));
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM doctors').get().c, 10);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

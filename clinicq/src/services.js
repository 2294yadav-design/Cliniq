'use strict';

const {
  localParts,
  weekdayOf,
  addDays,
  minToHm,
  hmToMin,
  isValidDate,
  haversineKm,
  HttpError,
} = require('./util');

const MAX_DAYS_AHEAD = 30;
const JOIN_EARLY_MIN = 60; // remote queue opens this long before the first session starts

const STATE_MESSAGES = {
  clinic_closed: 'The clinic is marked closed today.',
  on_leave: 'The doctor is on leave today.',
  listed: 'This clinic is not on ClinicQ yet, so online booking is not available. Please call the clinic.',
  not_today: 'The doctor does not sit today.',
  away: 'The doctor is away today.',
  finished: "Today's consultation hours are over.",
};

function createServices(db, clock) {
  const now = () => localParts(clock());
  const nowIso = () => clock().toISOString();

  const S = {
    doctor: db.prepare('SELECT * FROM doctors WHERE id = ? AND active = 1'),
    clinic: db.prepare('SELECT * FROM clinics WHERE id = ?'),
    winsDay: db.prepare('SELECT start_min, end_min FROM schedules WHERE doctor_id = ? AND weekday = ? ORDER BY start_min'),
    winsAll: db.prepare('SELECT weekday, start_min, end_min FROM schedules WHERE doctor_id = ? ORDER BY weekday, start_min'),
    leave: db.prepare('SELECT reason FROM time_off WHERE doctor_id = ? AND date = ?'),
    booked: db.prepare("SELECT start_min FROM appointments WHERE doctor_id = ? AND date = ? AND status = 'booked'"),
    active: db.prepare(
      "SELECT * FROM queue_entries WHERE doctor_id = ? AND date = ? AND status IN ('waiting','serving') ORDER BY sort_key, id"
    ),
    done: db.prepare(
      "SELECT called_at, completed_at FROM queue_entries WHERE doctor_id = ? AND date = ? AND status = 'done' AND called_at IS NOT NULL AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 10"
    ),
    maxToken: db.prepare('SELECT COALESCE(MAX(token_no), 0) AS m FROM queue_entries WHERE doctor_id = ? AND date = ?'),
    entry: db.prepare('SELECT * FROM queue_entries WHERE id = ?'),
    clinicDoctors: db.prepare('SELECT * FROM doctors WHERE clinic_id = ? AND active = 1 ORDER BY name'),
  };

  // ---------------------------------------------------------------- helpers
  const isOpen = (c) => c.closed_on !== now().date;
  const todayNotice = (c) => (c.notice && c.notice_on === now().date ? c.notice : null);
  const docStatus = (d) => (d.status_on === now().date ? d.status : 'available');
  const docNote = (d) => (d.status_on === now().date && d.status !== 'available' ? d.status_note : null);

  function doctorWithClinic(id) {
    const doctor = S.doctor.get(id);
    if (!doctor) return null;
    return { doctor, clinic: S.clinic.get(doctor.clinic_id) };
  }

  /** What a patient should see for this doctor *right now*. */
  function doctorLive(doctor, clinic) {
    const n = now();
    const wins = S.winsDay.all(doctor.id, n.weekday);
    const leave = S.leave.get(doctor.id, n.date);
    const status = docStatus(doctor);
    const live = {
      state: 'finished',
      can_join_queue: false,
      opens_at: null,
      leave_reason: null,
      note: docNote(doctor),
      today_windows: wins.map((w) => ({ start: minToHm(w.start_min), end: minToHm(w.end_min) })),
    };
    // Directory-only clinic: we know its usual hours but nothing live, so never claim the doctor is "in".
    if (!clinic.claimed) {
      live.state = 'listed';
      return live;
    }
    if (!isOpen(clinic)) live.state = 'clinic_closed';
    else if (leave) {
      live.state = 'on_leave';
      live.leave_reason = leave.reason || null;
    } else if (!wins.length) live.state = 'not_today';
    else if (status === 'away') live.state = 'away';
    else {
      const inWin = wins.find((w) => n.minutes >= w.start_min && n.minutes < w.end_min);
      const later = wins.find((w) => w.start_min > n.minutes);
      if (inWin) {
        live.state = status === 'break' ? 'break' : 'in';
        live.can_join_queue = true;
      } else if (later) {
        live.state = 'opens_later';
        live.opens_at = minToHm(later.start_min);
        live.can_join_queue = later.start_min - n.minutes <= JOIN_EARLY_MIN;
      }
    }
    return live;
  }

  // ----------------------------------------------------------------- slots
  function slotsFor(doctor, date) {
    if (!S.clinic.get(doctor.clinic_id).claimed) return { on_leave: false, reason: null, slots: [] };
    const leave = S.leave.get(doctor.id, date);
    if (leave) return { on_leave: true, reason: leave.reason || null, slots: [] };
    const wins = S.winsDay.all(doctor.id, weekdayOf(date));
    const taken = new Set(S.booked.all(doctor.id, date).map((r) => r.start_min));
    const n = now();
    const step = doctor.slot_minutes;
    const slots = [];
    for (const w of wins) {
      for (let t = w.start_min; t + step <= w.end_min; t += step) {
        const past = date < n.date || (date === n.date && t <= n.minutes);
        slots.push({ start: minToHm(t), end: minToHm(t + step), start_min: t, available: !past && !taken.has(t) });
      }
    }
    return { on_leave: false, reason: null, slots };
  }

  function validateBookableDate(date) {
    if (!isValidDate(date)) throw new HttpError(400, 'Date must look like YYYY-MM-DD');
    const n = now();
    if (date < n.date) throw new HttpError(400, 'That date is in the past');
    if (date > addDays(n.date, MAX_DAYS_AHEAD)) {
      throw new HttpError(400, `You can only book up to ${MAX_DAYS_AHEAD} days ahead`);
    }
  }

  // ----------------------------------------------------------------- queue
  function nextToken(doctorId, date) {
    return S.maxToken.get(doctorId, date).m + 1;
  }

  function avgMinutes(doctor, date) {
    const durations = S.done
      .all(doctor.id, date)
      .map((r) => (Date.parse(r.completed_at) - Date.parse(r.called_at)) / 60000)
      .filter((x) => x > 0 && x < 120);
    if (durations.length >= 3) {
      const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
      return Math.min(60, Math.max(2, Math.round(mean)));
    }
    return doctor.slot_minutes;
  }

  /** Waiting list in call order, with each person's position and estimated wait. */
  function queueView(doctor, date) {
    const rows = S.active.all(doctor.id, date);
    const serving = rows.find((r) => r.status === 'serving') || null;
    const avg = avgMinutes(doctor, date);
    const waiting = rows
      .filter((r) => r.status === 'waiting')
      .map((r, i) => ({
        ...r,
        position: i + 1, // 1 = next in line
        people_ahead: i + (serving ? 1 : 0),
        eta_minutes: Math.round(i * avg + (serving ? avg / 2 : 0)),
      }));
    return { serving, waiting, avg_minutes: avg };
  }

  /** Anonymous, public view of today's queue (tokens only, no names). */
  function publicSummary(doctor, clinic) {
    const n = now();
    const live = doctorLive(doctor, clinic);
    const view = queueView(doctor, n.date);
    const before = view.waiting.filter((e) => e.sort_key <= n.minutes).length;
    return {
      doctor_id: doctor.id,
      date: n.date,
      live,
      now_serving: view.serving ? view.serving.token_no : null,
      waiting_count: view.waiting.length,
      waiting_tokens: view.waiting.map((e) => e.token_no),
      avg_minutes: view.avg_minutes,
      est_wait_minutes: Math.round(before * view.avg_minutes + (view.serving ? view.avg_minutes / 2 : 0)),
      updated_at: nowIso(),
    };
  }

  // ------------------------------------------------------- live streaming
  const streams = new Map(); // doctorId -> Set<res>

  function addStream(doctorId, res) {
    if (!streams.has(doctorId)) streams.set(doctorId, new Set());
    streams.get(doctorId).add(res);
  }
  function removeStream(doctorId, res) {
    const set = streams.get(doctorId);
    if (!set) return;
    set.delete(res);
    if (!set.size) streams.delete(doctorId);
  }
  function sendSse(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  function broadcast(doctorId) {
    const set = streams.get(doctorId);
    if (!set || !set.size) return;
    const dc = doctorWithClinic(doctorId);
    if (!dc) return;
    const payload = publicSummary(dc.doctor, dc.clinic);
    for (const res of set) {
      try {
        sendSse(res, 'queue', payload);
      } catch {
        /* connection is going away; 'close' handler cleans up */
      }
    }
  }
  function broadcastClinic(clinicId) {
    for (const d of S.clinicDoctors.all(clinicId)) broadcast(d.id);
  }
  function heartbeat() {
    for (const set of streams.values()) {
      for (const res of set) {
        try {
          res.write(': ping\n\n');
        } catch {
          /* ignore */
        }
      }
    }
  }
  function closeStreams() {
    for (const set of streams.values()) for (const res of set) res.end();
    streams.clear();
  }

  // ---------------------------------------------------------- public data
  function doctorBrief(d, c) {
    const sum = publicSummary(d, c);
    return {
      id: d.id,
      name: d.name,
      specialization: d.specialization,
      qualification: d.qualification,
      fee: d.fee,
      slot_minutes: d.slot_minutes,
      live: sum.live,
      now_serving: sum.now_serving,
      waiting_count: sum.waiting_count,
      est_wait_minutes: sum.est_wait_minutes,
    };
  }

  function clinicCard(c, doctors, origin) {
    let distance = null;
    if (origin && c.lat != null && c.lng != null) {
      distance = Math.round(haversineKm(origin.lat, origin.lng, c.lat, c.lng) * 10) / 10;
    }
    return {
      id: c.id,
      name: c.name,
      address: c.address,
      city: c.city,
      phone: c.phone,
      lat: c.lat,
      lng: c.lng,
      claimed: !!c.claimed,
      rating: c.rating,
      rating_count: c.rating_count,
      rating_source: c.rating_source,
      is_open: isOpen(c),
      notice: todayNotice(c),
      distance_km: distance,
      doctors: doctors.map((d) => doctorBrief(d, c)),
    };
  }

  function searchClinics({ q, city, lat, lng }) {
    const needle = String(q || '').trim().toLowerCase();
    const cityN = String(city || '').trim().toLowerCase();
    const origin = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
    const out = [];
    for (const c of db.prepare('SELECT * FROM clinics ORDER BY name').all()) {
      if (cityN && !c.city.toLowerCase().includes(cityN)) continue;
      let docs = S.clinicDoctors.all(c.id);
      if (needle) {
        const clinicHit = [c.name, c.city, c.address].some((x) => x.toLowerCase().includes(needle));
        if (!clinicHit) {
          docs = docs.filter((d) =>
            [d.name, d.specialization, d.qualification || ''].some((x) => x.toLowerCase().includes(needle))
          );
        }
      }
      if (!docs.length) continue;
      out.push(clinicCard(c, docs, origin));
    }
    out.sort((a, b) => {
      if (a.distance_km != null && b.distance_km != null) return a.distance_km - b.distance_km;
      if (a.distance_km != null) return -1;
      if (b.distance_km != null) return 1;
      if (a.claimed !== b.claimed) return a.claimed ? -1 : 1; // clinics you can book come first
      if ((b.rating || 0) !== (a.rating || 0)) return (b.rating || 0) - (a.rating || 0);
      return a.name.localeCompare(b.name);
    });
    return out;
  }

  function doctorPublic(id) {
    const dc = doctorWithClinic(id);
    if (!dc) throw new HttpError(404, 'Doctor not found');
    const { doctor: d, clinic: c } = dc;
    return {
      ...doctorBrief(d, c),
      status_note: docNote(d),
      today: now().date,
      weekly: S.winsAll.all(d.id).map((w) => ({ weekday: w.weekday, start: minToHm(w.start_min), end: minToHm(w.end_min) })),
      max_days_ahead: MAX_DAYS_AHEAD,
      clinic: {
        id: c.id,
        name: c.name,
        address: c.address,
        city: c.city,
        phone: c.phone,
        claimed: !!c.claimed,
        rating: c.rating,
        rating_count: c.rating_count,
        rating_source: c.rating_source,
        is_open: isOpen(c),
        notice: todayNotice(c),
      },
    };
  }

  // ---------------------------------------------------------- appointments
  const APPT_SQL = `
    SELECT a.id, a.doctor_id, a.date, a.start_min, a.end_min, a.status, a.reason,
           d.name AS doctor_name, d.specialization, c.id AS clinic_id, c.name AS clinic_name, c.address AS clinic_address,
           (SELECT token_no FROM queue_entries WHERE appointment_id = a.id) AS token_no
    FROM appointments a
    JOIN doctors d ON d.id = a.doctor_id
    JOIN clinics c ON c.id = d.clinic_id`;
  const fmtAppt = (r) => ({ ...r, start: minToHm(r.start_min), end: minToHm(r.end_min) });
  const apptById = db.prepare(APPT_SQL + ' WHERE a.id = ?');
  const apptsForPatient = db.prepare(APPT_SQL + ' WHERE a.patient_id = ? ORDER BY a.date DESC, a.start_min DESC LIMIT 100');

  function bookAppointment(user, doctorId, date, startHm, reason) {
    const dc = doctorWithClinic(doctorId);
    if (!dc) throw new HttpError(404, 'Doctor not found');
    if (!dc.clinic.claimed) throw new HttpError(409, STATE_MESSAGES.listed);
    validateBookableDate(date);
    const start = hmToMin(startHm);
    if (start == null) throw new HttpError(400, 'Time must look like HH:MM');
    const { slots } = slotsFor(dc.doctor, date);
    const slot = slots.find((s) => s.start_min === start);
    if (!slot) throw new HttpError(400, 'That is not a valid slot for this doctor');
    if (!slot.available) throw new HttpError(409, 'That slot is no longer available. Please pick another.');

    const tx = db.transaction(() => {
      const dup = db
        .prepare("SELECT 1 FROM appointments WHERE doctor_id = ? AND patient_id = ? AND date = ? AND status = 'booked'")
        .get(doctorId, user.id, date);
      if (dup) throw new HttpError(409, 'You already have an appointment with this doctor on that day.');
      let info;
      try {
        info = db
          .prepare('INSERT INTO appointments (doctor_id, patient_id, date, start_min, end_min, reason) VALUES (?,?,?,?,?,?)')
          .run(doctorId, user.id, date, slot.start_min, slot.start_min + dc.doctor.slot_minutes, reason || null);
      } catch (e) {
        if (String(e.code).startsWith('SQLITE_CONSTRAINT')) throw new HttpError(409, 'That slot was just taken. Please pick another.');
        throw e;
      }
      const apptId = Number(info.lastInsertRowid);
      db.prepare(
        `INSERT INTO queue_entries (doctor_id, date, token_no, patient_id, patient_name, patient_phone, source, appointment_id, sort_key, created_at)
         VALUES (?,?,?,?,?,?, 'appointment', ?,?,?)`
      ).run(doctorId, date, nextToken(doctorId, date), user.id, user.name, user.phone, apptId, slot.start_min, nowIso());
      return apptId;
    });
    const id = tx();
    broadcast(doctorId);
    return fmtAppt(apptById.get(id));
  }

  /** actor: { patientId } or { clinicId } */
  function cancelAppointment(id, actor) {
    const a = db
      .prepare('SELECT a.*, d.clinic_id FROM appointments a JOIN doctors d ON d.id = a.doctor_id WHERE a.id = ?')
      .get(id);
    if (!a) throw new HttpError(404, 'Appointment not found');
    if (actor.patientId && a.patient_id !== actor.patientId) throw new HttpError(404, 'Appointment not found');
    if (actor.clinicId && a.clinic_id !== actor.clinicId) throw new HttpError(404, 'Appointment not found');
    if (a.status !== 'booked') throw new HttpError(409, `This appointment is already ${a.status}.`);
    if (a.date < now().date) throw new HttpError(409, 'Past appointments cannot be cancelled.');
    const entry = db.prepare('SELECT * FROM queue_entries WHERE appointment_id = ?').get(id);
    if (entry && entry.status === 'serving') throw new HttpError(409, 'The consultation has already started.');
    db.transaction(() => {
      db.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ?").run(id);
      db.prepare("UPDATE queue_entries SET status = 'cancelled' WHERE appointment_id = ? AND status IN ('waiting','skipped')").run(id);
    })();
    broadcast(a.doctor_id);
    return fmtAppt(apptById.get(id));
  }

  const myAppointments = (userId) => apptsForPatient.all(userId).map(fmtAppt);

  // ------------------------------------------------------- joining a queue
  function activeEntryFor(userId, doctorId, date) {
    return db
      .prepare("SELECT * FROM queue_entries WHERE patient_id = ? AND doctor_id = ? AND date = ? AND status IN ('waiting','serving')")
      .get(userId, doctorId, date);
  }

  function insertEntry({ doctorId, date, patientId, name, phone, source, sortKey, notify }) {
    const info = db
      .prepare(
        `INSERT INTO queue_entries (doctor_id, date, token_no, patient_id, patient_name, patient_phone, source, sort_key, notify_position, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(doctorId, date, nextToken(doctorId, date), patientId, name, phone, source, sortKey, notify || 3, nowIso());
    return Number(info.lastInsertRowid);
  }

  function joinQueue(user, doctorId, notifyPosition) {
    const dc = doctorWithClinic(doctorId);
    if (!dc) throw new HttpError(404, 'Doctor not found');
    const live = doctorLive(dc.doctor, dc.clinic);
    if (!live.can_join_queue) {
      const msg = live.state === 'opens_later' ? `The queue opens shortly before ${live.opens_at}.` : STATE_MESSAGES[live.state];
      throw new HttpError(409, msg || 'The queue is not open right now.');
    }
    const n = now();
    const existing = activeEntryFor(user.id, doctorId, n.date);
    if (existing) throw new HttpError(409, `You already have token #${existing.token_no} with this doctor today.`);
    const id = db.transaction(() =>
      insertEntry({
        doctorId,
        date: n.date,
        patientId: user.id,
        name: user.name,
        phone: user.phone,
        source: 'online',
        sortKey: n.minutes,
        notify: notifyPosition,
      })
    )();
    broadcast(doctorId);
    return myQueue(user.id).find((e) => e.id === id);
  }

  function ownEntry(entryId, userId) {
    const e = S.entry.get(entryId);
    if (!e || e.patient_id !== userId) throw new HttpError(404, 'Token not found');
    return e;
  }

  function leaveQueue(entryId, userId) {
    const e = ownEntry(entryId, userId);
    if (e.source === 'appointment') throw new HttpError(400, 'This token belongs to an appointment. Cancel the appointment instead.');
    if (e.status !== 'waiting') throw new HttpError(409, 'You can only leave while waiting.');
    db.prepare("UPDATE queue_entries SET status = 'cancelled' WHERE id = ?").run(entryId);
    broadcast(e.doctor_id);
  }

  function setNotify(entryId, userId, position) {
    ownEntry(entryId, userId);
    db.prepare('UPDATE queue_entries SET notify_position = ? WHERE id = ?').run(position, entryId);
  }

  function myQueue(userId) {
    const n = now();
    const rows = db
      .prepare(
        `SELECT e.*, d.name AS doctor_name, d.specialization, c.id AS clinic_id, c.name AS clinic_name, c.address AS clinic_address
         FROM queue_entries e
         JOIN doctors d ON d.id = e.doctor_id
         JOIN clinics c ON c.id = d.clinic_id
         WHERE e.patient_id = ? AND e.status IN ('waiting','serving') AND e.date >= ?
         ORDER BY e.date, e.sort_key`
      )
      .all(userId, n.date);
    return rows.map((e) => {
      const base = {
        id: e.id,
        date: e.date,
        token_no: e.token_no,
        status: e.status,
        source: e.source,
        appointment_id: e.appointment_id,
        notify_position: e.notify_position,
        doctor_id: e.doctor_id,
        doctor_name: e.doctor_name,
        specialization: e.specialization,
        clinic_id: e.clinic_id,
        clinic_name: e.clinic_name,
        clinic_address: e.clinic_address,
        time: e.source === 'appointment' ? minToHm(e.sort_key) : null,
        today: e.date === n.date,
      };
      if (e.date !== n.date) return base;
      const dc = doctorWithClinic(e.doctor_id);
      const view = queueView(dc.doctor, e.date);
      const mine = view.waiting.find((w) => w.id === e.id);
      return Object.assign(base, {
        now_serving: view.serving ? view.serving.token_no : null,
        position: mine ? mine.position : 0, // 0 = you are being seen
        people_ahead: mine ? mine.people_ahead : 0,
        eta_minutes: mine ? mine.eta_minutes : 0,
        avg_minutes: view.avg_minutes,
        live: doctorLive(dc.doctor, dc.clinic),
      });
    });
  }

  // ----------------------------------------------------------- clinic side
  function staffQueue(doctor, clinic) {
    const n = now();
    const view = queueView(doctor, n.date);
    const fmt = (e) => ({
      id: e.id,
      token_no: e.token_no,
      patient_name: e.patient_name,
      patient_phone: e.patient_phone,
      source: e.source,
      status: e.status,
      time: minToHm(e.sort_key),
      position: e.position || null,
      eta_minutes: e.eta_minutes ?? null,
      appointment_id: e.appointment_id,
    });
    const skipped = db
      .prepare("SELECT * FROM queue_entries WHERE doctor_id = ? AND date = ? AND status = 'skipped' ORDER BY token_no")
      .all(doctor.id, n.date);
    const doneCount = db
      .prepare("SELECT COUNT(*) AS c FROM queue_entries WHERE doctor_id = ? AND date = ? AND status = 'done'")
      .get(doctor.id, n.date).c;
    return {
      date: n.date,
      live: doctorLive(doctor, clinic),
      avg_minutes: view.avg_minutes,
      serving: view.serving ? fmt(view.serving) : null,
      waiting: view.waiting.map(fmt),
      skipped: skipped.map(fmt),
      done_count: doneCount,
    };
  }

  function staffAppointments(doctorId, date) {
    return db
      .prepare(
        `SELECT a.id, a.start_min, a.end_min, a.status, a.reason, u.name AS patient_name, u.phone AS patient_phone,
                (SELECT token_no FROM queue_entries WHERE appointment_id = a.id) AS token_no
         FROM appointments a JOIN users u ON u.id = a.patient_id
         WHERE a.doctor_id = ? AND a.date = ? ORDER BY a.start_min`
      )
      .all(doctorId, date)
      .map((r) => ({ ...r, start: minToHm(r.start_min), end: minToHm(r.end_min) }));
  }

  function addWalkin(doctor, name, phone) {
    const n = now();
    let patientId = null;
    if (phone) {
      const u = db.prepare("SELECT id FROM users WHERE phone = ? AND role = 'patient'").get(phone);
      if (u && !activeEntryFor(u.id, doctor.id, n.date)) patientId = u.id; // lets a registered patient track it live
    }
    const id = db.transaction(() =>
      insertEntry({ doctorId: doctor.id, date: n.date, patientId, name, phone: phone || null, source: 'walkin', sortKey: n.minutes })
    )();
    broadcast(doctor.id);
    return S.entry.get(id);
  }

  function markDone(e) {
    db.prepare("UPDATE queue_entries SET status = 'done', completed_at = ? WHERE id = ?").run(nowIso(), e.id);
    if (e.appointment_id) db.prepare("UPDATE appointments SET status = 'completed' WHERE id = ? AND status = 'booked'").run(e.appointment_id);
  }

  function finishServing(doctorId, date) {
    const rows = db.prepare("SELECT * FROM queue_entries WHERE doctor_id = ? AND date = ? AND status = 'serving'").all(doctorId, date);
    rows.forEach(markDone);
  }

  function startServing(e) {
    db.prepare("UPDATE queue_entries SET status = 'serving', called_at = ?, completed_at = NULL WHERE id = ?").run(nowIso(), e.id);
  }

  /** Finish the current patient (if any) and call the next waiting one. */
  function callNext(doctorId) {
    const n = now();
    db.transaction(() => {
      finishServing(doctorId, n.date);
      const next = S.active.all(doctorId, n.date).find((r) => r.status === 'waiting');
      if (next) startServing(next);
    })();
    broadcast(doctorId);
  }

  function staffAction(doctorId, entryId, action) {
    const e = S.entry.get(entryId);
    if (!e || e.doctor_id !== doctorId) throw new HttpError(404, 'Token not found');
    const n = now();
    if (e.date !== n.date) throw new HttpError(409, "That token is not for today's queue.");
    db.transaction(() => {
      switch (action) {
        case 'call':
          if (!['waiting', 'skipped'].includes(e.status)) throw new HttpError(409, 'That patient cannot be called now.');
          finishServing(doctorId, e.date);
          startServing(e);
          break;
        case 'complete':
          if (e.status !== 'serving') throw new HttpError(409, 'That patient is not in consultation.');
          markDone(e);
          break;
        case 'skip':
          if (!['waiting', 'serving'].includes(e.status)) throw new HttpError(409, 'That patient cannot be skipped.');
          db.prepare("UPDATE queue_entries SET status = 'skipped', called_at = NULL WHERE id = ?").run(e.id);
          break;
        case 'requeue':
          if (e.status !== 'skipped') throw new HttpError(409, 'Only skipped patients can be put back in line.');
          db.prepare("UPDATE queue_entries SET status = 'waiting', sort_key = ? WHERE id = ?").run(n.minutes, e.id);
          break;
        case 'cancel':
          if (['done', 'cancelled'].includes(e.status)) throw new HttpError(409, 'Nothing to cancel.');
          db.prepare("UPDATE queue_entries SET status = 'cancelled' WHERE id = ?").run(e.id);
          if (e.appointment_id) db.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ? AND status = 'booked'").run(e.appointment_id);
          break;
        default:
          throw new HttpError(400, 'Unknown action');
      }
    })();
    broadcast(doctorId);
  }

  return {
    now,
    MAX_DAYS_AHEAD,
    isOpen,
    todayNotice,
    docStatus,
    docNote,
    doctorWithClinic,
    doctorLive,
    slotsFor,
    validateBookableDate,
    queueView,
    publicSummary,
    searchClinics,
    clinicCard,
    doctorPublic,
    bookAppointment,
    cancelAppointment,
    myAppointments,
    joinQueue,
    leaveQueue,
    setNotify,
    myQueue,
    staffQueue,
    staffAppointments,
    addWalkin,
    callNext,
    staffAction,
    addStream,
    removeStream,
    sendSse,
    broadcast,
    broadcastClinic,
    heartbeat,
    closeStreams,
  };
}

module.exports = { createServices, MAX_DAYS_AHEAD };

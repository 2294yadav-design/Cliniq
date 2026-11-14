import { fill } from '../lib.js';
import {
  h, api, toast, guard, openStream, requireRole, liveBadge,
  fmtTime, fmtDate, etaText, DAY_NAMES,
} from '../lib.js';

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const SOURCE = { appointment: 'Appointment', online: 'Joined online', walkin: 'Walk-in' };

function registerClinic(root) {
  let coords = null;
  const f = {
    name: h('input', { type: 'text', required: true, maxlength: 100 }),
    address: h('input', { type: 'text', required: true, maxlength: 200 }),
    city: h('input', { type: 'text', required: true, maxlength: 80 }),
    phone: h('input', { type: 'tel', placeholder: 'Clinic phone (optional)' }),
  };
  const locBtn = h('button', {
    type: 'button',
    class: 'btn ghost small',
    onclick: () => {
      if (!navigator.geolocation) return toast('Location is not available in this browser.', 'error');
      navigator.geolocation.getCurrentPosition(
        (p) => {
          coords = { lat: p.coords.latitude, lng: p.coords.longitude };
          locBtn.textContent = 'Location saved ✓';
        },
        () => toast('Could not get location. You can skip this.', 'error')
      );
    },
  }, '📍 Use my current location');

  root.append(
    h('h2', {}, 'Register your clinic'),
    h('p', { class: 'muted' }, 'Patients nearby will find you by name, speciality and distance. Add doctors and timings next.'),
    h('form', {
      class: 'form card',
      onsubmit: guard(async () => {
        await api('/clinic', {
          method: 'POST',
          body: { name: f.name.value, address: f.address.value, city: f.city.value, phone: f.phone.value, ...(coords || {}) },
        });
        toast('Clinic registered', 'ok');
        window.dispatchEvent(new HashChangeEvent('hashchange')); // re-render the dashboard
      }),
    },
      h('div', {}, h('label', {}, 'Clinic name'), f.name),
      h('div', {}, h('label', {}, 'Address'), f.address),
      h('div', {}, h('label', {}, 'City'), f.city),
      h('div', {}, h('label', {}, 'Phone'), f.phone),
      h('div', {}, locBtn, h('p', { class: 'muted small' }, 'Used to sort clinics by distance for patients.')),
      h('button', { class: 'btn', type: 'submit' }, 'Register clinic')
    )
  );
}

export default async function dashboard(root) {
  if (!requireRole('clinic')) return;
  let clinic = (await api('/clinic')).clinic;
  if (!clinic) return registerClinic(root);
  let doctors = (await api('/clinic/doctors')).doctors;

  let tab = 'queue';
  let selId = doctors[0]?.id ?? null;
  let openId = null; // which doctor card stays expanded on the Doctors tab
  let apptDate = null;
  let alive = true;
  let stopStream = null;
  let poll = null;

  const head = h('div');
  const tabsEl = h('div', { class: 'tabs', role: 'tablist' });
  const body = h('div', { class: 'stack' });
  root.append(head, tabsEl, body);

  const doc = () => doctors.find((d) => d.id === selId);
  const reloadDoctors = async () => { doctors = (await api('/clinic/doctors')).doctors; };
  const stopLive = () => { stopStream?.(); stopStream = null; clearInterval(poll); poll = null; };

  // ------------------------------------------------------------- header
  function renderHead() {
    const notice = h('input', { type: 'text', maxlength: 140, placeholder: 'Notice for patients today, e.g. “Running 30 min late”', value: clinic.notice || '' });
    const save = (open) => guard(async () => {
      const r = await api('/clinic/today', { method: 'PATCH', body: { is_open: open, notice: notice.value.trim() } });
      clinic = r.clinic;
      renderHead();
      if (tab === 'queue') renderBody();
    });
    fill(head, 
      h('div', { class: 'card stack sm' },
        h('div', { class: 'row between' },
          h('div', {}, h('h2', {}, clinic.name), h('p', { class: 'muted small' }, `${clinic.address}, ${clinic.city}`)),
          h('button', { class: 'btn' + (clinic.is_open ? ' ghost' : ''), onclick: save(!clinic.is_open) },
            clinic.is_open ? 'Open today ✓ · tap to close' : 'Closed today · tap to reopen')
        ),
        h('div', { class: 'row' },
          h('div', { class: 'grow' }, notice),
          h('button', { class: 'btn small ghost', onclick: save(clinic.is_open) }, 'Save notice')
        ),
        h('p', { class: 'muted small' }, 'Open/closed and the notice reset automatically at midnight.')
      )
    );
  }

  function renderTabs() {
    const t = (id, label) => h('button', { class: 'tab' + (tab === id ? ' sel' : ''), role: 'tab', onclick: () => { tab = id; renderTabs(); renderBody(); } }, label);
    fill(tabsEl, t('queue', 'Live queue'), t('doctors', 'Doctors & timings'));
  }

  function renderBody() {
    stopLive();
    if (tab === 'queue') queueTab();
    else doctorsTab();
  }

  // ---------------------------------------------------------- queue tab
  function queueTab() {
    if (!doctors.length) {
      fill(body, 
        h('div', { class: 'card' },
          h('p', {}, 'Add your doctors and their weekly timings first.'),
          h('button', { class: 'btn', onclick: () => { tab = 'doctors'; renderTabs(); renderBody(); } }, 'Add a doctor')
        )
      );
      return;
    }
    if (!doc()) selId = doctors[0].id;

    const pills = h('div', { class: 'pills' },
      doctors.map((d) => h('button', { class: 'pill' + (d.id === selId ? ' sel' : ''), onclick: () => { selId = d.id; apptDate = null; renderBody(); } }, d.name))
    );

    // doctor status (static controls, only the badge refreshes)
    const liveSlot = h('span');
    const noteIn = h('input', { type: 'text', maxlength: 140, placeholder: 'Note for patients, e.g. back in 15 min', value: doc().status_note || '' });
    const stBtns = {};
    const LABEL = { available: 'In', break: 'On a break', away: 'Away today' };
    const paintStatus = () => {
      for (const [s, b] of Object.entries(stBtns)) b.className = 'btn small' + (doc().status === s ? '' : ' ghost');
    };
    const setStatus = (status) => guard(async () => {
      const r = await api(`/clinic/doctors/${selId}/status`, { method: 'PATCH', body: { status, status_note: noteIn.value.trim() } });
      Object.assign(doc(), r.doctor);
      paintStatus();
      toast('Patients can see this now', 'ok', 1800);
      await loadQueue();
    });
    for (const s of ['available', 'break', 'away']) stBtns[s] = h('button', { type: 'button', onclick: setStatus(s) }, LABEL[s]);
    paintStatus();

    const statusCard = h('div', { class: 'card stack sm' },
      h('div', { class: 'row between' }, h('strong', {}, 'Doctor status today'), liveSlot),
      h('div', { class: 'row' }, Object.values(stBtns)),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, noteIn),
        h('button', { class: 'btn small ghost', onclick: setStatus(doc().status) }, 'Save note'))
    );

    // live console
    const stats = h('p', { class: 'muted small' });
    const serveBox = h('div', { class: 'stack sm' });
    const waitBox = h('div');
    const skipBox = h('div');

    const act = (label, action, id, cls = 'small', confirmMsg) =>
      h('button', {
        class: 'btn ' + cls,
        onclick: guard(async () => {
          if (confirmMsg && !confirm(confirmMsg)) return;
          await api(`/clinic/doctors/${selId}/queue/${id}/${action}`, { method: 'POST' });
          await loadQueue();
        }),
      }, label);

    const nextBtnFor = (q) =>
      h('button', {
        class: 'btn big',
        disabled: !q.serving && !q.waiting.length,
        onclick: guard(async () => {
          await api(`/clinic/doctors/${selId}/queue/next`, { method: 'POST' });
          await loadQueue();
        }),
      }, q.serving ? (q.waiting.length ? 'Finish & call next patient' : 'Finish consultation') : 'Call next patient');

    const who = (e) => h('div', { class: 'grow' },
      h('strong', {}, e.patient_name),
      h('div', { class: 'muted small' }, `${SOURCE[e.source]} · ${fmtTime(e.time)}` + (e.patient_phone ? ` · ${e.patient_phone}` : ''))
    );

    function renderQueue(q) {
      fill(liveSlot, liveBadge(q.live));
      stats.textContent = `${q.done_count} seen today · average ${q.avg_minutes} min per patient`;
      fill(serveBox, 
        q.serving
          ? h('div', { class: 'card serving' },
              h('div', { class: 'qrow' },
                h('span', { class: 'tk' }, '#' + q.serving.token_no),
                h('div', { class: 'grow' }, h('strong', {}, q.serving.patient_name), h('div', { class: 'muted small' }, 'In consultation now')),
                act('Finish', 'complete', q.serving.id),
                act('Skip', 'skip', q.serving.id, 'small ghost')
              ))
          : h('div', { class: 'card flat' }, h('p', { class: 'muted' }, 'Nobody is in consultation.')),
        nextBtnFor(q)
      );
      fill(waitBox, 
        h('div', { class: 'card' },
          h('h3', {}, `Waiting (${q.waiting.length})`),
          q.waiting.length
            ? q.waiting.map((e) =>
                h('div', { class: 'qrow' },
                  h('span', { class: 'tk' }, '#' + e.token_no),
                  who(e),
                  h('span', { class: 'muted small' }, etaText(e.eta_minutes)),
                  act('Call', 'call', e.id),
                  act('Skip', 'skip', e.id, 'small ghost'),
                  act('✕', 'cancel', e.id, 'small danger', `Remove ${e.patient_name} from the queue?`)
                ))
            : h('p', { class: 'muted' }, 'The queue is empty.')
        )
      );
      fill(skipBox, 
        q.skipped.length
          ? h('div', { class: 'card' },
              h('h3', {}, 'Skipped / not arrived'),
              q.skipped.map((e) =>
                h('div', { class: 'qrow' },
                  h('span', { class: 'tk' }, '#' + e.token_no),
                  who(e),
                  act('Back in line', 'requeue', e.id),
                  act('✕', 'cancel', e.id, 'small danger', `Remove ${e.patient_name}?`)
                )))
          : null
      );
    }

    // walk-in form (static so typing is never interrupted by refreshes)
    const wName = h('input', { type: 'text', required: true, maxlength: 80, placeholder: 'Patient name' });
    const wPhone = h('input', { type: 'tel', placeholder: 'Phone (optional, lets them track live if registered)' });
    const walkin = h('form', {
      class: 'form card',
      onsubmit: guard(async () => {
        const r = await api(`/clinic/doctors/${selId}/queue`, { method: 'POST', body: { name: wName.value, phone: wPhone.value } });
        toast(`Token #${r.token_no} for ${wName.value.trim()}`, 'ok');
        wName.value = '';
        wPhone.value = '';
        await loadQueue();
      }),
    },
      h('h3', {}, 'Add a walk-in'),
      h('div', { class: 'grid2' }, wName, wPhone),
      h('button', { class: 'btn ghost', type: 'submit' }, 'Add to queue')
    );

    // appointments for a chosen day
    const apptList = h('div', { class: 'stack sm' });
    const dateIn = h('input', { type: 'date', onchange: () => { apptDate = dateIn.value; loadAppts(); } });
    const apptCard = h('div', { class: 'card stack sm' },
      h('div', { class: 'row between' }, h('h3', {}, 'Appointments'), dateIn),
      apptList
    );

    async function loadAppts() {
      if (!alive || tab !== 'queue') return;
      const { date, appointments } = await api(`/clinic/doctors/${selId}/appointments` + (apptDate ? `?date=${apptDate}` : ''));
      dateIn.value = date;
      fill(apptList, 
        appointments.length
          ? appointments.map((a) =>
              h('div', { class: 'qrow' },
                h('span', { class: 'tk' }, fmtTime(a.start)),
                h('div', { class: 'grow' }, h('strong', {}, a.patient_name),
                  h('div', { class: 'muted small' }, `${a.patient_phone}` + (a.reason ? ` · “${a.reason}”` : ''))),
                h('span', { class: 'badge ' + ({ booked: 'info', completed: 'ok', cancelled: 'bad' }[a.status]) }, a.status),
                a.status === 'booked'
                  ? h('button', {
                      class: 'btn small danger',
                      onclick: guard(async () => {
                        if (!confirm(`Cancel ${a.patient_name}'s appointment?`)) return;
                        await api(`/clinic/appointments/${a.id}/cancel`, { method: 'POST' });
                        await loadQueue();
                      }),
                    }, 'Cancel')
                  : null
              ))
          : h('p', { class: 'muted' }, `No appointments on ${fmtDate(date)}.`)
      );
    }

    async function loadQueue() {
      if (!alive || tab !== 'queue') return;
      try {
        const { queue } = await api(`/clinic/doctors/${selId}/queue`);
        renderQueue(queue);
        await loadAppts();
      } catch (e) {
        toast(e.message, 'error');
      }
    }

    fill(body, pills, statusCard, stats, serveBox, waitBox, skipBox, walkin, apptCard);
    loadQueue();
    stopStream = openStream(selId, () => loadQueue());
    poll = setInterval(loadQueue, 15000);
  }

  // -------------------------------------------------------- doctors tab
  const afterChange = async () => { await reloadDoctors(); renderBody(); };

  function doctorFields(d) {
    const f = {
      name: h('input', { type: 'text', required: true, maxlength: 80, value: d?.name || '' }),
      specialization: h('input', { type: 'text', required: true, maxlength: 80, placeholder: 'e.g. General Physician', value: d?.specialization || '' }),
      qualification: h('input', { type: 'text', maxlength: 120, placeholder: 'e.g. MBBS, MD', value: d?.qualification || '' }),
      fee: h('input', { type: 'number', min: 0, max: 100000, value: String(d?.fee ?? 300) }),
      slot: h('select', { value: String(d?.slot_minutes ?? 15) }, [10, 15, 20, 30, 45, 60].map((n) => h('option', { value: String(n) }, `${n} min`))),
    };
    const grid = h('div', { class: 'form cols' },
      h('div', {}, h('label', {}, 'Name'), f.name),
      h('div', {}, h('label', {}, 'Speciality'), f.specialization),
      h('div', {}, h('label', {}, 'Qualification'), f.qualification),
      h('div', {}, h('label', {}, 'Fee (₹)'), f.fee),
      h('div', {}, h('label', {}, 'Consultation length'), f.slot)
    );
    const read = () => ({
      name: f.name.value,
      specialization: f.specialization.value,
      qualification: f.qualification.value,
      fee: Number(f.fee.value || 0),
      slot_minutes: Number(f.slot.value),
    });
    return { grid, read };
  }

  function scheduleEditor(d) {
    const rows = {};
    const grid = h('div', { class: 'stack sm' });
    for (const day of WEEK_ORDER) {
      const wins = d.schedule.filter((w) => w.weekday === day);
      const mk = (w) => [h('input', { type: 'time', value: w?.start || '' }), h('input', { type: 'time', value: w?.end || '' })];
      rows[day] = [mk(wins[0]), mk(wins[1])];
      grid.append(
        h('div', { class: 'sched' },
          h('strong', {}, DAY_NAMES[day]),
          ...rows[day].map(([s, e]) => h('div', { class: 'win' }, s, '–', e))
        )
      );
    }
    const preset = () => {
      for (const day of [1, 2, 3, 4, 5, 6]) {
        rows[day][0][0].value = '09:00'; rows[day][0][1].value = '13:00';
        rows[day][1][0].value = '17:00'; rows[day][1][1].value = '20:00';
      }
      rows[0].flat().forEach((i) => { i.value = ''; });
    };
    const save = guard(async () => {
      const windows = [];
      for (const day of WEEK_ORDER) {
        for (const [s, e] of rows[day]) {
          if (!s.value && !e.value) continue;
          if (!s.value || !e.value) throw new Error(`${DAY_NAMES[day]}: fill both start and end time, or clear both.`);
          windows.push({ weekday: day, start: s.value, end: e.value });
        }
      }
      await api(`/clinic/doctors/${d.id}/schedule`, { method: 'PUT', body: { windows } });
      toast('Timings saved. Patients see them immediately.', 'ok');
      await afterChange();
    });
    return h('div', { class: 'stack sm' },
      h('h3', {}, 'Weekly timings'),
      h('p', { class: 'muted small' }, 'Up to two sessions a day (for example morning and evening). Leave a day blank if the doctor does not sit.'),
      grid,
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: save }, 'Save timings'),
        h('button', { class: 'btn ghost', type: 'button', onclick: preset }, 'Fill Mon–Sat 9–1 & 5–8')
      )
    );
  }

  function timeOffEditor(d) {
    const date = h('input', { type: 'date', required: true });
    const reason = h('input', { type: 'text', maxlength: 100, placeholder: 'Reason (optional)' });
    return h('div', { class: 'stack sm' },
      h('h3', {}, 'Leave days'),
      d.time_off.length
        ? d.time_off.map((t) =>
            h('div', { class: 'qrow' },
              h('div', { class: 'grow' }, h('strong', {}, fmtDate(t.date)), t.reason ? ` · ${t.reason}` : ''),
              h('button', {
                class: 'btn small danger',
                onclick: guard(async () => {
                  await api(`/clinic/doctors/${d.id}/time-off/${t.date}`, { method: 'DELETE' });
                  await afterChange();
                }),
              }, 'Remove')
            ))
        : h('p', { class: 'muted small' }, 'No upcoming leave.'),
      h('form', {
        class: 'row',
        onsubmit: guard(async () => {
          const r = await api(`/clinic/doctors/${d.id}/time-off`, { method: 'POST', body: { date: date.value, reason: reason.value } });
          if (r.affected_appointments > 0) {
            toast(`${r.affected_appointments} appointment(s) are already booked that day. Cancel them from the Live queue tab.`, 'error', 7000);
          } else toast('Leave added', 'ok');
          await afterChange();
        }),
      }, h('div', {}, date), h('div', { class: 'grow' }, reason), h('button', { class: 'btn small', type: 'submit' }, 'Add leave'))
    );
  }

  function doctorCard(d) {
    const fields = doctorFields(d);
    return h('details', {
      class: 'card',
      open: d.id === openId,
      ontoggle: (ev) => {
        if (ev.target.open) openId = d.id;
        else if (openId === d.id) openId = null;
      },
    },
      h('summary', {}, `${d.name} · ${d.specialization}`),
      h('div', { class: 'stack' },
        h('form', {
          class: 'stack sm',
          onsubmit: guard(async () => {
            await api('/clinic/doctors/' + d.id, { method: 'PUT', body: fields.read() });
            toast('Saved', 'ok', 1800);
            await afterChange();
          }),
        }, h('h3', {}, 'Details'), fields.grid, h('div', {}, h('button', { class: 'btn small', type: 'submit' }, 'Save details'))),
        scheduleEditor(d),
        timeOffEditor(d),
        h('div', {},
          h('button', {
            class: 'btn small danger',
            onclick: guard(async () => {
              if (!confirm(`Remove ${d.name}? Their upcoming appointments and queue will be cancelled.`)) return;
              await api('/clinic/doctors/' + d.id, { method: 'DELETE' });
              openId = null;
              await afterChange();
            }),
          }, 'Remove doctor')
        )
      )
    );
  }

  function doctorsTab() {
    const fields = doctorFields(null);
    fill(body, 
      h('details', { class: 'card', open: !doctors.length },
        h('summary', {}, '+ Add a doctor'),
        h('form', {
          class: 'stack sm',
          onsubmit: guard(async () => {
            const r = await api('/clinic/doctors', { method: 'POST', body: fields.read() });
            openId = r.doctor.id;
            toast('Doctor added. Now set their weekly timings.', 'ok');
            selId = selId ?? r.doctor.id;
            await afterChange();
          }),
        }, fields.grid, h('div', {}, h('button', { class: 'btn', type: 'submit' }, 'Add doctor')))
      ),
      doctors.map(doctorCard)
    );
  }

  renderHead();
  renderTabs();
  renderBody();

  return () => {
    alive = false;
    stopLive();
  };
}

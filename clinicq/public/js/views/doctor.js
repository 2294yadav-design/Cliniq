import { fill } from '../lib.js';
import {
  h, api, session, toast, guard, openStream, liveBadge, hasSession,
  fmtTime, fmtDate, etaText, addDaysStr, weekdayOfStr, DAY_NAMES, ratingBadge,
} from '../lib.js';

const DAYS_SHOWN = 14;

export default async function doctor(root, [id]) {
  const { doctor: d } = await api('/doctors/' + id);
  const user = session.user;
  const isPatient = user?.role === 'patient';

  let summary = null;
  let myEntry = null;
  let selDate = null;
  let selSlot = null;
  let alive = true;

  const liveBox = h('div', { class: 'card stack sm' });
  const bookBox = h('div', { class: 'card stack' });
  const daysEl = h('div', { class: 'days', role: 'group', 'aria-label': 'Choose a date' });
  const slotsEl = h('div');
  const confirmEl = h('div');

  // ------------------------------------------------------------ header
  const worksOn = new Set(d.weekly.map((w) => w.weekday));
  const weeklyText = [1, 2, 3, 4, 5, 6, 0]
    .filter((day) => worksOn.has(day))
    .map((day) => `${DAY_NAMES[day]} ${d.weekly.filter((w) => w.weekday === day).map((w) => `${fmtTime(w.start)}–${fmtTime(w.end)}`).join(', ')}`);

  root.append(
    h('p', {}, h('a', { href: '#/' }, '← All doctors')),
    h('div', { class: 'card stack sm' },
      h('div', { class: 'row between' },
        h('div', {},
          h('h2', {}, d.name),
          h('p', { class: 'muted' }, d.specialization + (d.qualification ? ` · ${d.qualification}` : '')),
        ),
        h('div', { class: 'row' }, ratingBadge(d.clinic), d.fee ? h('span', { class: 'badge info' }, `Fee ₹${d.fee}`) : null)
      ),
      h('p', { class: 'small' },
        h('strong', {}, d.clinic.name), ` · ${d.clinic.address}, ${d.clinic.city}`,
        d.clinic.phone ? [' · ', h('a', { href: 'tel:' + d.clinic.phone }, d.clinic.phone)] : null
      ),
      d.clinic.notice ? h('p', { class: 'notice' }, d.clinic.notice) : null,
      weeklyText.length
        ? h('details', {}, h('summary', { class: 'small muted' }, 'Weekly timings'), h('ul', { class: 'small' }, weeklyText.map((t) => h('li', {}, t))))
        : h('p', { class: 'muted small' }, d.clinic.claimed ? 'This doctor has not set weekly timings yet.' : 'No timings are listed. Please call the clinic.')
    ),
    d.clinic.claimed
      ? [liveBox, bookBox]
      : h('div', { class: 'card stack sm' },
          h('h3', {}, 'Not on ClinicQ yet'),
          h('p', {}, 'This clinic has not joined ClinicQ, so you cannot book a slot or follow a live queue here. Call to check that the doctor is in and to book.'),
          d.clinic.phone
            ? h('a', { class: 'btn big', href: 'tel:' + d.clinic.phone }, '📞 Call ' + d.clinic.phone)
            : h('p', { class: 'muted small' }, 'No phone number is listed for this clinic.'),
          h('p', { class: 'muted small' },
            `Timings and rating${d.clinic.rating_source ? ' come from ' + d.clinic.rating_source : ''} and may be out of date. Confirm with the clinic before you travel.`)
        )
  );
  if (!d.clinic.claimed) return; // nothing live to show for a directory-only clinic

  // -------------------------------------------------------- live queue
  async function refreshMine() {
    if (!isPatient) return;
    try {
      const { entries } = await api('/me/queue');
      myEntry = entries.find((e) => e.doctor_id === d.id && e.today) || null;
    } catch {
      /* keep the previous value */
    }
  }

  function cell(label, value) {
    return h('div', { class: 'cell' }, h('div', { class: 'num' }, value), h('div', { class: 'lbl' }, label));
  }

  function offText(live) {
    const map = {
      clinic_closed: 'The clinic is closed today.',
      on_leave: 'The doctor is on leave today.',
      not_today: 'The doctor does not sit today. You can still book a slot for another day below.',
      away: 'The doctor is away today.',
      finished: "Today's consultation hours are over.",
    };
    return map[live.state] || '';
  }

  function joinArea(s) {
    if (!user) return h('a', { class: 'btn', href: '#/login', onclick: () => sessionStorage.setItem('cq_next', location.hash) }, 'Log in to join the queue');
    if (!isPatient) return h('p', { class: 'muted small' }, 'Clinic accounts cannot join queues.');
    if (myEntry) {
      return h('div', { class: 'card flat mytoken stack sm' },
        h('div', { class: 'row between' }, h('strong', {}, `Your token #${myEntry.token_no}`), h('a', { class: 'small', href: '#/my' }, 'Track it →')),
        myEntry.status === 'serving'
          ? h('p', {}, 'It is your turn. Please go in.')
          : h('p', {}, `You are #${myEntry.position} in line · ${myEntry.people_ahead} ahead of you · ${etaText(myEntry.eta_minutes)}`)
      );
    }
    if (!s.live.can_join_queue) {
      return s.live.state === 'opens_later'
        ? h('p', { class: 'muted small' }, `The queue opens about an hour before ${fmtTime(s.live.opens_at)}.`)
        : null;
    }
    return h('button', {
      class: 'btn big',
      onclick: guard(async () => {
        if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
        const r = await api(`/doctors/${d.id}/queue/join`, { method: 'POST', body: { notify_position: 3 } });
        myEntry = r.entry;
        toast(`You are in! Token #${r.entry.token_no}`, 'ok');
        renderLive();
      }),
    }, 'Join today’s queue');
  }

  function renderLive() {
    const s = summary;
    if (!s) return;
    const on = hasSession(s.live);
    fill(liveBox, 
      h('div', { class: 'row between' },
        h('h3', {}, h('span', { class: 'pulse' }), 'Live queue today'),
        liveBadge(s.live)
      ),
      s.live.note ? h('p', { class: 'notice' }, s.live.note) : null,
      on
        ? h('div', { class: 'live' },
            cell('Now serving', s.now_serving != null ? '#' + s.now_serving : '—'),
            cell('Waiting', s.waiting_count),
            cell('Est. wait', s.est_wait_minutes > 0 ? etaText(s.est_wait_minutes).replace('~', '') : '0 min')
          )
        : h('p', { class: 'muted' }, offText(s.live)),
      on && s.waiting_tokens.length
        ? h('div', { class: 'tokens', 'aria-label': 'Tokens waiting' }, s.waiting_tokens.map((t) => h('span', { class: 'token' + (myEntry && myEntry.token_no === t ? ' me' : '') }, '#' + t)))
        : null,
      joinArea(s)
    );
  }

  // ----------------------------------------------------------- booking
  function renderDays() {
    const days = [];
    for (let i = 0; i < DAYS_SHOWN; i++) {
      const date = addDaysStr(d.today, i);
      const dow = weekdayOfStr(date);
      days.push(
        h('button', {
          type: 'button',
          class: 'day' + (date === selDate ? ' sel' : ''),
          disabled: !worksOn.has(dow),
          'aria-pressed': date === selDate ? 'true' : 'false',
          onclick: () => selectDate(date),
        }, h('span', {}, i === 0 ? 'Today' : DAY_NAMES[dow]), h('b', {}, Number(date.slice(8))), h('span', {}, fmtDate(date, { month: 'short' })))
      );
    }
    fill(daysEl, ...days);
  }

  async function selectDate(date) {
    selDate = date;
    selSlot = null;
    fill(confirmEl, );
    renderDays();
    fill(slotsEl, h('p', { class: 'muted' }, 'Loading slots…'));
    try {
      const res = await api(`/doctors/${d.id}/slots?date=${date}`);
      if (!alive || date !== selDate) return;
      renderSlots(res);
    } catch (e) {
      fill(slotsEl, h('p', { class: 'error' }, e.message));
    }
  }

  function renderSlots(res) {
    if (res.on_leave) {
      fill(slotsEl, h('p', { class: 'notice' }, 'The doctor is on leave this day' + (res.reason ? ` (${res.reason})` : '') + '. Please pick another date.'));
      return;
    }
    const free = res.slots.filter((s) => s.available).length;
    if (!res.slots.length) {
      fill(slotsEl, h('p', { class: 'muted' }, 'No slots on this day.'));
      return;
    }
    fill(slotsEl, 
      h('p', { class: 'muted small' }, `${free} of ${res.slots.length} slots free on ${fmtDate(res.date)}`),
      h('div', { class: 'slots' },
        res.slots.map((s) =>
          h('button', {
            type: 'button',
            class: 'slot' + (selSlot === s.start ? ' sel' : ''),
            disabled: !s.available,
            onclick: () => { selSlot = s.start; renderSlots(res); renderConfirm(); },
          }, fmtTime(s.start))
        )
      )
    );
  }

  function renderConfirm() {
    if (!selSlot) return fill(confirmEl, );
    if (!user) {
      return fill(confirmEl, 
        h('a', { class: 'btn', href: '#/login', onclick: () => sessionStorage.setItem('cq_next', location.hash) }, 'Log in to book this slot')
      );
    }
    if (!isPatient) return fill(confirmEl, h('p', { class: 'muted small' }, 'Clinic accounts cannot book appointments.'));
    const reason = h('input', { type: 'text', maxlength: 200, placeholder: 'e.g. fever for 2 days (optional)' });
    fill(confirmEl, 
      h('form', {
        class: 'form card flat',
        onsubmit: guard(async () => {
          const r = await api(`/doctors/${d.id}/appointments`, { method: 'POST', body: { date: selDate, start: selSlot, reason: reason.value } });
          const a = r.appointment;
          toast(`Booked for ${fmtDate(a.date)} at ${fmtTime(a.start)}`, 'ok', 5000);
          fill(confirmEl, 
            h('div', { class: 'card flat mytoken stack sm' },
              h('strong', {}, 'Appointment confirmed ✓'),
              h('p', {}, `${fmtDate(a.date)} at ${fmtTime(a.start)} with ${a.doctor_name}. Token #${a.token_no}.`),
              h('p', { class: 'small muted' }, 'On the day, open My bookings to see how many people are ahead of you and when to leave home.'),
              h('a', { class: 'btn small', href: '#/my' }, 'View my bookings')
            )
          );
          selSlot = null;
          await refreshMine();
          renderLive();
          const res = await api(`/doctors/${d.id}/slots?date=${selDate}`);
          renderSlots(res);
        }),
      },
        h('strong', {}, `${fmtDate(selDate)} · ${fmtTime(selSlot)}`),
        h('div', {}, h('label', {}, 'Reason for visit'), reason),
        h('button', { class: 'btn', type: 'submit' }, 'Confirm appointment')
      )
    );
  }

  bookBox.append(
    h('h3', {}, 'Book an appointment'),
    daysEl,
    slotsEl,
    confirmEl
  );
  const firstDay = Array.from({ length: DAYS_SHOWN }, (_, i) => addDaysStr(d.today, i)).find((date) => worksOn.has(weekdayOfStr(date)));
  if (firstDay) selectDate(firstDay);
  else {
    renderDays();
    fill(slotsEl, h('p', { class: 'muted' }, 'No timings available to book yet.'));
  }

  // ----------------------------------------------------------- go live
  await refreshMine();
  const stop = openStream(d.id, async (s) => {
    summary = s;
    await refreshMine();
    if (alive) renderLive();
  });
  return () => {
    alive = false;
    stop();
  };
}

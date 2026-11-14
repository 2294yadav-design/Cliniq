import { fill } from '../lib.js';
import { h, api, toast, guard, openStream, requireRole, liveBadge, fmtDate, fmtTime, etaText } from '../lib.js';

export default async function my(root) {
  if (!requireRole('patient')) return;

  const alertBar = h('div');
  const liveBox = h('div', { class: 'stack' });
  const apptBox = h('div', { class: 'stack' });
  root.append(h('h2', {}, 'My bookings'), alertBar, liveBox, apptBox);

  const last = new Map(); // entry id -> previous {position, status}, used to alert only on change
  const streams = new Map(); // doctor id -> close()
  let entries = [];
  let alive = true;
  let debounce;

  // -------------------------------------------------------------- alerts
  function notify(msg) {
    toast(msg, 'alert', 0);
    if (navigator.vibrate) navigator.vibrate([250, 120, 250]);
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification('ClinicQ', { body: msg });
      } catch {
        /* some mobile browsers only allow service-worker notifications */
      }
    }
  }

  function checkAlert(e) {
    const prev = last.get(e.id);
    last.set(e.id, { position: e.position, status: e.status });
    if (!prev) return; // do not alert on the first load
    if (e.status === 'serving' && prev.status !== 'serving') {
      notify(`It is your turn! Token #${e.token_no} at ${e.doctor_name}. Please go in.`);
    } else if (e.status === 'waiting' && e.position === 1 && prev.position !== 1) {
      notify(`You are next in line at ${e.doctor_name} (token #${e.token_no}). Please be at the clinic.`);
    } else if (e.status === 'waiting' && e.position <= e.notify_position && prev.position > e.notify_position) {
      notify(`Only ${e.position - 1} ahead of you at ${e.doctor_name}. Time to start heading over.`);
    }
  }

  function renderAlertBar() {
    if (!('Notification' in window) || Notification.permission !== 'default') {
      fill(alertBar, h('p', { class: 'muted small' }, 'Alerts work while this page stays open in your browser.'));
      return;
    }
    fill(alertBar, 
      h('div', { class: 'card flat row between' },
        h('span', { class: 'small' }, 'Get a notification when your turn is close. Keep this page open.'),
        h('button', { class: 'btn small', onclick: async () => { await Notification.requestPermission(); renderAlertBar(); } }, 'Enable alerts')
      )
    );
  }

  // ---------------------------------------------------------- live cards
  function tokenCard(e) {
    const turn = e.status === 'serving';
    const next = !turn && e.position === 1;
    const select = h('select', {
      'aria-label': 'Alert me when I am this close',
      value: String(e.notify_position),
      onchange: guard(async () => {
        await api('/queue/' + e.id, { method: 'PATCH', body: { notify_position: Number(select.value) } });
        toast('Alert preference saved', 'ok', 1800);
      }),
    }, [1, 2, 3, 4, 5].map((n) => h('option', { value: String(n) }, n === 1 ? 'when I am next' : `when I am within the next ${n}`)));

    return h('div', { class: 'card mytoken stack sm' + (turn ? ' turn' : '') },
      h('div', { class: 'row between' },
        h('div', {}, h('strong', {}, e.doctor_name), h('div', { class: 'muted small' }, `${e.specialization} · ${e.clinic_name}`)),
        liveBadge(e.live)
      ),
      h('div', { class: 'row between' },
        h('div', {},
          h('div', { class: 'big' }, turn ? 'Your turn' : next ? 'You are next' : `#${e.position} in line`),
          h('div', { class: 'muted' },
            turn
              ? 'Please go in to see the doctor.'
              : `${e.people_ahead} ${e.people_ahead === 1 ? 'person' : 'people'} ahead · ${etaText(e.eta_minutes)}`)
        ),
        h('div', { class: 'center' }, h('div', { class: 'muted small' }, 'Your token'), h('div', { class: 'big' }, '#' + e.token_no))
      ),
      h('p', { class: 'small muted' },
        e.now_serving != null ? `Now serving #${e.now_serving}` : 'Doctor has not called anyone yet',
        e.source === 'appointment' ? ` · Appointment at ${fmtTime(e.time)}` : ' · Joined from home'
      ),
      !turn
        ? h('div', { class: 'row' }, h('label', { class: 'small' }, 'Alert me'), select)
        : null,
      e.source !== 'appointment' && e.status === 'waiting'
        ? h('button', {
            class: 'btn danger small',
            onclick: guard(async () => {
              if (!confirm('Leave the queue? You will lose your place.')) return;
              await api(`/queue/${e.id}/leave`, { method: 'POST' });
              toast('You left the queue');
              await refresh();
            }),
          }, 'Leave queue')
        : null
    );
  }

  function renderLive() {
    const today = entries.filter((e) => e.today);
    if (!today.length) {
      fill(liveBox, 
        h('div', { class: 'card flat' },
          h('h3', {}, 'Today’s queue'),
          h('p', { class: 'muted' }, 'You are not in any queue today. Find a doctor to join a queue or book a slot.'),
          h('a', { class: 'btn small', href: '#/' }, 'Find doctors')
        )
      );
      return;
    }
    fill(liveBox, h('h3', {}, 'Today’s queue'), ...today.map(tokenCard));
  }

  // --------------------------------------------------------- appointments
  function apptRow(a, today) {
    const canCancel = a.status === 'booked' && a.date >= today;
    const tone = { booked: 'info', completed: 'ok', cancelled: 'bad' }[a.status];
    return h('div', { class: 'card flat row between' },
      h('div', { class: 'grow' },
        h('strong', {}, `${fmtDate(a.date)} · ${fmtTime(a.start)}`),
        h('div', {}, `${a.doctor_name} · ${a.specialization}`),
        h('div', { class: 'muted small' }, `${a.clinic_name}, ${a.clinic_address}` + (a.reason ? ` · “${a.reason}”` : ''))
      ),
      h('span', { class: 'badge ' + tone }, a.status),
      canCancel
        ? h('button', {
            class: 'btn danger small',
            onclick: guard(async () => {
              if (!confirm('Cancel this appointment?')) return;
              await api(`/appointments/${a.id}/cancel`, { method: 'POST' });
              toast('Appointment cancelled');
              await refresh();
            }),
          }, 'Cancel')
        : null
    );
  }

  function renderAppts({ appointments, today }) {
    const upcoming = appointments.filter((a) => a.status === 'booked' && a.date >= today).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
    const past = appointments.filter((a) => !upcoming.includes(a));
    fill(apptBox, 
      h('h3', {}, 'Upcoming appointments'),
      upcoming.length ? upcoming.map((a) => apptRow(a, today)) : h('p', { class: 'muted' }, 'Nothing booked.'),
      past.length
        ? h('details', {}, h('summary', { class: 'muted' }, `History (${past.length})`), h('div', { class: 'stack sm' }, past.map((a) => apptRow(a, today))))
        : null
    );
  }

  // -------------------------------------------------------------- refresh
  function syncStreams() {
    const wanted = new Set(entries.filter((e) => e.today).map((e) => e.doctor_id));
    for (const [id, close] of streams) {
      if (!wanted.has(id)) {
        close();
        streams.delete(id);
      }
    }
    for (const id of wanted) {
      if (!streams.has(id)) {
        streams.set(id, openStream(id, () => {
          clearTimeout(debounce);
          debounce = setTimeout(refresh, 250);
        }));
      }
    }
  }

  async function refresh() {
    if (!alive) return;
    try {
      const [q, a] = await Promise.all([api('/me/queue'), api('/me/appointments')]);
      if (!alive) return;
      entries = q.entries;
      entries.filter((e) => e.today).forEach(checkAlert);
      renderLive();
      renderAppts(a);
      syncStreams();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  renderAlertBar();
  await refresh();
  const poll = setInterval(refresh, 20000); // fallback if the live connection drops
  return () => {
    alive = false;
    clearInterval(poll);
    clearTimeout(debounce);
    for (const close of streams.values()) close();
    streams.clear();
  };
}

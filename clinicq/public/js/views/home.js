import { fill } from '../lib.js';
import { h, api, toast, liveBadge, hasSession, etaText, ratingBadge, todayHours } from '../lib.js';

const QUICK = ['General Physician', 'Paediatrician', 'Dermatologist', 'Dentist', 'Gynaecologist', 'Orthopaedic'];

export default function home(root) {
  let coords = null;
  let q = '';
  let debounce;

  const list = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading clinics…'));
  const input = h('input', {
    type: 'search',
    placeholder: 'Search a doctor, speciality or clinic',
    autocomplete: 'off',
    'aria-label': 'Search doctors, specialities or clinics',
    oninput: () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        q = input.value.trim();
        load();
      }, 300);
    },
  });
  const nearBtn = h('button', { type: 'button', class: 'btn ghost', onclick: toggleNear }, '📍 Near me');

  function toggleNear() {
    if (coords) {
      coords = null;
      nearBtn.textContent = '📍 Near me';
      nearBtn.classList.add('ghost');
      load();
      return;
    }
    if (!navigator.geolocation) return toast('Location is not available in this browser.', 'error');
    nearBtn.disabled = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        nearBtn.textContent = '📍 Nearest first ✓';
        nearBtn.classList.remove('ghost');
        nearBtn.disabled = false;
        load();
      },
      () => {
        nearBtn.disabled = false;
        toast('Could not get your location. Allow location access and try again.', 'error', 5000);
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
    );
  }

  function doctorRow(d, c) {
    const sessionOn = hasSession(d.live);
    return h('div', { class: 'doctor-row' },
      h('div', { class: 'grow' },
        h('a', { class: 'doc-name', href: `#/doctor/${d.id}` }, d.name),
        h('div', { class: 'muted small' }, [d.specialization, d.qualification, d.fee ? `₹${d.fee}` : null].filter(Boolean).join(' · ')),
        liveBadge(d.live),
        !c.claimed ? h('div', { class: 'muted small' }, todayHours(d.live)) : null
      ),
      sessionOn
        ? h('div', { class: 'qmini' },
            d.now_serving != null ? h('div', {}, 'Now serving ', h('strong', {}, '#' + d.now_serving)) : h('div', {}, 'No one inside yet'),
            h('div', {}, `${d.waiting_count} waiting · ${etaText(d.est_wait_minutes)}`)
          )
        : null,
      c.claimed
        ? h('a', { class: 'btn small', href: `#/doctor/${d.id}` }, 'Book / join queue')
        : [
            c.phone ? h('a', { class: 'btn small', href: 'tel:' + c.phone }, '📞 Call') : null,
            h('a', { class: 'btn small ghost', href: `#/doctor/${d.id}` }, 'Details'),
          ]
    );
  }

  function clinicCard(c) {
    return h('section', { class: 'card' },
      h('div', { class: 'row between' },
        h('div', {},
          h('h3', {}, c.name),
          h('p', { class: 'muted small' }, `${c.address}, ${c.city}` + (c.distance_km != null ? ` · ${c.distance_km} km away` : ''))
        ),
        h('div', { class: 'row' },
          ratingBadge(c),
          c.claimed ? h('span', { class: 'badge ' + (c.is_open ? 'ok' : 'bad') }, c.is_open ? 'Open today' : 'Closed today') : null
        )
      ),
      c.notice ? h('p', { class: 'notice' }, c.notice) : null,
      c.doctors.map((d) => doctorRow(d, c))
    );
  }

  async function load(silent = false) {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (coords) {
      params.set('lat', coords.lat);
      params.set('lng', coords.lng);
    }
    try {
      const { clinics } = await api('/clinics?' + params);
      if (!clinics.length) {
        fill(list, 
          h('div', { class: 'card center' },
            h('p', {}, 'No clinics match that search.'),
            h('p', { class: 'muted small' }, 'Try a different word, or ask your clinic to join ClinicQ.')
          )
        );
      } else {
        fill(list, ...clinics.map(clinicCard));
      }
    } catch (e) {
      if (!silent) fill(list, h('p', { class: 'error' }, e.message));
    }
  }

  root.append(
    h('div', { class: 'hero' },
      h('h1', {}, 'Skip the waiting room.'),
      h('p', {}, 'See which doctors are in, book a slot, or join the live queue from home and arrive when your turn is close. No phone calls.')
    ),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, input), nearBtn),
    h('div', { class: 'pills' },
      QUICK.map((s) =>
        h('button', { type: 'button', class: 'pill', onclick: () => { input.value = s; q = s; load(); } }, s)
      )
    ),
    list,
    h('p', { class: 'muted small center' }, 'Queue numbers refresh automatically every few seconds.')
  );

  load();
  const timer = setInterval(() => load(true), 15000);
  return () => {
    clearInterval(timer);
    clearTimeout(debounce);
  };
}

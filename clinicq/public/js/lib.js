// Small shared helpers: DOM builder, API client, session, formatting, live stream.
// All user-supplied text goes through text nodes (never innerHTML), so names can't inject markup.

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  const props = [];
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (['value', 'checked', 'disabled', 'selected'].includes(k)) props.push([k, v]);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  for (const [k, v] of props) el[k] = v; // after children so <select value> works
  // Link each <label> to the form control right after it, so screen readers and taps on the label work.
  const children = Array.from(el.children);
  children.forEach((c, i) => {
    const next = children[i + 1];
    if (c.tagName === 'LABEL' && !c.htmlFor && next && /^(INPUT|SELECT|TEXTAREA)$/.test(next.tagName)) {
      if (!next.id) next.id = 'f' + ++uid;
      c.htmlFor = next.id;
    }
  });
  return el;
}

let uid = 0;

/** Replaces an element's children, accepting nested arrays and skipping null/false like h() does. */
export function fill(el, ...kids) {
  el.replaceChildren(
    ...kids
      .flat(Infinity)
      .filter((k) => k != null && k !== false)
      .map((k) => (k instanceof Node ? k : document.createTextNode(String(k))))
  );
  return el;
}

// ---------------------------------------------------------------- session
export const session = {
  get token() {
    return localStorage.getItem('cq_token');
  },
  get user() {
    try {
      return JSON.parse(localStorage.getItem('cq_user') || 'null');
    } catch {
      return null;
    }
  },
  set({ token, user }) {
    localStorage.setItem('cq_token', token);
    localStorage.setItem('cq_user', JSON.stringify(user));
    window.dispatchEvent(new Event('session'));
  },
  clear() {
    localStorage.removeItem('cq_token');
    localStorage.removeItem('cq_user');
    window.dispatchEvent(new Event('session'));
  },
};

export async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = session.token;
  if (token) headers.Authorization = 'Bearer ' + token;
  let res;
  try {
    res = await fetch('/api' + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error('Cannot reach the server. Check your connection.');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    if (res.status === 401 && token) {
      session.clear();
      location.hash = '#/login';
    }
    throw new Error((data && data.error) || `Request failed (${res.status})`);
  }
  return data;
}

// ---------------------------------------------------------------- feedback
export function toast(message, kind = '', ms = 3500) {
  const box = document.getElementById('toasts');
  const el = h('div', { class: 'toast ' + kind, role: kind === 'error' ? 'alert' : 'status' }, message);
  box.append(el);
  if (ms) setTimeout(() => el.remove(), ms);
  else el.addEventListener('click', () => el.remove());
  return el;
}

/** Wraps an async click/submit handler: disables the button and reports errors as toasts. */
export function guard(fn) {
  return async (ev) => {
    ev?.preventDefault?.();
    const btn = ev?.submitter || ev?.currentTarget;
    if (btn && 'disabled' in btn) btn.disabled = true;
    try {
      await fn(ev);
    } catch (e) {
      toast(e.message, 'error', 5000);
    } finally {
      if (btn && 'disabled' in btn) btn.disabled = false;
    }
  };
}

// -------------------------------------------------------------- formatting
export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function fmtTime(hm) {
  if (!hm) return '';
  const [H, M] = hm.split(':').map(Number);
  return `${H % 12 || 12}:${String(M).padStart(2, '0')} ${H >= 12 ? 'PM' : 'AM'}`;
}

export function fmtDate(ds, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  const [y, m, d] = ds.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', { ...opts, timeZone: 'UTC' });
}

export function addDaysStr(ds, n) {
  const [y, m, d] = ds.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function weekdayOfStr(ds) {
  const [y, m, d] = ds.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function etaText(min) {
  if (min == null) return '';
  if (min <= 0) return 'no wait';
  if (min < 60) return `~${min} min`;
  return `~${Math.floor(min / 60)}h ${min % 60}m`;
}

const LIVE = {
  listed: ['Listing only · call to book', ''],
  in: ['Doctor is in', 'ok'],
  break: ['On a short break', 'warn'],
  away: ['Away today', 'bad'],
  on_leave: ['On leave today', 'bad'],
  not_today: ['Not sitting today', ''],
  clinic_closed: ['Clinic closed today', 'bad'],
  finished: ['Done for today', ''],
};

export function liveBadge(live) {
  if (live.state === 'opens_later') return h('span', { class: 'badge info' }, `Opens at ${fmtTime(live.opens_at)}`);
  const [text, tone] = LIVE[live.state] || [live.state, ''];
  return h('span', { class: 'badge ' + tone }, text);
}

/** "★ 4.7 (376)" badge, or nothing when the clinic has no rating. */
export function ratingBadge(c) {
  if (c.rating == null) return null;
  const tone = c.rating >= 4.5 ? 'ok' : c.rating >= 3.5 ? 'warn' : '';
  const count = c.rating_count ? ` (${c.rating_count})` : '';
  return h('span', { class: 'badge ' + tone, title: c.rating_source ? `Rating from ${c.rating_source}` : '' }, `★ ${c.rating.toFixed(1)}${count}`);
}

/** Today's sessions as text, e.g. "Today: 10:30 AM–1:30 PM, 6:30 PM–10:00 PM". */
export function todayHours(live) {
  const w = live.today_windows || [];
  return w.length ? 'Today: ' + w.map((x) => `${fmtTime(x.start)}–${fmtTime(x.end)}`).join(', ') : 'No timings listed for today';
}

export function hasSession(live) {
  return ['in', 'break', 'opens_later'].includes(live.state);
}

// ------------------------------------------------------------- live stream
/** Subscribes to a doctor's public queue stream. Returns a function that closes it. */
export function openStream(doctorId, onData) {
  const es = new EventSource(`/api/doctors/${doctorId}/queue/stream`);
  es.addEventListener('queue', (ev) => {
    try {
      onData(JSON.parse(ev.data));
    } catch {
      /* ignore malformed frame */
    }
  });
  return () => es.close();
}

export function requireRole(role) {
  const u = session.user;
  if (!u || (role && u.role !== role)) {
    sessionStorage.setItem('cq_next', location.hash);
    location.hash = '#/login';
    return false;
  }
  return true;
}

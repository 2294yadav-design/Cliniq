import { fill } from '../lib.js';
import { h, api, session, guard } from '../lib.js';

function afterAuth(user) {
  const next = sessionStorage.getItem('cq_next');
  sessionStorage.removeItem('cq_next');
  if (user.role === 'clinic') location.hash = '#/dashboard';
  else location.hash = next && next !== '#/dashboard' && next !== '#/login' ? next : '#/';
}

export function login(root) {
  if (session.user) {
    location.hash = session.user.role === 'clinic' ? '#/dashboard' : '#/';
    return;
  }
  const phone = h('input', { type: 'tel', inputmode: 'numeric', autocomplete: 'username', required: true, placeholder: '10-digit mobile number' });
  const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  root.append(
    h('div', { class: 'stack', },
      h('h2', {}, 'Log in'),
      h('form', {
        class: 'form card',
        onsubmit: guard(async () => {
          const res = await api('/auth/login', { method: 'POST', body: { phone: phone.value, password: pw.value } });
          session.set(res);
          afterAuth(res.user);
        }),
      },
        h('div', {}, h('label', {}, 'Phone number'), phone),
        h('div', {}, h('label', {}, 'Password'), pw),
        h('button', { class: 'btn', type: 'submit' }, 'Log in')
      ),
      h('p', { class: 'muted' }, 'New here? ', h('a', { href: '#/register' }, 'Create an account'))
    )
  );
}

export function register(root) {
  if (session.user) {
    location.hash = '#/';
    return;
  }
  let role = 'patient';
  const name = h('input', { type: 'text', autocomplete: 'name', required: true, minlength: 2, maxlength: 80 });
  const phone = h('input', { type: 'tel', inputmode: 'numeric', autocomplete: 'username', required: true, placeholder: '10-digit mobile number' });
  const pw = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 6 });
  const nameLabel = h('label', {}, 'Your name');
  const hint = h('p', { class: 'muted small' });
  const pills = h('div', { class: 'pills' });

  function paint() {
    fill(pills, 
      h('button', { type: 'button', class: 'pill' + (role === 'patient' ? ' sel' : ''), onclick: () => { role = 'patient'; paint(); } }, "I'm a patient"),
      h('button', { type: 'button', class: 'pill' + (role === 'clinic' ? ' sel' : ''), onclick: () => { role = 'clinic'; paint(); } }, 'I run a clinic')
    );
    nameLabel.textContent = role === 'clinic' ? 'Your name (clinic admin or receptionist)' : 'Your name';
    hint.textContent =
      role === 'clinic'
        ? 'Next you will add your clinic, doctors and timings, then manage the live queue from a dashboard.'
        : 'Book appointments and follow your place in the queue live.';
  }
  paint();

  root.append(
    h('div', { class: 'stack' },
      h('h2', {}, 'Create your account'),
      h('form', {
        class: 'form card',
        onsubmit: guard(async () => {
          const res = await api('/auth/register', { method: 'POST', body: { name: name.value, phone: phone.value, password: pw.value, role } });
          session.set(res);
          afterAuth(res.user);
        }),
      },
        pills,
        hint,
        h('div', {}, nameLabel, name),
        h('div', {}, h('label', {}, 'Phone number'), phone),
        h('div', {}, h('label', {}, 'Password (min 6 characters)'), pw),
        h('button', { class: 'btn', type: 'submit' }, 'Sign up')
      ),
      h('p', { class: 'muted' }, 'Already registered? ', h('a', { href: '#/login' }, 'Log in'))
    )
  );
}

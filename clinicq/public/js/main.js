import { h, session } from './lib.js';
import home from './views/home.js';
import doctor from './views/doctor.js';
import my from './views/my.js';
import { login, register } from './views/auth.js';
import dashboard from './views/dashboard.js';

const app = document.getElementById('app');
const nav = document.getElementById('nav');

const routes = [
  [/^#\/?$/, home],
  [/^#\/doctor\/(\d+)$/, doctor],
  [/^#\/my$/, my],
  [/^#\/login$/, login],
  [/^#\/register$/, register],
  [/^#\/dashboard$/, dashboard],
];

let cleanup = null;
let routeId = 0;

function renderNav() {
  const u = session.user;
  const cur = location.hash || '#/';
  const link = (href, label) => h('a', { href, class: cur === href ? 'active' : '' }, label);
  const items = [
    link('#/', 'Find doctors'),
    u?.role === 'patient' && link('#/my', 'My bookings'),
    u?.role === 'clinic' && link('#/dashboard', 'Dashboard'),
    ...(u
      ? [
          h(
            'button',
            {
              type: 'button',
              onclick: () => {
                session.clear();
                const alreadyHome = (location.hash || '#/') === '#/';
                location.hash = '#/';
                if (alreadyHome) route();
              },
            },
            `Log out (${u.name.split(' ')[0]})`
          ),
        ]
      : [link('#/login', 'Log in'), link('#/register', 'Sign up')]),
  ];
  nav.replaceChildren(...items.filter(Boolean));
}

async function route() {
  const id = ++routeId;
  if (cleanup) {
    try {
      cleanup();
    } catch {
      /* ignore */
    }
    cleanup = null;
  }
  const hash = location.hash || '#/';
  renderNav();
  const match = routes.map(([re, view]) => [re.exec(hash), view]).find(([m]) => m);
  const root = h('div');
  app.replaceChildren(root);
  if (!match) {
    root.append(h('h2', {}, 'Page not found'), h('a', { href: '#/' }, 'Back to home'));
    return;
  }
  window.scrollTo(0, 0);
  try {
    const result = await match[1](root, match[0].slice(1));
    if (id !== routeId) result?.(); // user navigated away while this view was loading
    else cleanup = result || null;
  } catch (e) {
    if (id === routeId) root.replaceChildren(h('p', { class: 'error' }, e.message), h('a', { href: '#/' }, 'Back to home'));
  }
}

window.addEventListener('hashchange', route);
window.addEventListener('session', renderNav);
route();

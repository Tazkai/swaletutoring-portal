import './office.css';
import { h } from '../ui';
import { api } from './api';
import { notice } from './forms';
import { isNotFound, newPupilScreen, pupilListScreen, pupilScreen } from './pupils';
import { auditScreen, usersScreen } from './users';

const root = document.getElementById('office') as HTMLElement;
const content = h('main', { class: 'content', id: 'content', tabindex: -1 });
const who = h('p', { class: 'who' });

const NAV = [
  ['#/pupils', 'Pupils'],
  ['#/users', 'People'],
  ['#/audit', 'Audit log'],
] as const;

const nav = h(
  'nav',
  { class: 'nav', 'aria-label': 'Office' },
  h('div', { class: 'brand' }, h('img', { src: '/icons/icon-192.png', alt: '', width: 40, height: 40 }), h('span', {}, 'STS Office')),
  h('ul', {}, NAV.map(([href, label]) => h('li', {}, h('a', { href }, label)))),
  who,
  h('p', { class: 'nav-note' }, 'Fabricated data only until the DPIA is signed.'),
);
root.replaceChildren(nav, content);

function markActive(): void {
  for (const a of nav.querySelectorAll('a')) {
    const active = location.hash.startsWith(a.getAttribute('href') ?? '###');
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

let flash: HTMLElement | undefined;

async function render(): Promise<void> {
  if (!location.hash || location.hash === '#/') {
    location.hash = '#/pupils';
    return;
  }
  markActive();
  const refresh = (message?: HTMLElement) => {
    flash = message;
    void render();
  };
  try {
    let view: HTMLElement;
    const pupil = location.hash.match(/^#\/pupils\/(\d+)$/);
    if (location.hash === '#/pupils') view = await pupilListScreen();
    else if (location.hash === '#/pupils/new') view = newPupilScreen();
    else if (pupil?.[1]) view = await pupilScreen(Number(pupil[1]), () => refresh());
    else if (location.hash === '#/users') view = await usersScreen(refresh, flash);
    else if (location.hash === '#/audit') view = await auditScreen();
    else view = h('p', {}, 'Page not found.');
    flash = undefined;
    content.replaceChildren(view);
  } catch (err) {
    content.replaceChildren(
      notice('bad', isNotFound(err) ? 'That record does not exist.' : (err as Error).message),
    );
  }
}

window.addEventListener('hashchange', () => {
  void render().then(() => content.focus({ preventScroll: true }));
});

void (async () => {
  try {
    const me = await api.get<{ user: { display_name: string; role: string } }>('/api/office/me');
    who.textContent = `Signed in as ${me.user.display_name} (${me.user.role})`;
    await render();
  } catch (err) {
    content.replaceChildren(notice('bad', (err as Error).message));
  }
})();

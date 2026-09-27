import './styles.css';
import type { Me, PupilSummary, SessionView } from '../shared/types';
import { cachedGet } from './api';
import {
  deliveryOf,
  dropRejected,
  flush,
  onQueueStatus,
  onSent,
  rejectionFor,
  type Delivery,
  type QueueStatus,
} from './queue';
import { absenceScreen } from './screens/absence';
import { homeScreen } from './screens/home';
import { recordScreen } from './screens/record';
import {
  endSession,
  listSessions,
  localDate,
  markConfirmed,
  recordAbsence,
  reconcile,
  saveDraft,
  startSession,
  submitRecord,
  type LocalSession,
} from './sessions';
import { h, telHref } from './ui';

interface State {
  loaded: boolean;
  me: Me | undefined;
  pupils: PupilSummary[];
  showingSavedList: boolean;
  authRequired: boolean;
  sessions: LocalSession[];
  delivery: Map<string, Delivery>;
  queue: QueueStatus | undefined;
}

const state: State = {
  loaded: false,
  me: undefined,
  pupils: [],
  showingSavedList: false,
  authRequired: false,
  sessions: [],
  delivery: new Map(),
  queue: undefined,
};

const root = document.getElementById('app') as HTMLElement;
const statusSlot = h('div', { class: 'status-slot' });
const screenSlot = h('div', { class: 'screen-slot' });
const callSlot = h('div', { class: 'call-slot' });
root.replaceChildren(topBar(), statusSlot, screenSlot, callSlot);

type Route =
  | { name: 'home' }
  | { name: 'record'; uuid: string }
  | { name: 'absence'; pupilId: number; uuid: string | undefined };

const route = (): Route => {
  const record = location.hash.match(/^#\/record\/([0-9a-f-]{36})$/);
  if (record?.[1]) return { name: 'record', uuid: record[1] };
  const absence = location.hash.match(/^#\/absent\/(\d+)(?:\/([0-9a-f-]{36}))?$/);
  if (absence?.[1]) return { name: 'absence', pupilId: Number(absence[1]), uuid: absence[2] };
  return { name: 'home' };
};

function topBar(): HTMLElement {
  return h(
    'header',
    { class: 'topbar' },
    h('img', { src: '/icons/icon-192.png', alt: '', width: 36, height: 36 }),
    h('h1', {}, 'Swale Tutoring'),
  );
}

// ---------- rendering ----------

function renderStatus(): void {
  const q = state.queue;
  const needsSignIn = state.authRequired || q?.needsSignIn;
  const parts: HTMLElement[] = [];

  if (needsSignIn) {
    parts.push(
      h(
        'div',
        { class: 'banner banner-warn', role: 'alert' },
        h('strong', {}, 'Your sign-in has run out. '),
        'Nothing on this phone is lost. ',
        h(
          'button',
          { class: 'btn btn-small', type: 'button', onclick: () => location.reload() },
          'Sign in again',
        ),
      ),
    );
  }
  if (q && q.pending > 0) {
    parts.push(
      h(
        'div',
        { class: 'banner banner-warn', role: 'status' },
        h('strong', {}, `${q.pending} ${q.pending === 1 ? 'change' : 'changes'} not yet sent. `),
        q.online ? 'Sending…' : 'No signal. It will send by itself when you have signal.',
      ),
    );
  }
  if (q && q.rejected > 0) {
    parts.push(
      h(
        'div',
        { class: 'banner banner-bad', role: 'alert' },
        h('strong', {}, 'Something was not accepted. '),
        'It is saved on this phone. Please tell the office.',
      ),
    );
  }
  statusSlot.replaceChildren(...parts);
}

function renderCallBar(): void {
  const phone = state.me?.dsl_phone;
  callSlot.replaceChildren(
    phone
      ? h(
          'a',
          { class: 'callbar', href: telHref(phone) },
          h('span', {}, 'Urgent safeguarding concern?'),
          h('strong', {}, `Call the DSL · ${phone}`),
        )
      : h('span'),
  );
}

async function renderScreen(): Promise<void> {
  if (!state.loaded) {
    screenSlot.replaceChildren(h('main', { class: 'screen' }, h('p', { class: 'note' }, 'Loading…')));
    return;
  }
  if (!state.me) {
    screenSlot.replaceChildren(
      h(
        'main',
        { class: 'screen' },
        state.authRequired
          ? [
              h('h2', {}, 'Please sign in'),
              h('button', { class: 'btn btn-primary', type: 'button', onclick: () => location.reload() }, 'Sign in'),
            ]
          : [
              h('h2', {}, 'No signal'),
              h('p', {}, 'The app needs signal the first time it is opened. Try again when you have signal.'),
              h('button', { class: 'btn btn-primary', type: 'button', onclick: () => location.reload() }, 'Try again'),
            ],
      ),
    );
    return;
  }

  const r = route();
  if (r.name === 'absence') {
    const pupil = state.pupils.find((p) => p.id === r.pupilId);
    const open = r.uuid
      ? state.sessions.find((s) => s.client_uuid === r.uuid && s.stage === 'open')
      : undefined;
    if (!pupil || (r.uuid && !open)) {
      location.hash = '';
      return;
    }
    screenSlot.replaceChildren(
      absenceScreen({
        pupilName: `${pupil.first_name} ${pupil.last_name}`,
        fromOpenSession: !!open,
        dslPhone: state.me.dsl_phone,
        submit: async (details) => {
          const uuid = await recordAbsence(
            { id: pupil.id, name: `${pupil.first_name} ${pupil.last_name}` },
            details,
            open?.client_uuid,
          );
          await Promise.race([flush(), new Promise((resolve) => setTimeout(resolve, 10_000))]);
          await refreshSessions();
          return deliveryOf(uuid);
        },
        cancel: () => {
          location.hash = '';
        },
        done: () => {
          location.hash = '';
        },
      }),
    );
    return;
  }

  if (r.name === 'record') {
    const session = state.sessions.find((s) => s.client_uuid === r.uuid);
    if (!session) {
      location.hash = '';
      return;
    }
    screenSlot.replaceChildren(
      recordScreen({
        session,
        rejection: await rejectionFor(session.client_uuid),
        saveDraft: (draft) => void saveDraft(session.client_uuid, draft),
        submit: async (body) => {
          await dropRejected(session.client_uuid, 'record');
          await submitRecord(session.client_uuid, body);
          // Wait briefly for the server; if there's no answer, say plainly it isn't sent.
          await Promise.race([flush(), new Promise((resolve) => setTimeout(resolve, 10_000))]);
          await refreshSessions();
          return deliveryOf(session.client_uuid);
        },
        done: () => {
          location.hash = '';
        },
      }),
    );
    return;
  }

  screenSlot.replaceChildren(
    homeScreen({
      pupils: state.pupils,
      sessions: state.sessions,
      delivery: state.delivery,
      showingSavedList: state.showingSavedList,
      startSession: async (pupil, venue) => {
        await startSession(pupil, venue);
        await refreshSessions();
        void renderScreen();
      },
      endSession: async (s) => {
        await endSession(s.client_uuid);
        await refreshSessions();
        location.hash = `#/record/${s.client_uuid}`;
      },
      openRecord: (uuid) => {
        location.hash = `#/record/${uuid}`;
      },
      openAbsence: (pupilId, uuid) => {
        location.hash = uuid ? `#/absent/${pupilId}/${uuid}` : `#/absent/${pupilId}`;
      },
    }),
  );
}

// ---------- data ----------

async function refreshSessions(): Promise<void> {
  state.sessions = await listSessions();
  const entries = await Promise.all(
    state.sessions.map(async (s) => [s.client_uuid, await deliveryOf(s.client_uuid)] as const),
  );
  state.delivery = new Map(entries);
}

async function load(): Promise<void> {
  const [me, pupils, open] = await Promise.all([
    cachedGet<Me>('/api/me', 'me'),
    cachedGet<PupilSummary[]>('/api/pupils', 'pupils'),
    cachedGet<SessionView[]>('/api/sessions/open', 'open'),
  ]);
  state.me = me.data;
  state.pupils = pupils.data ?? [];
  state.showingSavedList = !pupils.fresh && pupils.data !== undefined;
  state.authRequired = me.authRequired || pupils.authRequired;

  await reconcile(open.fresh ? open.data : undefined, localDate(new Date().toISOString()));
  await refreshSessions();
  state.loaded = true;
  renderStatus();
  renderCallBar();
  await renderScreen();
}

// ---------- wiring ----------

onQueueStatus((q) => {
  state.queue = q;
  renderStatus();
});

onSent(async (item) => {
  if (item.kind === 'record' || item.kind === 'absence') await markConfirmed(item.client_uuid);
  await refreshSessions();
  // Don't redraw the record form under someone's thumbs; the home screen is safe to refresh.
  if (route().name === 'home') void renderScreen();
});

window.addEventListener('hashchange', () => void renderScreen());
window.addEventListener('online', () => void flush());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    void flush();
    if (route().name === 'home') void load();
  }
});
setInterval(() => {
  if (state.queue && state.queue.pending > 0) void flush();
}, 60_000);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register('/sw.js');
}
// Ask the browser not to evict our storage: it may hold records not yet sent.
void navigator.storage?.persist?.();

void renderScreen();
void load().then(() => flush());

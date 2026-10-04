import { KEY_INFO_FIELDS, KEY_INFO_LABELS, type KeyInfoField, type KeyInfoView } from '../../shared/types';
import { h } from '../ui';

export interface KeyInfoContext {
  pupilName: string;
  info: KeyInfoView | null;
  fromCache: boolean;
  confirmedVersion: number; // highest version confirmed on this phone or the server
  confirm: (version: number) => Promise<void>;
  back: () => void;
  startAfter?: () => void; // when opened from "Start session", carry on afterwards
}

// The things a tutor most needs at a glance go first, highlighted.
const PRIORITY: KeyInfoField[] = ['allergies', 'medication', 'medical_plan', 'what_not_to_do', 'triggers', 'de_escalation'];

export function keyInfoScreen(ctx: KeyInfoContext): HTMLElement {
  const info = ctx.info;
  const back = h('button', { class: 'btn btn-quiet', type: 'button', onclick: ctx.back }, 'Back');

  if (!info) {
    return h(
      'main',
      { class: 'screen' },
      h('h2', {}, `Key information: ${ctx.pupilName}`),
      h(
        'p',
        { class: 'note' },
        ctx.fromCache
          ? 'Not available on this phone yet. Open this page once with signal.'
          : 'The office hasn’t added key information for this pupil yet.',
      ),
      back,
    );
  }

  const order = [...PRIORITY, ...KEY_INFO_FIELDS.filter((f) => !PRIORITY.includes(f))];
  const filled = order.filter((f) => info.fields[f]);
  const isConfirmed = ctx.confirmedVersion >= info.version && info.version > 0;

  const confirmArea = h('div', { class: 'confirm-area' });
  const renderConfirm = (done: boolean) =>
    confirmArea.replaceChildren(
      done
        ? h(
            'div',
            {},
            h('p', { class: 'chip chip-ok' }, `✓ You have read version ${info.version}`),
            ctx.startAfter &&
              h('button', { class: 'btn btn-primary', type: 'button', onclick: ctx.startAfter }, 'Continue to start the session'),
          )
        : h(
            'button',
            {
              class: 'btn btn-primary',
              type: 'button',
              onclick: async (e: Event) => {
                (e.currentTarget as HTMLButtonElement).disabled = true;
                await ctx.confirm(info.version);
                renderConfirm(true);
              },
            },
            'I have read this',
          ),
    );
  if (info.version > 0) renderConfirm(isConfirmed);

  return h(
    'main',
    { class: 'screen' },
    h('h2', {}, `Key information: ${ctx.pupilName}`),
    ctx.fromCache && h('p', { class: 'note' }, 'No signal: showing the copy saved on this phone.'),
    info.version > 0 && !isConfirmed && h('div', { class: 'banner banner-warn' }, h('strong', {}, 'Please read this before your session. '), 'It is new or has changed.'),
    info.first_aider_required &&
      h('div', { class: 'banner banner-bad' }, h('strong', {}, 'Looked-after child: '), 'a certified first-aider must be present at every session.'),
    filled.length === 0 && info.version > 0 && h('p', { class: 'note' }, 'No details recorded.'),
    h(
      'dl',
      { class: 'key-info' },
      filled.map((f) => [
        h('dt', { class: PRIORITY.includes(f) ? 'priority' : '' }, KEY_INFO_LABELS[f]),
        h('dd', {}, String(info.fields[f])),
      ]),
    ),
    info.targets.length > 0 &&
      h(
        'section',
        {},
        h('h3', {}, 'Current targets'),
        h(
          'ul',
          { class: 'targets' },
          info.targets.map((t) =>
            h('li', {}, h('strong', {}, t.target), t.ehcp_outcome ? ` (${t.ehcp_outcome})` : '', t.measure ? h('div', { class: 'note' }, `Measured by: ${t.measure}`) : ''),
          ),
        ),
      ),
    confirmArea,
    back,
  );
}

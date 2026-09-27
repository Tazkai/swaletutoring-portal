import { VENUE_LABELS, VENUES, type PupilSummary, type Venue } from '../../shared/types';
import type { Delivery } from '../queue';
import { clockTime, localDate, type LocalSession } from '../sessions';
import { h } from '../ui';

export interface HomeContext {
  pupils: PupilSummary[];
  sessions: LocalSession[];
  delivery: Map<string, Delivery>;
  showingSavedList: boolean;
  startSession: (pupil: PupilSummary, venue: Venue) => Promise<void>;
  endSession: (session: LocalSession) => Promise<void>;
  openRecord: (clientUuid: string) => void;
}

// Which pupil card has its "start" panel open. Survives re-renders.
let expandedPupil: number | null = null;

export function deliveryChip(d: Delivery | undefined): HTMLElement {
  if (d === 'rejected') return h('span', { class: 'chip chip-bad' }, 'Problem: tell the office');
  if (d === 'pending') return h('span', { class: 'chip chip-warn' }, 'Not yet sent');
  return h('span', { class: 'chip chip-ok' }, '✓ Sent');
}

export function homeScreen(ctx: HomeContext): HTMLElement {
  const today = localDate(new Date().toISOString());
  const active = ctx.sessions.filter((s) => s.stage !== 'submitted');
  const busyPupils = new Set(active.map((s) => s.pupil_id));
  // Anything not yet confirmed stays on screen whatever day it's from.
  const done = ctx.sessions
    .filter((s) => s.stage === 'submitted')
    .filter((s) => localDate(s.started_at) === today || ctx.delivery.get(s.client_uuid) !== 'sent')
    .reverse();

  return h(
    'main',
    { class: 'screen' },
    active.length > 0 &&
      h(
        'section',
        { 'aria-labelledby': 'in-session' },
        h('h2', { id: 'in-session' }, 'In session'),
        active.map((s) => activeCard(s, ctx)),
      ),

    h(
      'section',
      { 'aria-labelledby': 'pupils' },
      h('h2', { id: 'pupils' }, 'Your pupils'),
      ctx.showingSavedList &&
        h('p', { class: 'note' }, 'No signal: showing the list saved on this phone.'),
      ctx.pupils.length === 0 &&
        h('p', { class: 'note' }, 'No pupils are linked to you yet. The office sets this up.'),
      ctx.pupils
        .filter((p) => !busyPupils.has(p.id))
        .map((p) => pupilCard(p, ctx)),
    ),

    done.length > 0 &&
      h(
        'section',
        { 'aria-labelledby': 'done' },
        h('h2', { id: 'done' }, 'Records'),
        h(
          'ul',
          { class: 'done-list' },
          done.map((s) =>
            h(
              'li',
              {},
              h(
                'span',
                {},
                h('strong', {}, s.pupil_name),
                ` ${clockTime(s.started_at)}–${clockTime(s.ended_at)}`,
                localDate(s.started_at) !== today &&
                  ` (${new Date(s.started_at).toLocaleDateString('en-GB')})`,
              ),
              deliveryChip(ctx.delivery.get(s.client_uuid)),
            ),
          ),
        ),
      ),
  );
}

function activeCard(s: LocalSession, ctx: HomeContext): HTMLElement {
  const delivery = ctx.delivery.get(s.client_uuid);
  return h(
    'article',
    { class: 'card card-active' },
    h('h3', {}, s.pupil_name),
    h(
      'p',
      { class: 'meta' },
      s.stage === 'open'
        ? `Started ${clockTime(s.started_at)} · ${VENUE_LABELS[s.venue]}`
        : `${clockTime(s.started_at)}–${clockTime(s.ended_at)} · ${VENUE_LABELS[s.venue]}`,
      ' ',
      delivery !== 'sent' && deliveryChip(delivery),
    ),
    s.stage === 'open'
      ? h(
          'button',
          {
            class: 'btn btn-primary',
            type: 'button',
            onclick: async (e: Event) => {
              (e.currentTarget as HTMLButtonElement).disabled = true;
              await ctx.endSession(s);
            },
          },
          'End session',
        )
      : h(
          'button',
          { class: 'btn btn-primary', type: 'button', onclick: () => ctx.openRecord(s.client_uuid) },
          'Finish lesson record',
        ),
  );
}

function pupilCard(p: PupilSummary, ctx: HomeContext): HTMLElement {
  const name = `${p.first_name} ${p.last_name}`;
  if (expandedPupil !== p.id) {
    return h(
      'article',
      { class: 'card' },
      h('h3', {}, name),
      h(
        'button',
        {
          class: 'btn btn-primary',
          type: 'button',
          onclick: (e: Event) => {
            expandedPupil = p.id;
            const card = (e.currentTarget as HTMLElement).closest('article');
            card?.replaceWith(pupilCard(p, ctx));
          },
        },
        'Start session',
      ),
    );
  }

  const fallback: Venue = p.last_venue ?? 'home';
  const radios = VENUES.map((v) =>
    h(
      'label',
      { class: 'choice' },
      h('input', { type: 'radio', name: `venue-${p.id}`, value: v, checked: v === fallback }),
      h('span', {}, VENUE_LABELS[v]),
    ),
  );

  return h(
    'article',
    { class: 'card card-open' },
    h('h3', {}, name),
    h(
      'fieldset',
      { class: 'choices choices-2' },
      h('legend', {}, 'Where?'),
      radios,
    ),
    h(
      'button',
      {
        class: 'btn btn-primary',
        type: 'button',
        onclick: async (e: Event) => {
          const btn = e.currentTarget as HTMLButtonElement;
          btn.disabled = true;
          const card = btn.closest('article');
          const picked = card?.querySelector<HTMLInputElement>(`input[name="venue-${p.id}"]:checked`);
          expandedPupil = null;
          await ctx.startSession(p, (picked?.value as Venue | undefined) ?? fallback);
        },
      },
      'Start session now',
    ),
    h(
      'button',
      {
        class: 'btn btn-quiet',
        type: 'button',
        onclick: (e: Event) => {
          expandedPupil = null;
          (e.currentTarget as HTMLElement).closest('article')?.replaceWith(pupilCard(p, ctx));
        },
      },
      'Cancel',
    ),
  );
}

import {
  NON_ATTENDANCE_LABELS,
  VENUE_LABELS,
  VENUES,
  type PupilSummary,
  type Venue,
} from '../../shared/types';
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
  openAbsence: (pupilId: number, openSessionUuid?: string) => void;
  refresh: () => void;
}

// Which pupil card has its "start" panel open. Survives re-renders.
let expandedPupil: number | null = null;

export function deliveryChip(d: Delivery | undefined): HTMLElement {
  if (d === 'rejected') return h('span', { class: 'chip chip-bad' }, 'Problem: tell the office');
  if (d === 'pending') return h('span', { class: 'chip chip-warn' }, 'Not yet sent');
  return h('span', { class: 'chip chip-ok' }, '✓ Sent');
}

// The day a record belongs to: a cancellation can be logged for another day.
function recordDay(s: LocalSession): string {
  return s.absence && s.session_date ? s.session_date : localDate(s.started_at);
}

function recordLabel(s: LocalSession): string {
  return s.absence
    ? NON_ATTENDANCE_LABELS[s.absence]
    : `Lesson ${clockTime(s.started_at)}–${clockTime(s.ended_at)}`;
}

function ukDate(day: string): string {
  return new Date(`${day}T12:00`).toLocaleDateString('en-GB');
}

export function homeScreen(ctx: HomeContext): HTMLElement {
  const today = localDate(new Date().toISOString());
  const active = ctx.sessions.filter((s) => s.stage !== 'submitted');
  const busyPupils = new Set(active.map((s) => s.pupil_id));
  const submitted = ctx.sessions.filter((s) => s.stage === 'submitted');

  const todaysRecords = new Map<number, LocalSession[]>();
  for (const s of submitted) {
    if (recordDay(s) !== today) continue;
    todaysRecords.set(s.pupil_id, [...(todaysRecords.get(s.pupil_id) ?? []), s]);
  }
  // Done today = recorded on this phone today, or the server says so (unless we're
  // offline on yesterday's saved list, when its flag may be stale).
  const isDone = (p: PupilSummary) =>
    todaysRecords.has(p.id) || (!ctx.showingSavedList && p.done_today === 1);
  const available = ctx.pupils.filter((p) => !busyPupils.has(p.id));
  const toSee = available.filter((p) => !isDone(p));
  const doneToday = available.filter(isDone);

  // Other days: anything not yet confirmed as sent, and cancellations logged ahead.
  const otherRecords = submitted
    .filter((s) => recordDay(s) !== today)
    .filter((s) => ctx.delivery.get(s.client_uuid) !== 'sent' || recordDay(s) > today)
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
      ctx.pupils.length > 0 &&
        toSee.length === 0 &&
        active.length === 0 &&
        h('p', { class: 'note' }, 'Everyone has a record for today.'),
      toSee.map((p) => pupilCard(p, ctx)),
    ),

    doneToday.length > 0 &&
      h(
        'section',
        { 'aria-labelledby': 'done-today' },
        h('h2', { id: 'done-today' }, 'Done today'),
        doneToday.map((p) => doneCard(p, todaysRecords.get(p.id) ?? [], ctx)),
      ),

    otherRecords.length > 0 &&
      h(
        'section',
        { 'aria-labelledby': 'other' },
        h('h2', { id: 'other' }, 'Other days'),
        h(
          'ul',
          { class: 'done-list' },
          otherRecords.map((s) =>
            h(
              'li',
              {},
              h('span', {}, h('strong', {}, s.pupil_name), ` ${recordLabel(s)} (${ukDate(recordDay(s))})`),
              deliveryChip(ctx.delivery.get(s.client_uuid)),
            ),
          ),
        ),
      ),
  );
}

function doneCard(p: PupilSummary, records: LocalSession[], ctx: HomeContext): HTMLElement {
  return h(
    'article',
    { class: 'card card-done' },
    h('h3', {}, `${p.first_name} ${p.last_name} `, h('span', { class: 'chip chip-ok' }, '✓ Done today')),
    records.length > 0 &&
      h(
        'ul',
        { class: 'record-lines' },
        records.map((s) =>
          h('li', {}, h('span', {}, recordLabel(s)), deliveryChip(ctx.delivery.get(s.client_uuid))),
        ),
      ),
    h(
      'div',
      { class: 'card-actions' },
      h(
        'button',
        {
          class: 'btn btn-quiet btn-compact',
          type: 'button',
          onclick: (e: Event) => {
            expandedPupil = p.id;
            (e.currentTarget as HTMLElement).closest('article')?.replaceWith(pupilCard(p, ctx));
          },
        },
        'Another session',
      ),
      h(
        'button',
        { class: 'btn btn-quiet btn-compact', type: 'button', onclick: () => ctx.openAbsence(p.id) },
        "Didn't attend",
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
      ? [
          h(
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
          ),
          h(
            'button',
            {
              class: 'btn btn-quiet',
              type: 'button',
              onclick: () => ctx.openAbsence(s.pupil_id, s.client_uuid),
            },
            "Pupil didn't attend",
          ),
        ]
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
      h(
        'button',
        { class: 'btn btn-quiet', type: 'button', onclick: () => ctx.openAbsence(p.id) },
        "Didn't attend / cancelled",
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
        onclick: () => {
          expandedPupil = null;
          ctx.refresh();
        },
      },
      'Cancel',
    ),
  );
}

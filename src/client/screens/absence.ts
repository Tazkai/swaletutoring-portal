import {
  NON_ATTENDANCE_LABELS,
  NON_ATTENDANCE_STATUSES,
  REPORTED_STATUSES,
  type NonAttendanceBody,
  type NonAttendanceStatus,
} from '../../shared/types';
import type { Delivery } from '../queue';
import { localDate } from '../sessions';
import { h, telHref } from '../ui';

export interface AbsenceContext {
  pupilName: string;
  fromOpenSession: boolean;
  dslPhone: string | undefined;
  submit: (details: Omit<NonAttendanceBody, 'client_uuid' | 'pupil_id'>) => Promise<Delivery>;
  cancel: () => void;
  done: () => void;
}

// Value for <input type="datetime-local">, in the phone's own time zone.
function localDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${localDate(d.toISOString())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// The no-show alert to the DSL is not automatic yet (slice 2), so the app says so plainly.
function noShowWarning(dslPhone: string | undefined): HTMLElement {
  return h(
    'div',
    { class: 'banner banner-bad', role: 'alert' },
    h('strong', {}, 'The DSL is NOT told automatically yet. '),
    'A pupil not turning up must reach the DSL today. Phone now.',
    dslPhone && h('a', { class: 'btn btn-call', href: telHref(dslPhone) }, `Call the DSL · ${dslPhone}`),
  );
}

export function absenceScreen(ctx: AbsenceContext): HTMLElement {
  const now = new Date();

  const reportedFields = h(
    'div',
    { hidden: true },
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'reported_by' }, 'Who told you?'),
      h('p', { class: 'hint', id: 'reported-hint' }, 'For example: Mum, by text.'),
      h('input', {
        id: 'reported_by',
        name: 'reported_by',
        type: 'text',
        maxlength: 200,
        autocomplete: 'off',
        'aria-describedby': 'reported-hint',
      }),
    ),
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'reported_at' }, 'When did they tell you?'),
      h('input', {
        id: 'reported_at',
        name: 'reported_at',
        type: 'datetime-local',
        value: localDateTime(now),
        max: localDateTime(now),
      }),
    ),
  );
  const warning = h('div', { hidden: true }, noShowWarning(ctx.dslPhone));
  const errors = h('div', { class: 'errors', role: 'alert', 'aria-live': 'assertive' });

  const form = h(
    'form',
    { class: 'record', novalidate: true },
    h('header', { class: 'record-head' }, h('h2', {}, `Didn't attend: ${ctx.pupilName}`)),
    h(
      'fieldset',
      {
        class: 'choices choices-2',
        onchange: (e: Event) => {
          const status = (e.target as HTMLInputElement).value as NonAttendanceStatus;
          reportedFields.hidden = !REPORTED_STATUSES.includes(status);
          warning.hidden = status !== 'no_show';
        },
      },
      h('legend', {}, 'What happened?'),
      NON_ATTENDANCE_STATUSES.map((s) =>
        h(
          'label',
          { class: `choice${s === 'no_show' ? ' choice-wide' : ''}` },
          h('input', { type: 'radio', name: 'status', value: s }),
          h('span', {}, NON_ATTENDANCE_LABELS[s]),
        ),
      ),
    ),
    warning,
    reportedFields,
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'session_date' }, 'Date of the session'),
      h('input', { id: 'session_date', name: 'session_date', type: 'date', value: localDate(now.toISOString()) }),
    ),
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'note' }, 'Anything else? (optional)'),
      h('textarea', { id: 'note', name: 'note', rows: 2, maxlength: 4000 }),
    ),
    errors,
    h('button', { class: 'btn btn-primary btn-submit', type: 'submit' }, 'Save'),
    h('button', { class: 'btn btn-quiet', type: 'button', onclick: ctx.cancel }, 'Back'),
  );

  let submitting = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submitting) return;
    const f = new FormData(form);
    const str = (k: string) => {
      const v = f.get(k);
      return typeof v === 'string' ? v.trim() : '';
    };
    const status = str('status') as NonAttendanceStatus | '';
    const reported = status !== '' && REPORTED_STATUSES.includes(status);
    const reportedAt = reported && str('reported_at') ? new Date(str('reported_at')) : undefined;

    const problems: string[] = [];
    if (!status) problems.push('Choose what happened.');
    if (reported && !str('reported_by')) problems.push('Say who told you.');
    if (reportedAt && reportedAt.getTime() > Date.now() + 10 * 60 * 1000) {
      problems.push('"When did they tell you" is in the future.');
    }
    if (!str('session_date')) problems.push('Choose the date of the session.');
    errors.replaceChildren(...problems.map((p) => h('p', {}, p)));
    if (problems.length || !status) return;

    submitting = true;
    const button = form.querySelector<HTMLButtonElement>('.btn-submit');
    if (button) {
      button.disabled = true;
      button.textContent = 'Sending…';
    }
    const delivery = await ctx.submit({
      attendance_status: status,
      session_date: str('session_date'),
      ...(reported ? { reported_by: str('reported_by') } : {}),
      ...(reportedAt ? { reported_at: reportedAt.toISOString() } : {}),
      ...(str('note') ? { note: str('note') } : {}),
    });
    form.replaceWith(resultPanel(delivery, status, ctx));
    window.scrollTo(0, 0);
  });

  return h(
    'main',
    { class: 'screen' },
    ctx.fromOpenSession &&
      h('p', { class: 'note' }, 'This replaces the session you started, so it won’t need a lesson record.'),
    form,
  );
}

function resultPanel(delivery: Delivery, status: NonAttendanceStatus, ctx: AbsenceContext): HTMLElement {
  const back = h('button', { class: 'btn btn-primary', type: 'button', onclick: ctx.done }, 'Back to today');
  const panel =
    delivery === 'sent'
      ? h(
          'section',
          { class: 'result result-ok', role: 'status' },
          h('p', { class: 'result-mark', 'aria-hidden': 'true' }, '✓'),
          h('h2', {}, 'Sent'),
          h('p', {}, `Recorded: ${NON_ATTENDANCE_LABELS[status]}.`),
        )
      : delivery === 'rejected'
        ? h(
            'section',
            { class: 'result result-bad', role: 'alert' },
            h('h2', {}, 'Not accepted'),
            h('p', {}, 'The server would not accept this. It is saved on this phone. Please tell the office.'),
          )
        : h(
            'section',
            { class: 'result result-warn', role: 'alert' },
            h('h2', {}, 'Saved on this phone. NOT sent yet.'),
            h('p', {}, 'It will send by itself when you have signal.'),
          );
  // A no-show always ends on the "phone the DSL" instruction, sent or not.
  return h('div', {}, panel, status === 'no_show' && noShowWarning(ctx.dslPhone), back);
}

import {
  ENGAGEMENT_LABELS,
  VENUE_LABELS,
  type AttendedStatus,
  type LessonRecordBody,
} from '../../shared/types';
import type { Delivery } from '../queue';
import { clockTime, localDate, type LocalSession } from '../sessions';
import { h } from '../ui';

export interface RecordContext {
  session: LocalSession;
  saveDraft: (draft: Partial<LessonRecordBody>) => void;
  submit: (body: LessonRecordBody) => Promise<Delivery>;
  rejection: string | undefined;
  done: () => void;
}

const ATTENDANCE_LABELS: Record<AttendedStatus, string> = {
  present: 'On time',
  late: 'Arrived late',
  left_early: 'Left early',
};

function timeValue(iso: string | null): string {
  return iso ? clockTime(iso) : '';
}

// Turn an edited HH:MM back into a timestamp on the session's own day.
// If the time wasn't changed, keep the original to the second.
function fromTime(original: string | null, hhmm: string, day: string): string | undefined {
  if (!hhmm) return original ?? undefined;
  if (original && clockTime(original) === hhmm) return original;
  return new Date(`${day}T${hhmm}`).toISOString();
}

export function recordScreen(ctx: RecordContext): HTMLElement {
  const s = ctx.session;
  const d = s.draft;
  const day = localDate(s.started_at);

  const textarea = (name: keyof LessonRecordBody, rows = 3) =>
    h('textarea', { id: name, name, rows, maxlength: 4000, value: String(d[name] ?? '') });

  const radio = (name: string, value: string, label: string, checked: boolean) =>
    h(
      'label',
      { class: 'choice' },
      h('input', { type: 'radio', name, value, checked }),
      h('span', {}, label),
    );

  const substitution = h(
    'div',
    { class: 'field', hidden: d.planned_lesson !== false },
    h('label', { for: 'substitution_reason' }, 'Why not, and what did you do instead?'),
    textarea('substitution_reason'),
  );

  const errors = h('div', { class: 'errors', role: 'alert', 'aria-live': 'assertive' });

  // A required field with a one-tap "None", so "nothing to report" doesn't need typing.
  const withNone = (name: 'problems' | 'issues', label: string, extra?: HTMLElement) => {
    const area = textarea(name, 2);
    return h(
      'div',
      { class: 'field' },
      h(
        'div',
        { class: 'label-row' },
        h('label', { for: name }, label),
        h(
          'button',
          {
            class: 'btn btn-none',
            type: 'button',
            onclick: () => {
              area.value = 'None';
              area.dispatchEvent(new Event('input', { bubbles: true }));
            },
          },
          'None',
        ),
      ),
      area,
      extra,
    );
  };

  // Times are captured by the Start and End taps. This is only for fixing a late tap,
  // so it stays hidden unless asked for (or a correction is already in the draft).
  const timesCorrected =
    (!!d.started_at && d.started_at !== s.started_at) || (!!d.ended_at && d.ended_at !== s.ended_at);
  const times = h(
    'fieldset',
    { class: 'times', hidden: !timesCorrected },
    h('legend', {}, 'Correct the session times'),
    h(
      'label',
      {},
      'Start ',
      h('input', { type: 'time', name: 'start_time', value: timeValue(d.started_at ?? s.started_at) }),
    ),
    h(
      'label',
      {},
      'End ',
      h('input', { type: 'time', name: 'end_time', value: timeValue(d.ended_at ?? s.ended_at) }),
    ),
    h('p', { class: 'hint times-hint' }, 'Only if you tapped Start or End late. Changes are logged.'),
  );

  const form = h(
    'form',
    { class: 'record', novalidate: true },
    h(
      'header',
      { class: 'record-head' },
      h('h2', {}, `Lesson record: ${s.pupil_name}`),
      h(
        'p',
        { class: 'meta' },
        `${clockTime(s.started_at)}–${clockTime(s.ended_at)} · ${VENUE_LABELS[s.venue]} `,
        h(
          'button',
          {
            class: 'link-button',
            type: 'button',
            'aria-expanded': String(timesCorrected),
            onclick: (e: Event) => {
              times.hidden = !times.hidden;
              (e.currentTarget as HTMLElement).setAttribute('aria-expanded', String(!times.hidden));
            },
          },
          'Times wrong?',
        ),
      ),
    ),
    times,

    ctx.rejection &&
      h(
        'div',
        { class: 'banner banner-bad' },
        h('strong', {}, 'The server did not accept this record. '),
        `It is still saved on this phone. Please tell the office. (${ctx.rejection})`,
      ),

    h(
      'div',
      { class: 'field' },
      h('label', { for: 'lesson_summary' }, 'Lesson summary'),
      h('p', { class: 'hint', id: 'summary-hint' }, 'A brief description of what you did.'),
      h('textarea', {
        id: 'lesson_summary',
        name: 'lesson_summary',
        rows: 4,
        maxlength: 4000,
        required: true,
        'aria-describedby': 'summary-hint',
        value: d.lesson_summary ?? '',
      }),
    ),

    h(
      'fieldset',
      { class: 'choices choices-3', id: 'engagement' },
      h('legend', {}, 'Engagement'),
      ([1, 2, 3] as const).map((n) =>
        h(
          'label',
          { class: `choice choice-eng eng-${n}` },
          h('input', { type: 'radio', name: 'engagement', value: n, checked: d.engagement === n }),
          h('span', {}, h('b', {}, String(n)), ` ${ENGAGEMENT_LABELS[n]}`),
        ),
      ),
    ),

    h(
      'fieldset',
      {
        class: 'choices choices-2',
        onchange: (e: Event) => {
          const v = (e.target as HTMLInputElement).value;
          substitution.hidden = v !== 'no';
        },
      },
      h('legend', {}, 'Was this the planned lesson?'),
      radio('planned_lesson', 'yes', 'Yes', d.planned_lesson !== false),
      radio('planned_lesson', 'no', 'No', d.planned_lesson === false),
    ),
    substitution,

    h(
      'div',
      { class: 'field' },
      h('label', { for: 'next_lesson' }, 'Next lesson: does it follow on from this one?'),
      textarea('next_lesson', 2),
    ),
    withNone('problems', 'Any problems'),
    withNone(
      'issues',
      'Anything the office needs to deal with, e.g. parent contact',
      h(
        'label',
        { class: 'check' },
        h('input', { type: 'checkbox', name: 'needs_followup', checked: !!d.needs_followup }),
        ' The office needs to follow this up',
      ),
    ),
    h(
      'fieldset',
      { class: 'choices choices-3' },
      h('legend', {}, 'Attendance'),
      (Object.keys(ATTENDANCE_LABELS) as AttendedStatus[]).map((k) =>
        radio('attendance_status', k, ATTENDANCE_LABELS[k], (d.attendance_status ?? 'present') === k),
      ),
    ),

    errors,
    h('button', { class: 'btn btn-primary btn-submit', type: 'submit' }, 'Submit record'),
  );

  const read = (): Partial<LessonRecordBody> => {
    const f = new FormData(form);
    const str = (k: string) => {
      const v = f.get(k);
      return typeof v === 'string' ? v : '';
    };
    const eng = Number(str('engagement'));
    return {
      lesson_summary: str('lesson_summary'),
      engagement: eng === 1 || eng === 2 || eng === 3 ? eng : undefined,
      planned_lesson: str('planned_lesson') !== 'no',
      substitution_reason: str('substitution_reason'),
      next_lesson: str('next_lesson'),
      problems: str('problems'),
      issues: str('issues'),
      needs_followup: f.get('needs_followup') !== null,
      attendance_status: (str('attendance_status') || 'present') as AttendedStatus,
      started_at: fromTime(s.started_at, str('start_time'), day),
      ended_at: fromTime(s.ended_at, str('end_time'), day),
    };
  };

  let draftTimer: ReturnType<typeof setTimeout> | undefined;
  let submitting = false;
  form.addEventListener('input', () => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      if (!submitting) ctx.saveDraft(read());
    }, 300);
  });
  form.addEventListener('change', () => {
    if (!submitting) ctx.saveDraft(read());
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submitting) return;
    clearTimeout(draftTimer);
    const v = read();
    const problems: string[] = [];
    if (!v.lesson_summary?.trim()) problems.push('Add a short lesson summary.');
    if (!v.engagement) problems.push('Choose an engagement score: 1, 2 or 3.');
    if (!v.next_lesson?.trim()) problems.push('Say whether the next lesson follows on.');
    if (!v.problems?.trim()) problems.push('Fill in "Any problems" (tap None if there were none).');
    if (!v.issues?.trim()) problems.push('Fill in "Anything the office needs to deal with" (tap None if nothing).');
    const start = v.started_at ? Date.parse(v.started_at) : NaN;
    const end = v.ended_at ? Date.parse(v.ended_at) : Date.now();
    if (end < start) problems.push('The end time is before the start time.');
    if (end > Date.now() + 10 * 60 * 1000) problems.push('The end time is in the future.');

    errors.replaceChildren(...problems.map((p) => h('p', {}, p)));
    if (problems.length) {
      errors.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    submitting = true;

    const button = form.querySelector<HTMLButtonElement>('.btn-submit');
    if (button) {
      button.disabled = true;
      button.textContent = 'Sending…';
    }
    const body: LessonRecordBody = {
      lesson_summary: v.lesson_summary!.trim(),
      engagement: v.engagement!,
      planned_lesson: v.planned_lesson ?? true,
      attendance_status: v.attendance_status,
      needs_followup: v.needs_followup,
      started_at: v.started_at,
      ended_at: v.ended_at ?? new Date().toISOString(),
      ...(v.planned_lesson === false && v.substitution_reason
        ? { substitution_reason: v.substitution_reason }
        : {}),
      next_lesson: v.next_lesson!.trim(),
      problems: v.problems!.trim(),
      issues: v.issues!.trim(),
    };
    const delivery = await ctx.submit(body);
    form.replaceWith(resultPanel(delivery, ctx));
    window.scrollTo(0, 0);
  });

  return h('main', { class: 'screen' }, form);
}

function resultPanel(delivery: Delivery, ctx: RecordContext): HTMLElement {
  const back = h('button', { class: 'btn btn-primary', type: 'button', onclick: ctx.done }, 'Back to today');
  if (delivery === 'sent') {
    return h(
      'section',
      { class: 'result result-ok', role: 'status' },
      h('p', { class: 'result-mark', 'aria-hidden': 'true' }, '✓'),
      h('h2', {}, 'Sent'),
      h('p', {}, 'The office has the record.'),
      back,
    );
  }
  if (delivery === 'rejected') {
    return h(
      'section',
      { class: 'result result-bad', role: 'alert' },
      h('h2', {}, 'Not accepted'),
      h('p', {}, 'The server would not accept this record. It is saved on this phone. Please tell the office.'),
      back,
    );
  }
  return h(
    'section',
    { class: 'result result-warn', role: 'alert' },
    h('h2', {}, 'Saved on this phone. NOT sent yet.'),
    h('p', {}, 'It will send by itself when you have signal. You can close the app.'),
    back,
  );
}

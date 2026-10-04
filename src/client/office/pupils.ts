import {
  DOCUMENT_CATEGORIES,
  DOCUMENT_CATEGORY_LABELS,
  ENGAGEMENT_LABELS,
  FUNDING_ROUTE_LABELS,
  FUNDING_ROUTES,
  KEY_INFO_FIELDS,
  KEY_INFO_LABELS,
  NON_ATTENDANCE_LABELS,
  VENUE_LABELS,
  type Venue,
} from '../../shared/types';
import { h, type Child } from '../ui';
import { api, ApiError, type Row } from './api';
import { changed, notice, readGroups, renderGroups, ukDate, ukDateTime, type FieldGroup } from './forms';

const pct = (attended: unknown, offered: unknown) =>
  Number(offered) > 0 ? `${Math.round((Number(attended) / Number(offered)) * 100)}%` : '—';

export const PUPIL_GROUPS: FieldGroup[] = [
  {
    title: 'The pupil',
    fields: [
      { key: 'first_name', label: 'First name', type: 'text', required: true },
      { key: 'last_name', label: 'Last name', type: 'text', required: true },
      { key: 'preferred_name', label: 'Preferred name', type: 'text', hint: 'Shown to the tutor' },
      { key: 'pronouns', label: 'Pronouns', type: 'text' },
      { key: 'date_of_birth', label: 'Date of birth', type: 'date' },
      { key: 'year_group', label: 'Year group / key stage', type: 'text' },
      {
        key: 'status',
        label: 'Status',
        type: 'select',
        required: true,
        options: [
          ['active', 'Active'],
          ['paused', 'Paused'],
          ['exited', 'Exited'],
        ],
      },
      { key: 'start_date', label: 'Start date', type: 'date' },
      { key: 'end_date', label: 'End date', type: 'date' },
    ],
  },
  {
    title: 'Commissioning',
    fields: [
      {
        key: 'commissioner',
        label: 'Commissioner',
        type: 'select',
        required: true,
        options: [
          ['kcc', 'KCC (Route A)'],
          ['school', 'School (Route B)'],
          ['other', 'Other'],
        ],
      },
      {
        key: 'funding_route',
        label: 'Funding route',
        type: 'select',
        options: FUNDING_ROUTES.map((r) => [r, FUNDING_ROUTE_LABELS[r]] as const),
      },
      { key: 'commissioner_ref', label: 'Commissioner reference', type: 'text' },
      { key: 'kcc_urn', label: 'KCC URN', type: 'text' },
      { key: 'po_number', label: 'Purchase order number', type: 'text' },
      { key: 'caseworker_name', label: 'Caseworker', type: 'text' },
      { key: 'caseworker_email', label: 'Caseworker email', type: 'email' },
      { key: 'caseworker_phone', label: 'Caseworker phone', type: 'text' },
      { key: 'school_name', label: 'School', type: 'text' },
      { key: 'senco_name', label: 'SENCo', type: 'text' },
      { key: 'senco_contact', label: 'SENCo contact', type: 'text' },
      { key: 'hours_per_week', label: 'Agreed hours per week', type: 'number' },
      { key: 'delivery_mode', label: 'Delivery mode', type: 'text', hint: 'e.g. home, community venue, online' },
    ],
  },
  {
    title: 'Flags',
    fields: [
      { key: 'ehcp', label: 'Has an EHCP', type: 'checkbox' },
      { key: 'ehcp_reference', label: 'EHCP reference', type: 'text' },
      { key: 'looked_after', label: 'Looked-after child (a first-aider must be at every session)', type: 'checkbox' },
      { key: 'vsk_lot3', label: 'Virtual School Kent (Lot 3)', type: 'checkbox' },
    ],
  },
  {
    title: 'Plan and notes',
    fields: [
      { key: 'primary_presentation', label: 'Primary SEMH presentation', type: 'textarea' },
      { key: 'office_notes', label: 'Office notes (not shown to tutors)', type: 'textarea' },
    ],
  },
];

const KEY_INFO_GROUPS: FieldGroup[] = [
  {
    title: 'Key information for the tutor',
    fields: KEY_INFO_FIELDS.map((k) => ({ key: k, label: KEY_INFO_LABELS[k], type: 'textarea' as const })),
  },
];

function statusBadge(status: unknown) {
  return h('span', { class: `badge badge-${String(status)}` }, String(status));
}

// ---------- list ----------

export async function pupilListScreen(): Promise<HTMLElement> {
  const pupils = await api.get<Row[]>('/api/office/pupils');
  return h(
    'section',
    {},
    h(
      'header',
      { class: 'page-head' },
      h('h1', {}, 'Pupils'),
      h('a', { class: 'btn btn-primary', href: '#/pupils/new' }, 'Add a pupil'),
    ),
    pupils.length === 0
      ? h('p', { class: 'muted' }, 'No pupils yet.')
      : h(
          'table',
          { class: 'table' },
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              ['Ref', 'Name', 'Status', 'Commissioner', 'Flags', 'Tutors', 'Hours/wk', 'Attendance', 'Last session', 'Key info'].map(
                (t) => h('th', {}, t),
              ),
            ),
          ),
          h(
            'tbody',
            {},
            pupils.map((p) =>
              h(
                'tr',
                {},
                h('td', {}, h('a', { href: `#/pupils/${p.id}` }, String(p.reference))),
                h('td', {}, h('a', { href: `#/pupils/${p.id}` }, `${p.first_name} ${p.last_name}`)),
                h('td', {}, statusBadge(p.status)),
                h('td', {}, String(p.commissioner).toUpperCase()),
                h(
                  'td',
                  {},
                  p.ehcp === 1 && h('span', { class: 'flag' }, 'EHCP'),
                  p.looked_after === 1 && h('span', { class: 'flag flag-lac' }, 'LAC'),
                ),
                h('td', {}, p.tutors ? String(p.tutors) : h('span', { class: 'muted' }, 'none')),
                h('td', {}, p.hours_per_week == null ? '—' : String(p.hours_per_week)),
                h('td', {}, pct(p.attended, p.offered)),
                h('td', {}, ukDate(p.last_session_date)),
                h('td', {}, p.key_info_version ? `v${p.key_info_version}` : h('span', { class: 'warn-text' }, 'missing')),
              ),
            ),
          ),
        ),
  );
}

// ---------- new pupil ----------

export function newPupilScreen(): HTMLElement {
  const msg = h('div');
  const form = h(
    'form',
    { class: 'form', novalidate: true },
    renderGroups(PUPIL_GROUPS, { status: 'active', commissioner: 'kcc' }),
    msg,
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Create pupil')),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const values = readGroups(form, PUPIL_GROUPS);
    const body = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null && v !== false));
    try {
      const created = await api.post<Row>('/api/office/pupils', body);
      location.hash = `#/pupils/${created.id}`;
    } catch (err) {
      msg.replaceChildren(notice('bad', (err as Error).message));
    }
  });
  return h(
    'section',
    {},
    h('header', { class: 'page-head' }, h('h1', {}, 'Add a pupil')),
    h(
      'p',
      { class: 'muted' },
      'A reference (STS-0001 …) is assigned automatically. Fabricated data only until the DPIA is signed.',
    ),
    form,
  );
}

// ---------- detail ----------

interface Detail {
  pupil: Row;
  key_info: Row | null;
  tutors: Row[];
  targets: Row[];
  documents: Row[];
  sessions: Row[];
  attendance: Row;
}

export async function pupilScreen(id: number, refresh: () => void): Promise<HTMLElement> {
  const [d, users] = await Promise.all([
    api.get<Detail>(`/api/office/pupils/${id}`),
    api.get<Row[]>('/api/office/users'),
  ]);
  const p = d.pupil;

  return h(
    'section',
    {},
    h(
      'header',
      { class: 'page-head' },
      h('h1', {}, `${p.first_name} ${p.last_name} `, h('span', { class: 'muted ref' }, String(p.reference))),
      statusBadge(p.status),
    ),
    h(
      'p',
      { class: 'summary' },
      p.ehcp === 1 && h('span', { class: 'flag' }, 'EHCP'),
      p.looked_after === 1 && h('span', { class: 'flag flag-lac' }, 'Looked-after: first-aider at every session'),
      `Attendance ${pct(d.attendance.attended, d.attendance.offered)} (${Number(d.attendance.attended ?? 0)} of ${Number(
        d.attendance.offered ?? 0,
      )} offered sessions) · KCC target 85%`,
    ),
    tutorsCard(id, d, users, refresh),
    keyInfoCard(id, d, refresh),
    targetsCard(id, d, refresh),
    detailsCard(id, p, refresh),
    documentsCard(id, d, refresh),
    historyCard(d),
  );
}

function card(title: string, ...children: Child[]) {
  return h('section', { class: 'card' }, h('h2', {}, title), ...children);
}

function tutorsCard(id: number, d: Detail, users: Row[], refresh: () => void) {
  const msg = h('div');
  const assigned = d.tutors.filter((t) => t.active === 1);
  const assignable = users.filter((u) => u.active === 1 && !assigned.some((t) => t.id === u.id));
  const select = h(
    'select',
    { 'aria-label': 'Tutor to assign' },
    h('option', { value: '' }, 'Choose a tutor…'),
    assignable.map((u) => h('option', { value: String(u.id) }, `${u.display_name} (${u.role})`)),
  );
  return card(
    'Tutors',
    assigned.length === 0
      ? h('p', { class: 'muted' }, 'No tutor assigned. The pupil does not appear on anyone’s phone.')
      : h(
          'ul',
          { class: 'plain' },
          assigned.map((t) =>
            h(
              'li',
              {},
              h('strong', {}, String(t.display_name)),
              ` ${t.email} · key info: `,
              !d.key_info
                ? h('span', { class: 'muted' }, 'none entered')
                : t.key_info_confirmed_at
                  ? h('span', { class: 'ok-text' }, `read v${d.key_info.version} on ${ukDate(t.key_info_confirmed_at)}`)
                  : h('span', { class: 'warn-text' }, `not yet read (v${d.key_info.version})`),
              ' ',
              h(
                'button',
                {
                  class: 'btn btn-small btn-quiet',
                  type: 'button',
                  onclick: async () => {
                    if (!confirm(`Unassign ${t.display_name}? The pupil will disappear from their phone.`)) return;
                    try {
                      await api.del(`/api/office/pupils/${id}/tutors/${t.id}`);
                      refresh();
                    } catch (err) {
                      msg.replaceChildren(notice('bad', (err as Error).message));
                    }
                  },
                },
                'Unassign',
              ),
            ),
          ),
        ),
    h(
      'div',
      { class: 'inline' },
      select,
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          onclick: async () => {
            if (!select.value) return;
            try {
              await api.put(`/api/office/pupils/${id}/tutors/${select.value}`);
              refresh();
            } catch (err) {
              msg.replaceChildren(notice('bad', (err as Error).message));
            }
          },
        },
        'Assign',
      ),
    ),
    msg,
  );
}

function keyInfoCard(id: number, d: Detail, refresh: () => void) {
  const msg = h('div');
  const form = h(
    'form',
    { class: 'form', novalidate: true },
    renderGroups(KEY_INFO_GROUPS, d.key_info ?? {}),
    msg,
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save key information')),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const saved = await api.put<Row>(`/api/office/pupils/${id}/key-info`, readGroups(form, KEY_INFO_GROUPS));
      if (d.key_info && saved.version === d.key_info.version) {
        msg.replaceChildren(notice('ok', 'No changes, so no new version.'));
      } else {
        refresh();
      }
    } catch (err) {
      msg.replaceChildren(notice('bad', (err as Error).message));
    }
  });
  return card(
    'Key information',
    h(
      'p',
      { class: 'muted' },
      d.key_info
        ? `Version ${d.key_info.version}, saved ${ukDateTime(d.key_info.created_at)}. Saving a change creates a new version, and assigned tutors are asked to read it again.`
        : 'None yet. The tutor sees this on their phone and confirms they have read it, which is the evidence KCC asks for before a placement starts.',
    ),
    form,
  );
}

function targetsCard(id: number, d: Detail, refresh: () => void) {
  const msg = h('div');
  const form = h(
    'form',
    { class: 'inline-form', novalidate: true },
    h('input', { name: 'ehcp_outcome', placeholder: 'EHCP outcome', 'aria-label': 'EHCP outcome' }),
    h('input', { name: 'target', placeholder: 'Target *', required: true, 'aria-label': 'Target' }),
    h('input', { name: 'measure', placeholder: 'How it is measured', 'aria-label': 'Measure' }),
    h('input', { name: 'review_date', type: 'date', 'aria-label': 'Review date' }),
    h('button', { class: 'btn', type: 'submit' }, 'Add target'),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const val = (k: string) => (String(f.get(k) ?? '').trim() || null);
    if (!val('target')) {
      msg.replaceChildren(notice('bad', 'A target needs some text.'));
      return;
    }
    try {
      await api.post(`/api/office/pupils/${id}/targets`, {
        ehcp_outcome: val('ehcp_outcome'),
        target: val('target'),
        measure: val('measure'),
        review_date: val('review_date'),
      });
      refresh();
    } catch (err) {
      msg.replaceChildren(notice('bad', (err as Error).message));
    }
  });
  return card(
    'Targets',
    d.targets.length === 0
      ? h('p', { class: 'muted' }, 'No targets yet. Active targets show on the tutor’s phone.')
      : h(
          'table',
          { class: 'table' },
          h('thead', {}, h('tr', {}, ['EHCP outcome', 'Target', 'Measure', 'Review', 'Status'].map((t) => h('th', {}, t)))),
          h(
            'tbody',
            {},
            d.targets.map((t) => {
              const sel = h(
                'select',
                {
                  'aria-label': 'Target status',
                  onchange: async (e: Event) => {
                    try {
                      await api.patch(`/api/office/targets/${t.id}`, { status: (e.target as HTMLSelectElement).value });
                      refresh();
                    } catch (err) {
                      msg.replaceChildren(notice('bad', (err as Error).message));
                    }
                  },
                },
                (['active', 'met', 'dropped'] as const).map((s) => h('option', { value: s, selected: t.status === s }, s)),
              );
              return h(
                'tr',
                {},
                h('td', {}, String(t.ehcp_outcome ?? '—')),
                h('td', {}, String(t.target)),
                h('td', {}, String(t.measure ?? '—')),
                h('td', {}, ukDate(t.review_date)),
                h('td', {}, sel),
              );
            }),
          ),
        ),
    form,
    msg,
  );
}

function detailsCard(id: number, p: Row, refresh: () => void) {
  const msg = h('div');
  const form = h(
    'form',
    { class: 'form', novalidate: true },
    renderGroups(PUPIL_GROUPS, p),
    msg,
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save details')),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const diff = changed(readGroups(form, PUPIL_GROUPS), p);
    if (Object.keys(diff).length === 0) {
      msg.replaceChildren(notice('ok', 'Nothing has changed.'));
      return;
    }
    try {
      await api.patch(`/api/office/pupils/${id}`, diff);
      refresh();
    } catch (err) {
      msg.replaceChildren(notice('bad', (err as Error).message));
    }
  });
  return h(
    'details',
    { class: 'card' },
    h('summary', {}, h('h2', {}, 'Details')),
    form,
  );
}

function documentsCard(id: number, d: Detail, refresh: () => void) {
  const msg = h('div');
  const form = h(
    'form',
    { class: 'inline-form', novalidate: true },
    h(
      'select',
      { name: 'category', 'aria-label': 'Document type', required: true },
      DOCUMENT_CATEGORIES.map((c) => h('option', { value: c }, DOCUMENT_CATEGORY_LABELS[c])),
    ),
    h('input', { name: 'title', placeholder: 'Title (optional)', 'aria-label': 'Title' }),
    h('input', {
      name: 'file',
      type: 'file',
      required: true,
      accept: '.pdf,.docx,.jpg,.jpeg,.png',
      'aria-label': 'File',
    }),
    h('button', { class: 'btn', type: 'submit' }, 'Upload'),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const file = data.get('file');
    if (!(file instanceof File) || file.size === 0) {
      msg.replaceChildren(notice('bad', 'Choose a file first.'));
      return;
    }
    // Fields before the file, so the server reads the category before the upload body.
    const ordered = new FormData();
    ordered.append('category', String(data.get('category')));
    ordered.append('title', String(data.get('title') ?? ''));
    ordered.append('file', file);
    msg.replaceChildren(notice('warn', 'Uploading…'));
    try {
      await api.post(`/api/office/pupils/${id}/documents`, ordered);
      refresh();
    } catch (err) {
      msg.replaceChildren(notice('bad', (err as Error).message));
    }
  });
  return card(
    'Documents',
    h('p', { class: 'muted' }, 'PDF, Word (.docx), JPEG or PNG, up to 20 MB. Stored on Swale’s server; never emailed. Office only.'),
    d.documents.length > 0 &&
      h(
        'table',
        { class: 'table' },
        h('thead', {}, h('tr', {}, ['Type', 'Title', 'Uploaded', 'Size', ''].map((t) => h('th', {}, t)))),
        h(
          'tbody',
          {},
          d.documents.map((doc) =>
            h(
              'tr',
              {},
              h('td', {}, DOCUMENT_CATEGORY_LABELS[doc.category as keyof typeof DOCUMENT_CATEGORY_LABELS] ?? String(doc.category)),
              h('td', {}, h('a', { href: `/api/office/documents/${doc.id}` }, String(doc.title))),
              h('td', {}, `${ukDate(doc.uploaded_at)} by ${doc.uploaded_by_name}`),
              h('td', {}, `${Math.max(1, Math.round(Number(doc.size_bytes) / 1024))} KB`),
              h(
                'td',
                {},
                h(
                  'button',
                  {
                    class: 'btn btn-small btn-quiet',
                    type: 'button',
                    onclick: async () => {
                      if (!confirm(`Dispose of "${doc.title}"? The file is deleted; a record of the disposal is kept.`)) return;
                      try {
                        await api.del(`/api/office/documents/${doc.id}`);
                        refresh();
                      } catch (err) {
                        msg.replaceChildren(notice('bad', (err as Error).message));
                      }
                    },
                  },
                  'Dispose',
                ),
              ),
            ),
          ),
        ),
      ),
    form,
    msg,
  );
}

function historyCard(d: Detail) {
  return card(
    'Session history',
    d.sessions.length === 0
      ? h('p', { class: 'muted' }, 'No sessions recorded yet.')
      : h(
          'table',
          { class: 'table' },
          h('thead', {}, h('tr', {}, ['Date', 'Tutor', 'Attendance', 'Times / venue', 'Engagement', 'Summary'].map((t) => h('th', {}, t)))),
          h(
            'tbody',
            {},
            d.sessions.map((s) => {
              const absent = (NON_ATTENDANCE_LABELS as Record<string, string>)[String(s.attendance_status)];
              const time = (iso: unknown) =>
                iso ? new Date(String(iso)).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '–';
              return h(
                'tr',
                {},
                h('td', {}, ukDate(s.session_date)),
                h('td', {}, String(s.tutor_name)),
                h(
                  'td',
                  {},
                  absent
                    ? h('span', { class: s.attendance_status === 'no_show' ? 'bad-text' : 'warn-text' }, absent)
                    : String(s.attendance_status).replace('_', ' '),
                  s.reported_by ? ` (told by ${s.reported_by})` : '',
                ),
                h(
                  'td',
                  {},
                  absent
                    ? '—'
                    : `${time(s.started_at)}–${time(s.ended_at)}${s.venue ? ` · ${VENUE_LABELS[s.venue as Venue]}` : ''}`,
                ),
                h('td', {}, s.engagement ? `${s.engagement} ${ENGAGEMENT_LABELS[s.engagement as 1 | 2 | 3]}` : '—'),
                h(
                  'td',
                  { class: 'summary-cell' },
                  s.lesson_summary
                    ? String(s.lesson_summary)
                    : s.non_attendance_note
                      ? String(s.non_attendance_note)
                      : !s.submitted_at
                        ? h('span', { class: 'muted' }, 'record not yet submitted')
                        : '',
                  s.needs_followup === 1 && h('span', { class: 'flag' }, 'office follow-up'),
                ),
              );
            }),
          ),
        ),
  );
}

export function isNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}


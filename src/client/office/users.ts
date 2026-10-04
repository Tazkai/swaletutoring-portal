import { ROLES } from '../../shared/types';
import { h } from '../ui';
import { api, type Row } from './api';
import { notice, ukDate, ukDateTime } from './forms';

const ROLE_LABELS: Record<string, string> = {
  tutor: 'Tutor',
  dsl: 'DSL',
  deputy: 'Deputy DSL',
  admin: 'Admin',
};

// Cloudflare Access is updated by hand for now (Back_Office_Scope.md Q7), so every add or
// removal ends with a clear instruction rather than being left to memory.
function accessReminder(action: 'add' | 'remove', email: string, role: string): HTMLElement {
  const office = role !== 'tutor';
  return notice(
    'warn',
    h('strong', {}, 'One more step: '),
    action === 'add'
      ? `add ${email} to the Cloudflare Access policy "Swale portal – allowed people"${
          office ? ' and to the office application’s policy' : ''
        }. Until then they cannot sign in.`
      : `remove ${email} from the Cloudflare Access policies. They can no longer use the portal, but removing them from Cloudflare stops them reaching the sign-in screen at all.`,
  );
}

export async function usersScreen(refresh: (message?: HTMLElement) => void, flash?: HTMLElement): Promise<HTMLElement> {
  const users = await api.get<Row[]>('/api/office/users');
  const msg = h('div');
  if (flash) msg.append(flash);

  const form = h(
    'form',
    { class: 'inline-form', novalidate: true },
    h('input', { name: 'display_name', placeholder: 'Name *', required: true, 'aria-label': 'Name' }),
    h('input', { name: 'email', type: 'email', placeholder: 'Email *', required: true, 'aria-label': 'Email' }),
    h('select', { name: 'role', 'aria-label': 'Role' }, ROLES.map((r) => h('option', { value: r }, ROLE_LABELS[r] ?? r))),
    h('input', { name: 'phone', placeholder: 'Phone', 'aria-label': 'Phone' }),
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'Add person'),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const val = (k: string) => String(f.get(k) ?? '').trim();
    try {
      const created = await api.post<Row>('/api/office/users', {
        display_name: val('display_name'),
        email: val('email'),
        role: val('role'),
        phone: val('phone') || null,
      });
      refresh(accessReminder('add', String(created.email), String(created.role)));
    } catch (err) {
      msg.replaceChildren(notice('bad', (err as Error).message));
    }
  });

  return h(
    'section',
    {},
    h('header', { class: 'page-head' }, h('h1', {}, 'People')),
    msg,
    h(
      'table',
      { class: 'table' },
      h('thead', {}, h('tr', {}, ['Name', 'Email', 'Role', 'Phone', 'Active pupils', 'Added', ''].map((t) => h('th', {}, t)))),
      h(
        'tbody',
        {},
        users.map((u) => {
          const role = h(
            'select',
            {
              'aria-label': `Role for ${u.display_name}`,
              disabled: u.active !== 1,
              onchange: async (e: Event) => {
                try {
                  await api.patch(`/api/office/users/${u.id}`, { role: (e.target as HTMLSelectElement).value });
                  refresh();
                } catch (err) {
                  msg.replaceChildren(notice('bad', (err as Error).message));
                  (e.target as HTMLSelectElement).value = String(u.role);
                }
              },
            },
            ROLES.map((r) => h('option', { value: r, selected: u.role === r }, ROLE_LABELS[r] ?? r)),
          );
          return h(
            'tr',
            { class: u.active === 1 ? '' : 'inactive' },
            h('td', {}, String(u.display_name)),
            h('td', {}, String(u.email)),
            h('td', {}, role),
            h('td', {}, String(u.phone ?? '—')),
            h('td', {}, String(u.active_pupils)),
            h('td', {}, ukDate(u.created_at)),
            h(
              'td',
              {},
              h(
                'button',
                {
                  class: 'btn btn-small btn-quiet',
                  type: 'button',
                  onclick: async () => {
                    const deactivating = u.active === 1;
                    if (
                      deactivating &&
                      !confirm(`Deactivate ${u.display_name}? They lose access straight away and are unassigned from all pupils.`)
                    ) {
                      return;
                    }
                    try {
                      const res = await api.patch<Row>(`/api/office/users/${u.id}`, { active: !deactivating });
                      const r = res.access_policy_reminder as 'add' | 'remove' | undefined;
                      refresh(r ? accessReminder(r, String(u.email), String(u.role)) : undefined);
                    } catch (err) {
                      msg.replaceChildren(notice('bad', (err as Error).message));
                    }
                  },
                },
                u.active === 1 ? 'Deactivate' : 'Reactivate',
              ),
            ),
          );
        }),
      ),
    ),
    h('h2', {}, 'Add a person'),
    h(
      'p',
      { class: 'muted' },
      'Tutors see only the pupils assigned to them. DSL, Deputy DSL and Admin can use the office. Anyone added here also needs adding to Cloudflare Access.',
    ),
    form,
  );
}

export async function auditScreen(): Promise<HTMLElement> {
  const rows = await api.get<Row[]>('/api/office/audit?limit=300');
  return h(
    'section',
    {},
    h('header', { class: 'page-head' }, h('h1', {}, 'Audit log')),
    h('p', { class: 'muted' }, 'Every change made in the portal and the office, newest first (last 300).'),
    h(
      'table',
      { class: 'table' },
      h('thead', {}, h('tr', {}, ['When', 'Who', 'Action', 'Record', 'Detail'].map((t) => h('th', {}, t)))),
      h(
        'tbody',
        {},
        rows.map((r) =>
          h(
            'tr',
            {},
            h('td', {}, ukDateTime(r.created_at)),
            h('td', {}, String(r.actor ?? 'system / command line')),
            h('td', {}, String(r.action)),
            h(
              'td',
              {},
              r.entity === 'pupils' && r.entity_id
                ? h('a', { href: `#/pupils/${r.entity_id}` }, `pupil ${r.entity_id}`)
                : `${r.entity} ${r.entity_id ?? ''}`,
            ),
            h('td', { class: 'detail-cell' }, r.detail ? String(r.detail) : ''),
          ),
        ),
      ),
    ),
  );
}

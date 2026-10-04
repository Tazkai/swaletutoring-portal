import { h } from '../ui';
import type { Row } from './api';

// Forms built from field definitions, so the office forms and the API stay in step.

export type FieldType = 'text' | 'textarea' | 'date' | 'number' | 'email' | 'select' | 'checkbox';

export interface Field {
  key: string;
  label: string;
  type: FieldType;
  options?: readonly (readonly [string, string])[];
  hint?: string;
  required?: boolean;
  wide?: boolean;
}

export interface FieldGroup {
  title: string;
  fields: Field[];
}

const fieldId = (key: string) => `f-${key}`;

function control(f: Field, value: unknown): HTMLElement {
  const common = { id: fieldId(f.key), name: f.key, required: f.required };
  switch (f.type) {
    case 'textarea':
      return h('textarea', { ...common, rows: 3, value: value == null ? '' : String(value) });
    case 'select':
      return h(
        'select',
        common,
        !f.required && h('option', { value: '' }, '—'),
        (f.options ?? []).map(([v, label]) => h('option', { value: v, selected: value === v }, label)),
      );
    case 'checkbox':
      return h('input', { ...common, type: 'checkbox', checked: value === 1 || value === true });
    default:
      return h('input', {
        ...common,
        type: f.type,
        step: f.type === 'number' ? 'any' : undefined,
        value: value == null ? '' : String(value),
      });
  }
}

export function renderGroups(groups: FieldGroup[], values: Row): HTMLElement[] {
  return groups.map((g) =>
    h(
      'fieldset',
      { class: 'group' },
      h('legend', {}, g.title),
      h(
        'div',
        { class: 'grid' },
        g.fields.map((f) =>
          f.type === 'checkbox'
            ? h('label', { class: 'check' }, control(f, values[f.key]), ` ${f.label}`)
            : h(
                'div',
                { class: `field${f.wide || f.type === 'textarea' ? ' wide' : ''}` },
                h('label', { for: fieldId(f.key) }, f.label, f.required && h('span', { class: 'req' }, ' *')),
                f.hint && h('p', { class: 'hint' }, f.hint),
                control(f, values[f.key]),
              ),
        ),
      ),
    ),
  );
}

// Reads the form back into API values: blank → null, numbers parsed, checkboxes → boolean.
export function readGroups(form: HTMLFormElement, groups: FieldGroup[]): Row {
  const out: Row = {};
  for (const f of groups.flatMap((g) => g.fields)) {
    const el = form.elements.namedItem(f.key) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
    if (!el) continue;
    if (f.type === 'checkbox') out[f.key] = (el as HTMLInputElement).checked;
    else if (f.type === 'number') out[f.key] = el.value.trim() === '' ? null : Number(el.value);
    else out[f.key] = el.value.trim() === '' ? null : el.value.trim();
  }
  return out;
}

// Only the fields that changed, compared with the record as loaded.
export function changed(next: Row, original: Row): Row {
  const norm = (v: unknown) => (v === true ? 1 : v === false ? 0 : v ?? null);
  return Object.fromEntries(Object.entries(next).filter(([k, v]) => norm(v) !== norm(original[k])));
}

export function notice(kind: 'ok' | 'bad' | 'warn', ...text: (string | Node)[]): HTMLElement {
  return h('div', { class: `notice notice-${kind}`, role: kind === 'ok' ? 'status' : 'alert' }, ...text);
}

export function ukDate(iso: unknown): string {
  if (!iso) return '—';
  const s = String(iso);
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00` : s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('en-GB');
}

export function ukDateTime(iso: unknown): string {
  if (!iso) return '—';
  const s = String(iso);
  const d = new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime())
    ? s
    : d.toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

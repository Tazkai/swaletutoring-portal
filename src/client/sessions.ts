import type { LessonRecordBody, PupilSummary, SessionView, Venue } from '../shared/types';
import { enqueue } from './queue';
import { get, getAll, put, remove } from './store';

// The phone's own copy of each session. This is what lets a tutor close the app
// mid-session (or lose signal) and come back to exactly where they were.

export type Stage = 'open' | 'ended' | 'submitted';

export interface LocalSession {
  client_uuid: string;
  pupil_id: number;
  pupil_name: string;
  venue: Venue;
  started_at: string;
  ended_at: string | null;
  stage: Stage;
  draft: Partial<LessonRecordBody>;
  submitted_at: string | null;
  confirmed: boolean; // the server has confirmed the final record
}

export async function listSessions(): Promise<LocalSession[]> {
  return (await getAll<LocalSession>('sessions')).sort((a, b) =>
    a.started_at.localeCompare(b.started_at),
  );
}

export async function startSession(pupil: PupilSummary, venue: Venue): Promise<LocalSession> {
  const s: LocalSession = {
    client_uuid: crypto.randomUUID(),
    pupil_id: pupil.id,
    pupil_name: `${pupil.first_name} ${pupil.last_name}`,
    venue,
    started_at: new Date().toISOString(),
    ended_at: null,
    stage: 'open',
    draft: {},
    submitted_at: null,
    confirmed: false,
  };
  await put('sessions', s);
  await enqueue({
    client_uuid: s.client_uuid,
    kind: 'start',
    url: '/api/sessions/start',
    body: { client_uuid: s.client_uuid, pupil_id: s.pupil_id, venue, started_at: s.started_at },
  });
  return s;
}

// Updates always start from the stored copy, never from an object a screen captured
// earlier: a late draft save must not roll a submitted session back to "ended".
async function current(clientUuid: string): Promise<LocalSession | undefined> {
  return get<LocalSession>('sessions', clientUuid);
}

export async function endSession(clientUuid: string): Promise<void> {
  const s = await current(clientUuid);
  if (!s || s.stage !== 'open') return;
  const ended: LocalSession = { ...s, ended_at: new Date().toISOString(), stage: 'ended' };
  await put('sessions', ended);
  await enqueue({
    client_uuid: s.client_uuid,
    kind: 'end',
    url: `/api/sessions/${s.client_uuid}/end`,
    body: { ended_at: ended.ended_at },
  });
}

export async function saveDraft(clientUuid: string, draft: Partial<LessonRecordBody>): Promise<void> {
  const s = await current(clientUuid);
  if (!s || s.stage === 'submitted') return;
  await put('sessions', { ...s, draft });
}

export async function submitRecord(clientUuid: string, body: LessonRecordBody): Promise<void> {
  const s = await current(clientUuid);
  if (!s) throw new Error('session not found on this phone');
  await put('sessions', {
    ...s,
    started_at: body.started_at ?? s.started_at,
    ended_at: body.ended_at ?? s.ended_at,
    draft: body,
    stage: 'submitted',
    submitted_at: new Date().toISOString(),
    confirmed: false,
  } satisfies LocalSession);
  await enqueue({
    client_uuid: s.client_uuid,
    kind: 'record',
    url: `/api/sessions/${s.client_uuid}/record`,
    body,
  });
}

export async function markConfirmed(clientUuid: string): Promise<void> {
  const s = await current(clientUuid);
  if (s?.stage === 'submitted') await put('sessions', { ...s, confirmed: true });
}

// Bring back open sessions the server knows about but this phone doesn't
// (app reinstalled, storage cleared), and tidy away confirmed records from earlier days.
export async function reconcile(serverOpen: SessionView[] | undefined, today: string): Promise<void> {
  const local = await listSessions();
  const known = new Set(local.map((s) => s.client_uuid));

  for (const v of serverOpen ?? []) {
    if (known.has(v.client_uuid) || !v.started_at) continue;
    await put('sessions', {
      client_uuid: v.client_uuid,
      pupil_id: v.pupil_id,
      pupil_name: v.pupil_name,
      venue: v.venue ?? 'home',
      started_at: v.started_at,
      ended_at: v.ended_at,
      stage: v.ended_at ? 'ended' : 'open',
      draft: {},
      submitted_at: null,
      confirmed: false,
    } satisfies LocalSession);
  }

  for (const s of local) {
    if (s.stage === 'submitted' && s.confirmed && localDate(s.started_at) < today) {
      await remove('sessions', s.client_uuid);
    }
  }
}

export function localDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function clockTime(iso: string | null): string {
  if (!iso) return '–';
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

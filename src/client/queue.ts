import { getAll, put, remove } from './store';

// The offline queue. Every change a tutor makes is queued here with the session's
// client_uuid, then sent in order. The server treats a replay as an update, so
// retrying is always safe. Nothing is ever shown as sent until the server says so.

export type QueueKind = 'start' | 'end' | 'record' | 'absence';

export interface QueueItem {
  seq?: number;
  client_uuid: string;
  kind: QueueKind;
  url: string;
  body: unknown;
  created_at: string;
  attempts: number;
  rejected?: string; // the server refused it; kept so it is never silently lost
}

export interface QueueStatus {
  pending: number;
  rejected: number;
  needsSignIn: boolean;
  online: boolean;
}

export type Delivery = 'sent' | 'pending' | 'rejected';

type Outcome = 'sent' | 'rejected' | 'offline' | 'auth';

const RETRY_SECONDS = [5, 15, 30, 60, 120];

let status: QueueStatus = { pending: 0, rejected: 0, needsSignIn: false, online: navigator.onLine };
const listeners = new Set<(s: QueueStatus) => void>();
let flushing: Promise<void> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retryIndex = 0;
let sentHandler: (item: QueueItem, response: unknown) => Promise<void> = async () => {};

export function onQueueStatus(fn: (s: QueueStatus) => void): void {
  listeners.add(fn);
  fn(status);
}

export function onSent(fn: (item: QueueItem, response: unknown) => Promise<void>): void {
  sentHandler = fn;
}

function update(patch: Partial<QueueStatus>): void {
  status = { ...status, ...patch };
  for (const fn of listeners) fn(status);
}

async function items(): Promise<QueueItem[]> {
  return (await getAll<QueueItem>('queue')).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

async function refreshCounts(): Promise<void> {
  const all = await items();
  update({
    pending: all.filter((i) => !i.rejected).length,
    rejected: all.filter((i) => i.rejected).length,
  });
}

export async function enqueue(item: Pick<QueueItem, 'client_uuid' | 'kind' | 'url' | 'body'>): Promise<void> {
  await put('queue', { ...item, attempts: 0, created_at: new Date().toISOString() });
  await refreshCounts();
  void flush();
}

export async function deliveryOf(clientUuid: string): Promise<Delivery> {
  const mine = (await items()).filter((i) => i.client_uuid === clientUuid);
  if (mine.some((i) => i.rejected)) return 'rejected';
  return mine.length ? 'pending' : 'sent';
}

export async function rejectionFor(clientUuid: string): Promise<string | undefined> {
  return (await items()).find((i) => i.client_uuid === clientUuid && i.rejected)?.rejected;
}

// Used when a tutor corrects and resubmits a record the server refused:
// the corrected version replaces the refused one.
export async function dropRejected(clientUuid: string, kind: QueueKind): Promise<void> {
  for (const i of await items()) {
    if (i.client_uuid === clientUuid && i.kind === kind && i.rejected) await remove('queue', i.seq as number);
  }
}

export function flush(): Promise<void> {
  flushing ??= drain().finally(() => {
    flushing = null;
  });
  return flushing;
}

async function drain(): Promise<void> {
  clearTimeout(retryTimer);
  // A session whose earlier step was refused must not have later steps sent out of order.
  const blocked = new Set<string>();
  let stalled = false;

  // Re-read the queue each time so items added mid-flush are picked up.
  for (;;) {
    const all = await items();
    for (const i of all) if (i.rejected) blocked.add(i.client_uuid);
    const next = all.find((i) => !blocked.has(i.client_uuid));
    if (!next) break;

    const outcome = await send(next);
    if (outcome === 'sent') {
      retryIndex = 0;
      continue;
    }
    if (outcome === 'rejected') {
      blocked.add(next.client_uuid);
      continue;
    }
    stalled = true;
    break;
  }

  await refreshCounts();
  if (stalled && status.pending > 0 && !status.needsSignIn) {
    const seconds = RETRY_SECONDS[Math.min(retryIndex++, RETRY_SECONDS.length - 1)] ?? 120;
    retryTimer = setTimeout(() => void flush(), seconds * 1000);
  }
}

async function send(item: QueueItem): Promise<Outcome> {
  let res: Response;
  try {
    res = await fetch(item.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(item.body),
      credentials: 'same-origin',
      // An expired Cloudflare Access session answers with a redirect to its login page.
      redirect: 'manual',
    });
  } catch {
    update({ online: false });
    return 'offline';
  }
  update({ online: true });

  if (res.type === 'opaqueredirect' || res.status === 401 || res.status === 403) {
    update({ needsSignIn: true });
    return 'auth';
  }
  if (status.needsSignIn) update({ needsSignIn: false });

  if (res.ok) {
    const data: unknown = await res.json().catch(() => null);
    await remove('queue', item.seq as number);
    await sentHandler(item, data);
    return 'sent';
  }

  // Server trouble (including the tunnel answering while the app is down): try again later.
  if (res.status >= 500 || res.status === 408 || res.status === 429) {
    await put('queue', { ...item, attempts: item.attempts + 1 });
    return 'offline';
  }

  const err = (await res.json().catch(() => ({}))) as { error?: string };
  await put('queue', {
    ...item,
    attempts: item.attempts + 1,
    rejected: `${res.status}: ${err.error ?? res.statusText ?? 'rejected'}`,
  });
  return 'rejected';
}

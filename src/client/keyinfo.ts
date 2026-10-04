import type { KeyInfoView, PupilSummary } from '../shared/types';
import { cachedGet } from './api';
import { enqueue } from './queue';
import { kvGet, kvSet, remove } from './store';

// Pupil key information on the phone (Back_Office_Scope.md §4). Cached so a tutor in a
// home with no signal can still check allergies or what not to do. Only the tutor's own
// pupils are cached, and a pupil's entry is dropped when they're no longer assigned.

const cacheKey = (pupilId: number) => `keyinfo:${pupilId}`;
const confirmedKey = (pupilId: number) => `keyinfo-confirmed:${pupilId}`;
const INDEX_KEY = 'keyinfo-index';

export async function loadKeyInfo(pupilId: number) {
  return cachedGet<KeyInfoView | null>(`/api/pupils/${pupilId}/key-info`, cacheKey(pupilId));
}

// The version this phone has confirmed (possibly not yet sent).
export async function locallyConfirmed(pupilId: number): Promise<number> {
  return (await kvGet<number>(confirmedKey(pupilId))) ?? 0;
}

export function needsReading(p: PupilSummary, localVersion: number): boolean {
  if (!p.key_info_version) return false;
  return p.key_info_confirmed !== 1 && localVersion < p.key_info_version;
}

export async function confirmRead(pupilId: number, version: number): Promise<void> {
  await kvSet(confirmedKey(pupilId), Math.max(version, await locallyConfirmed(pupilId)));
  await enqueue({
    client_uuid: `keyinfo-${pupilId}-${version}`,
    kind: 'confirm',
    url: `/api/pupils/${pupilId}/key-info/confirm`,
    body: { version },
  });
}

// After a fresh pupil list: cache key information for every assigned pupil that has it,
// and remove anything cached for pupils no longer on the list.
export async function syncKeyInfoCache(pupils: PupilSummary[]): Promise<void> {
  const keep = new Set(pupils.map((p) => p.id));
  const previous = (await kvGet<number[]>(INDEX_KEY)) ?? [];
  for (const id of previous) {
    if (!keep.has(id)) {
      await remove('kv', cacheKey(id));
      await remove('kv', confirmedKey(id));
    }
  }
  await kvSet(INDEX_KEY, [...keep]);
  for (const p of pupils) {
    if (p.key_info_version) await loadKeyInfo(p.id);
  }
}

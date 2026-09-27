import { kvGet, kvSet } from './store';

export class AuthRequired extends Error {}
class Offline extends Error {}

async function getJSON<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      credentials: 'same-origin',
      redirect: 'manual',
      headers: { accept: 'application/json' },
    });
  } catch {
    throw new Offline();
  }
  if (res.type === 'opaqueredirect' || res.status === 401 || res.status === 403) {
    throw new AuthRequired();
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export interface Cached<T> {
  data: T | undefined;
  fresh: boolean;
  authRequired: boolean;
}

// Fetch from the server when possible and remember the answer on the phone,
// so the app still opens with the tutor's pupils when there is no signal.
export async function cachedGet<T>(url: string, key: string): Promise<Cached<T>> {
  try {
    const data = await getJSON<T>(url);
    await kvSet(key, data);
    return { data, fresh: true, authRequired: false };
  } catch (err) {
    return {
      data: await kvGet<T>(key),
      fresh: false,
      authRequired: err instanceof AuthRequired,
    };
  }
}

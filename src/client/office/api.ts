// Office API calls. The office is desktop and online: no offline queue here, and every
// failure is shown, never swallowed.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      redirect: 'manual',
      headers: body instanceof FormData ? {} : body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'No connection to the server.');
  }
  if (res.type === 'opaqueredirect' || res.status === 401) {
    throw new ApiError(401, 'Your sign-in has run out. Reload the page to sign in again.');
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    const msg =
      res.status === 403
        ? 'You are not allowed to do that (office access needs an office login and role).'
        : (data.error ?? `Server error ${res.status}`);
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
  put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body ?? {}),
  del: <T>(url: string) => request<T>('DELETE', url),
};

export type Row = Record<string, unknown>;

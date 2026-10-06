/** Thin API client. Every mutating call carries the CSRF header the backend requires. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) { super(message); }
}

/** Mobile networks stall: give up after this long instead of leaving the member waiting. */
const TIMEOUT_MS = 20_000;

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch('/api' + url, {
      method, credentials: 'same-origin',
      headers: { 'x-quickloan': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e: any) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new ApiError(0, 'TIMEOUT', 'This is taking longer than usual. Your network may be slow. Please try again.');
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new ApiError(0, 'OFFLINE', 'You are offline. Check your data or Wi-Fi and try again.');
    throw new ApiError(0, 'NETWORK', 'We could not reach QuickLoan. Check your connection and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data?.error ?? data;
    throw new ApiError(res.status, e?.code ?? 'ERROR', e?.message ?? 'Something went wrong. Please try again.', e?.details);
  }
  return data as T;
}

export const api = {
  get: <T = any>(url: string) => request<T>('GET', url),
  post: <T = any>(url: string, body: unknown = {}) => request<T>('POST', url, body),
  put: <T = any>(url: string, body: unknown) => request<T>('PUT', url, body),
  patch: <T = any>(url: string, body: unknown) => request<T>('PATCH', url, body),
  del: <T = any>(url: string) => request<T>('DELETE', url),
};

/** Download a file from the API (signed-in session) and save it with the server's file name. */
export async function downloadFile(url: string, fallbackName: string) {
  let res: Response;
  try { res = await fetch('/api' + url, { credentials: 'same-origin' }); }
  catch { throw new ApiError(0, 'NETWORK', 'We could not reach QuickLoan. Check your connection and try again.'); }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data?.error?.code ?? 'ERROR', data?.error?.message ?? 'The file could not be downloaded. Please try again.');
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const href = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 2000);
  return name;
}

export const kes = (n: number | null | undefined) => 'KES ' + Math.round(n ?? 0).toLocaleString('en-KE');
export const fmtDate = (d?: string | null, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }) =>
  d ? new Date(d.length === 10 ? d + 'T12:00:00' : d).toLocaleDateString('en-GB', opts) : '—';
export const fmtDateTime = (d?: string | null) =>
  d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
export const label = (s?: string | null) => (s ?? '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

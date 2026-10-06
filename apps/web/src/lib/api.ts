import type {
  Access, ChangeDetail, ChangeInfo, Mode, Policy, ProjectInfo, SaveResult, TreeNode, UploadResult, User,
} from './types';

/** An answer the server gave that was not a success, or no answer at all (status 0). */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly retryAfter?: number,
  ) {
    super(message);
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch('/api' + path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'network', "Can't reach the server. Check your connection.");
  }
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON, e.g. an error page from a proxy */ }
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    throw new ApiError(res.status, e?.code ?? `http_${res.status}`, e?.message ?? `The server answered ${res.status}`, e?.details, Number(res.headers.get('retry-after')) || undefined);
  }
  return data as T;
}

const q = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) s.set(k, String(v));
  const out = s.toString();
  return out ? '?' + out : '';
};
const p = (id: string) => `/projects/${encodeURIComponent(id)}`;

export const auth = {
  me: () => request<{ user: User | null }>('GET', '/auth/me').then((r) => r.user),
  login: (username: string, password: string) => request<{ user: User }>('POST', '/auth/login', { username, password }).then((r) => r.user),
  register: (username: string, password: string) => request<{ user: User }>('POST', '/auth/register', { username, password }).then((r) => r.user),
  logout: () => request<{ ok: true }>('POST', '/auth/logout', {}),
  setDefaultPolicy: (defaultRollbackPolicy: Policy) => request<{ user: User }>('PATCH', '/auth/me', { defaultRollbackPolicy }).then((r) => r.user),
};

export const projects = {
  list: () => request<{ projects: ProjectInfo[] }>('GET', '/projects').then((r) => r.projects),
  create: (name: string) => request<{ project: ProjectInfo }>('POST', '/projects', { name }).then((r) => r.project),
  get: (id: string) => request<{ project: ProjectInfo; access: Access }>('GET', p(id)),
  setPolicy: (id: string, rollbackPolicy: Policy) => request<{ project: ProjectInfo }>('PATCH', p(id), { rollbackPolicy }).then((r) => r.project),
  remove: (id: string) => request<{ ok: true }>('DELETE', p(id)),
  passwords: (id: string) => request<{ ro: string; rw: string }>('GET', `${p(id)}/passwords`),
  refreshPassword: (id: string, mode: Mode) => request<{ password: string }>('POST', `${p(id)}/passwords/${mode}/refresh`, {}).then((r) => r.password),
  /** The name of a project: public to anyone who knows its id (404 when there is no such project). */
  publicName: (id: string) => request<{ name: string }>('GET', `${p(id)}/public`).then((r) => r.name),
  openGate: (id: string, password: string, name?: string) => request<{ access: { level: Mode; name: string } }>('POST', `${p(id)}/access`, { password, name }),
};

export const files = {
  tree: (id: string) => request<{ nodes: TreeNode[] }>('GET', `${p(id)}/tree`).then((r) => r.nodes),
  read: (id: string, path: string) => request<{ file: { path: string; content: string; version: number; updatedAt: string } }>('GET', `${p(id)}/file${q({ path })}`).then((r) => r.file),
  save: (id: string, path: string, content: string, baseVersion: number) => request<SaveResult>('PUT', `${p(id)}/file`, { path, content, baseVersion }),
  create: (id: string, path: string, kind: 'file' | 'dir', content?: string) => request<{ change: { seq: number } }>('POST', `${p(id)}/files`, { path, kind, content }),
  move: (id: string, from: string, to: string) => request<{ change: { seq: number } }>('POST', `${p(id)}/move`, { from, to }),
  remove: (id: string, path: string) => request<{ change: { seq: number } }>('DELETE', `${p(id)}/file${q({ path })}`),
  upload: (id: string, body: { files: { path: string; content: string }[]; folders?: string[]; overwrite?: boolean }) => request<UploadResult>('POST', `${p(id)}/upload`, body),
  history: (id: string, opts: { limit?: number; before?: number } = {}) => request<{ changes: ChangeInfo[]; nextBefore: number | null }>('GET', `${p(id)}/history${q(opts)}`),
  change: (id: string, seq: number) => request<{ change: ChangeDetail }>('GET', `${p(id)}/history/${seq}`).then((r) => r.change),
  rollback: (id: string, seq: number) => request<{ change: { seq: number } }>('POST', `${p(id)}/history/${seq}/rollback`, {}),
};

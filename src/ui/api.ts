async function request<Result>(path: string, init?: RequestInit): Promise<Result> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body === undefined ? {} : { 'content-type': 'application/json' },
  });

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(describe(body) ?? `${path} failed with ${String(response.status)}`);
  }

  return body as Result;
}

function describe(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('message' in body)) {
    return undefined;
  }

  const { message } = body;
  return Array.isArray(message) ? message.join(', ') : String(message);
}

export function getJson<Result>(path: string): Promise<Result> {
  return request<Result>(path);
}

export function postJson<Result>(path: string, body?: unknown): Promise<Result> {
  return request<Result>(path, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export function deleteJson<Result>(path: string): Promise<Result> {
  return request<Result>(path, { method: 'DELETE' });
}

export function patchJson<Result>(path: string, body: unknown): Promise<Result> {
  return request<Result>(path, { method: 'PATCH', body: JSON.stringify(body) });
}

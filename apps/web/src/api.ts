export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'X-App-Client': 'internal-workspace',
      ...(init?.body && typeof init.body === 'string'
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...init?.headers,
    },
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(body.message ?? body.code ?? `Yêu cầu thất bại (${response.status}).`);
  return body;
}
export const post = <T>(path: string, body: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body) });
export const money = (value?: string) =>
  value === undefined || value === '' ? 'Chưa có' : BigInt(value).toLocaleString('vi-VN') + ' ₫';
export const date = (value: string) => new Date(value).toLocaleString('vi-VN');
export const media = (id: string) => '/v1/media/' + encodeURIComponent(id);
export type ImportRecord = {
  id: string;
  sha256: string;
  filename: string;
  kind: 'xlsx' | 'docx' | 'image';
  status: string;
  bytes: number;
  createdAt: string;
  message: string;
  body?: unknown;
};

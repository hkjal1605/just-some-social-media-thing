// The bot never writes the DB directly — it calls the API with ADMIN_API_TOKEN
// (single write path, doc 08 §1 / doc 09 §2).
import { env } from "@ve/config";

export class TgApiError extends Error {
  constructor(
    public readonly path: string,
    public readonly status: number,
    body: string,
  ) {
    super(`api ${path} ${status}: ${body.slice(0, 300)}`);
    this.name = "TgApiError";
  }
}

export async function api<T = Record<string, unknown>>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${env.APP_BASE_URL}/api/v1${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.ADMIN_API_TOKEN}`,
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) throw new TgApiError(path, res.status, await res.text());
  return (await res.json()) as T;
}

export const apiGet = <T = Record<string, unknown>>(path: string) => api<T>(path);
export const apiPost = <T = Record<string, unknown>>(path: string, body: unknown) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });

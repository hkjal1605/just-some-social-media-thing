// settings table access with a 30s in-process TTL cache (doc 08 §5).
import { sql } from "drizzle-orm";
import { db } from "./client";
import { settings } from "./schema";

const TTL_MS = 30_000;
const cache = new Map<string, { v: unknown; at: number }>();

export async function getSetting<T = unknown>(key: string): Promise<T | null> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v as T | null;
  // raw driver read: drizzle's jsonb mapper JSON.parses string values that happen to
  // be valid JSON (e.g. numeric-looking cursors) — postgres.js returns them correctly
  const rows = (await db.execute(
    sql`select value from settings where key = ${key} limit 1`,
  )) as unknown as { value: unknown }[];
  const v = rows.length > 0 ? ((rows[0]?.value ?? null) as T) : null;
  cache.set(key, { v, at: Date.now() });
  return v;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  cache.delete(key);
}

export function bustSettingsCache(): void {
  cache.clear();
}

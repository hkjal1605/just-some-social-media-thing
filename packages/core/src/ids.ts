import { uuidv7 } from "uuidv7";

/** UUIDv7 — time-sortable, index-friendly (doc 00 §3). All PKs are generated app-side. */
export function newId(): string {
  return uuidv7();
}

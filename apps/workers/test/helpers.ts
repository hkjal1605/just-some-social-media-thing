// Shared test helpers (not a *.test.ts file, so bun won't run it as a suite).

/** Assert a value is present and narrow it — keeps tests non-null-assertion-free. */
export function need<T>(v: T | undefined | null, msg = "expected a value"): T {
  if (v === undefined || v === null) throw new Error(msg);
  return v;
}

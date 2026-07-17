// bun test preload (bunfig.toml): force .env.test values into the environment
// before any test file imports @ve/config, and silence pino.
import { readFileSync } from "node:fs";
import { join } from "node:path";

let text = "";
try {
  text = readFileSync(join(import.meta.dir, "..", ".env.test"), "utf8");
} catch {
  // no .env.test — fall through with defaults below
}

for (const line of text.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m?.[1] !== undefined && m[2] !== undefined) {
    process.env[m[1]] = m[2].replace(/\s+#.*$/, "").trim();
  }
}

process.env.APP_ENV = "test";
process.env.LOG_LEVEL = "silent";

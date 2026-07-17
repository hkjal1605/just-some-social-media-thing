// bun run db:migrate — applies committed SQL from packages/db/drizzle/ (doc 02 §6).
import { join } from "node:path";
import { env } from "@ve/config";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export async function runMigrations(databaseUrl: string = env.DATABASE_URL): Promise<void> {
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), {
      migrationsFolder: join(import.meta.dir, "..", "drizzle"),
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  await runMigrations();
  console.log(`migrations applied → ${env.DATABASE_URL.replace(/\/\/.*@/, "//***@")}`);
}

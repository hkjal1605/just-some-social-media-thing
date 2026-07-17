import { defineConfig } from "drizzle-kit";

// drizzle-kit runs outside the app (generate/check need no live env),
// so this file reads process.env directly rather than @ve/config.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://ve:ve@localhost:5432/viral_engine",
  },
});

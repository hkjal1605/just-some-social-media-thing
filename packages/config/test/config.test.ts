import { describe, expect, test } from "bun:test";
import { EnvSchema, env, integrations, tgAdminIds } from "../src";

const validBase = {
  APP_BASE_URL: "http://localhost:3000",
  DATABASE_URL: "postgres://ve:ve@localhost:5432/viral_engine_test",
  R2_ENDPOINT: "http://localhost:9000",
  R2_ACCESS_KEY_ID: "k",
  R2_SECRET_ACCESS_KEY: "s",
  R2_BUCKET: "b",
  OPENROUTER_API_KEY: "or",
  GEMINI_API_KEY: "g",
  SESSION_SECRET: "0123456789abcdef0123456789abcdef",
  DASHBOARD_ADMIN_PASSWORD: "password1",
  ADMIN_API_TOKEN: "0123456789abcdef01234567",
};

describe("EnvSchema", () => {
  test("parses a minimal valid env with defaults", () => {
    const e = EnvSchema.parse(validBase);
    expect(e.APP_ENV).toBe("development");
    expect(e.API_PORT).toBe(3000);
    expect(e.OPENROUTER_MODEL).toBe("deepseek/deepseek-v4-pro");
    expect(e.OPENROUTER_MODEL_FLASH).toBe("deepseek/deepseek-v4-flash");
    expect(e.OPENROUTER_MODEL_EMBED).toBe("openai/text-embedding-3-small");
    expect(e.OPENROUTER_EMBED_DIMS).toBe(768);
    expect(e.COST_BUDGET_MONTHLY_USD).toBe(150);
    expect(e.KILL_SWITCH_DEFAULT).toBe(false);
  });

  test("rejects short SESSION_SECRET / ADMIN_API_TOKEN", () => {
    expect(EnvSchema.safeParse({ ...validBase, SESSION_SECRET: "short" }).success).toBe(false);
    expect(EnvSchema.safeParse({ ...validBase, ADMIN_API_TOKEN: "short" }).success).toBe(false);
  });

  test('KILL_SWITCH_DEFAULT="false" parses to boolean false (coerce.boolean would break this)', () => {
    expect(
      EnvSchema.parse({ ...validBase, KILL_SWITCH_DEFAULT: "false" }).KILL_SWITCH_DEFAULT,
    ).toBe(false);
    expect(EnvSchema.parse({ ...validBase, KILL_SWITCH_DEFAULT: "true" }).KILL_SWITCH_DEFAULT).toBe(
      true,
    );
  });

  test("telegram chat ids coerce from strings", () => {
    const e = EnvSchema.parse({ ...validBase, TELEGRAM_APPROVAL_CHAT_ID: "-100123" });
    expect(e.TELEGRAM_APPROVAL_CHAT_ID).toBe(-100123);
  });
});

describe("loaded test env", () => {
  test("env is the test environment (preloaded from .env.test)", () => {
    expect(env.APP_ENV).toBe("test");
    expect(env.DATABASE_URL).toContain("viral_engine_test");
  });

  test("integrations flags are off without credentials", () => {
    expect(integrations.x).toBe(false);
    expect(integrations.ayrshare).toBe(false);
    expect(integrations.reddit).toBe(false);
    expect(tgAdminIds).toEqual([]);
  });
});

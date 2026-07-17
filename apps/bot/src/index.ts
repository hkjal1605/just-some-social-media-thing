// apps/bot — grammY long-polling process (doc 09 §2). Never writes the DB directly;
// all decisions go through the API with ADMIN_API_TOKEN. Without a token the process
// idles (dev without credentials must still boot — doc 00 §6).
import { env } from "@ve/config";
import { makeLogger } from "@ve/core";
import { buildBot } from "@ve/telegram";

const log = makeLogger("bot");

if (!env.TELEGRAM_BOT_TOKEN) {
  log.warn("TELEGRAM_BOT_TOKEN empty — bot disabled, idling (set the token to enable approvals)");
  setInterval(() => {}, 2 ** 30); // keep the process alive under scripts/dev.ts
} else {
  const bot = buildBot();
  void bot.start({
    drop_pending_updates: true,
    allowed_updates: ["message", "callback_query"],
    onStart: (me) => log.info({ username: me.username }, "bot: long-polling started"),
  });
  const stop = async () => {
    await bot.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
}

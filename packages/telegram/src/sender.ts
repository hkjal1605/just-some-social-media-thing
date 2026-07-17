// Send-only helpers for apps/workers (doc 03 §7): raw Bot API via bot.api,
// never long-polling. When no token is configured, sends become logged no-ops
// so the pipeline stays runnable without credentials.
import { env, integrations } from "@ve/config";
import { makeLogger } from "@ve/core";
import { Bot } from "grammy";
import { sendApprovalCardWith, updateApprovalCardWith } from "./cards";

const log = makeLogger("telegram-send");

let _sender: Bot | null = null;
function sender(): Bot | null {
  if (!integrations.telegram) return null;
  _sender ??= new Bot(env.TELEGRAM_BOT_TOKEN);
  return _sender;
}

/** Ops alert to TELEGRAM_ALERT_CHAT_ID (doc 08 §9 format built by the caller). */
export async function sendAlert(text: string): Promise<void> {
  const bot = sender();
  if (!bot) {
    log.warn({ text: text.slice(0, 200) }, "telegram disabled — alert not sent");
    return;
  }
  await bot.api.sendMessage(env.TELEGRAM_ALERT_CHAT_ID, text.slice(0, 4000));
}

/** Radar digest markdown to the approval chat (doc 04 §5). */
export async function sendDigest(md: string): Promise<void> {
  const bot = sender();
  if (!bot) {
    log.warn("telegram disabled — digest not sent");
    return;
  }
  try {
    await bot.api.sendMessage(env.TELEGRAM_APPROVAL_CHAT_ID, md.slice(0, 4000), {
      parse_mode: "Markdown",
    });
  } catch {
    // markdown parse failure → send plain rather than losing the digest
    await bot.api.sendMessage(env.TELEGRAM_APPROVAL_CHAT_ID, md.slice(0, 4000));
  }
}

/** Contract surface (doc 03 §7): sendApprovalCard(approvalId). */
export async function sendApprovalCard(approvalId: string): Promise<number | null> {
  const bot = sender();
  if (!bot) {
    log.warn({ approvalId }, "telegram disabled — approval card not sent");
    return null;
  }
  return sendApprovalCardWith(bot, approvalId);
}

export async function updateApprovalCard(approvalId: string, line: string): Promise<void> {
  const bot = sender();
  if (!bot) return;
  await updateApprovalCardWith(bot, approvalId, line);
}

// Full approval bot (doc 09 §2 reference implementation).
// Long-polling process (apps/bot); only admin ids may press buttons;
// only the approval group chat is served; all writes go through the API.
import { env, tgAdminIds } from "@ve/config";
import { makeLogger } from "@ve/core";
import { Bot, GrammyError } from "grammy";
import { api } from "./api";
import { sendApprovalCardWith } from "./cards";

const log = makeLogger("telegram-bot");

interface DecideResult {
  ok?: boolean;
  raced?: boolean;
  error?: string;
}

interface OpsSummary {
  postsToday: number;
  pendingApprovals: number;
  spendMtd: number;
  dlqCount: number;
  killSwitch: boolean;
}

/** Admin guard — exported for tests. */
export const isAdminUser = (id: number | undefined, adminIds: number[] = tgAdminIds): boolean =>
  id !== undefined && adminIds.includes(id);

/** Approval-chat guard — exported for tests. */
export const isApprovalChat = (
  chatId: number | undefined,
  approvalChatId: number = env.TELEGRAM_APPROVAL_CHAT_ID,
): boolean => chatId !== undefined && chatId === approvalChatId;

/** callback_data: apr|<approvalId>|approve / reject / edit — exported for tests. */
export function parseApprovalCallback(
  data: string,
): { approvalId: string; action: "approve" | "reject" | "edit" } | null {
  const [tag, approvalId, action] = data.split("|");
  if (tag !== "apr" || !approvalId) return null;
  if (action !== "approve" && action !== "reject" && action !== "edit") return null;
  return { approvalId, action };
}

export function buildBot(): Bot {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("buildBot: TELEGRAM_BOT_TOKEN is empty (bot disabled — do not start)");
  }
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  // reject/edit reasons captured via force-reply; bot restarts lose intents — user retaps
  const pendingReplies = new Map<
    number,
    { approvalId: string; action: "reject" | "edit"; byUserId: number }
  >();

  // ── commands ──────────────────────────────────────────────────
  bot.command("start", (ctx) =>
    ctx.reply("Viral Engine approval bot. Commands: /pending /status /kill /resume"),
  );

  bot.command("pending", async (ctx) => {
    if (!isApprovalChat(ctx.chat?.id)) return;
    const { items } = await api<{ items: { id: string }[] }>("/approvals?status=pending");
    if (items.length === 0) {
      await ctx.reply("✅ No pending approvals.");
      return;
    }
    for (const a of items) await sendApprovalCardWith(bot, a.id); // re-sends cards, updates tgMessageId
  });

  bot.command("status", async (ctx) => {
    if (!isApprovalChat(ctx.chat?.id)) return;
    const s = await api<OpsSummary>("/ops/summary");
    await ctx.reply(
      `📊 posts today: ${s.postsToday} · pending: ${s.pendingApprovals} · spend MTD: $${s.spendMtd.toFixed(2)}\n` +
        `queues: ${s.dlqCount} dead-lettered · kill-switch: ${s.killSwitch ? "🔴 ON" : "🟢 off"}`,
    );
  });

  bot.command("kill", async (ctx) => {
    if (!isAdminUser(ctx.from?.id)) {
      await ctx.reply("⛔ not authorized");
      return;
    }
    await api("/settings/kill-switch", {
      method: "PUT",
      body: JSON.stringify({ on: true, reason: `tg:${ctx.from?.id}` }),
    });
    await ctx.reply("🔴 Kill-switch ON — publishing, factory and replies paused.");
  });

  bot.command("resume", async (ctx) => {
    if (!isAdminUser(ctx.from?.id)) {
      await ctx.reply("⛔ not authorized");
      return;
    }
    await api("/settings/kill-switch", { method: "PUT", body: JSON.stringify({ on: false }) });
    await ctx.reply("🟢 Kill-switch OFF.");
  });

  // ── approval buttons ─────────────────────────────────────────
  bot.on("callback_query:data", async (ctx) => {
    const parsed = parseApprovalCallback(ctx.callbackQuery.data);
    if (!parsed) return;
    if (!isAdminUser(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "⛔ not authorized", show_alert: true });
      return;
    }
    const { approvalId, action } = parsed;

    if (action === "approve") {
      const r = await api<DecideResult>(`/approvals/${approvalId}/decide`, {
        method: "POST",
        body: JSON.stringify({ decision: "approved", via: "telegram", tgUserId: ctx.from.id }),
      }).catch((e) => ({ error: String(e) }) as DecideResult);
      if (r.error || r.raced) {
        await ctx.answerCallbackQuery({
          text: r.raced ? "Already decided elsewhere" : "Failed — see alerts",
          show_alert: true,
        });
        return;
      }
      // video cards carry text in `caption`, text cards in `text`
      const msg = ctx.callbackQuery.message;
      const suffix = `\n\n✅ APPROVED by ${ctx.from.first_name} — scheduling.`;
      await ctx.editMessageReplyMarkup(undefined).catch(() => {});
      if (msg && "caption" in msg && msg.caption) {
        await ctx.editMessageCaption({ caption: msg.caption + suffix }).catch(() => {});
      } else if (msg && "text" in msg && msg.text) {
        await ctx.editMessageText(msg.text + suffix).catch(() => {});
      }
      await ctx.answerCallbackQuery({ text: "Approved ✅" });
      return;
    }

    // reject / edit → ask for reason via force-reply
    const prompt =
      action === "reject"
        ? "✏️ Reply to this message with the REJECT reason."
        : "✏️ Reply to this message with EDIT instructions (hook/caption/scene changes).";
    const m = await ctx.reply(prompt, {
      reply_markup: { force_reply: true, selective: true },
    });
    pendingReplies.set(m.message_id, { approvalId, action, byUserId: ctx.from.id });
    await ctx.answerCallbackQuery();
  });

  // force-reply capture for reject/edit
  bot.on("message:text", async (ctx) => {
    const replyTo = ctx.message.reply_to_message?.message_id;
    if (!replyTo || !pendingReplies.has(replyTo)) return;
    const intent = pendingReplies.get(replyTo);
    if (!intent || ctx.from.id !== intent.byUserId) return; // only the button-presser's reply counts
    pendingReplies.delete(replyTo);
    const body =
      intent.action === "reject"
        ? {
            decision: "rejected",
            reason: ctx.message.text,
            via: "telegram",
            tgUserId: ctx.from.id,
          }
        : {
            decision: "edit_requested",
            editInstructions: ctx.message.text,
            via: "telegram",
            tgUserId: ctx.from.id,
          };
    const r = await api<DecideResult>(`/approvals/${intent.approvalId}/decide`, {
      method: "POST",
      body: JSON.stringify(body),
    }).catch((e) => ({ error: String(e) }) as DecideResult);
    await ctx.reply(
      r.error
        ? `❌ failed: ${r.error}`
        : r.raced
          ? "⚠️ already decided elsewhere"
          : intent.action === "reject"
            ? "🗑 Rejected."
            : "🔁 Edit queued — a new version will arrive for approval.",
    );
  });

  bot.catch((err) => {
    log.error(
      { err: err.error instanceof GrammyError ? err.error.description : err.error },
      "bot error",
    );
  });

  return bot;
}

// Approval cards (doc 09 §2). Card payloads are assembled by the API
// (GET /approvals/:id/card) including presigned preview URLs.
import { env } from "@ve/config";
import { type Bot, InlineKeyboard } from "grammy";
import { apiGet, apiPost } from "./api";

export interface ApprovalCard {
  id: string;
  categoryName: string;
  formatSlug: string;
  angle: string;
  hook: string;
  platforms: string[];
  plannedSlotDisplay: string;
  aiDisclosure: boolean;
  trendHeadline?: string;
  dashboardUrl: string;
  previewVideoUrl?: string; // presigned; absent for text formats
  previewThumbUrl?: string; // presigned thumbnail — fallback when the video is too big to URL-send
  previewBytes?: number; // render size; the URL-send cap is 20 MB (doc 09 §2)
  bodyPreview?: string;
}

export const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// sendVideo BY URL: Telegram fetches the media server-side, where the cap is 20 MB — NOT the 50 MB
// that applies to multipart uploads. A 20–50 MB render used to pass this gate and then 400, losing
// the whole approval card (H12).
const TG_VIDEO_URL_LIMIT_BYTES = 20 * 1024 * 1024;

export function approvalKeyboard(approvalId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Approve", `apr|${approvalId}|approve`)
    .text("✏️ Edit", `apr|${approvalId}|edit`)
    .text("❌ Reject", `apr|${approvalId}|reject`);
}

/** Pure caption builder — unit-testable without a live bot. */
export function buildApprovalCaption(a: ApprovalCard): string {
  return (
    `🎬 <b>${esc(a.categoryName)} · ${esc(a.formatSlug)}</b>\n` +
    `<b>Angle:</b> ${esc(a.angle)}\n` +
    `<b>Hook:</b> ${esc(a.hook)}\n` +
    `<b>Platforms:</b> ${a.platforms.map(esc).join(", ")} · <b>slot:</b> ${esc(a.plannedSlotDisplay)}\n` +
    (a.aiDisclosure ? "🏷 AI-disclosure will be set\n" : "") +
    (a.trendHeadline ? `<b>Trend:</b> ${esc(a.trendHeadline)}\n` : "") +
    `<a href="${a.dashboardUrl}">open in dashboard</a>`
  );
}

export async function sendApprovalCardWith(bot: Bot, approvalId: string): Promise<number> {
  const a = await apiGet<ApprovalCard>(`/approvals/${approvalId}/card`);
  const kb = approvalKeyboard(approvalId);
  const caption = buildApprovalCaption(a);

  const useVideo =
    a.previewVideoUrl !== undefined &&
    (a.previewBytes === undefined || a.previewBytes <= TG_VIDEO_URL_LIMIT_BYTES);

  let msg: { message_id: number };
  if (useVideo) {
    msg = await bot.api.sendVideo(env.TELEGRAM_APPROVAL_CHAT_ID, a.previewVideoUrl as string, {
      caption,
      parse_mode: "HTML",
      reply_markup: kb,
    });
  } else if (a.previewThumbUrl) {
    // video too big to URL-send (or absent) → send the thumbnail photo + link instead (doc 09 §2)
    msg = await bot.api.sendPhoto(env.TELEGRAM_APPROVAL_CHAT_ID, a.previewThumbUrl, {
      caption,
      parse_mode: "HTML",
      reply_markup: kb,
    });
  } else {
    // text formats (or no preview): include the script body only when there is one — no empty <pre>
    const body = (a.bodyPreview ?? "").slice(0, 900);
    const text = body ? `${caption}\n\n<pre>${esc(body)}</pre>` : caption;
    msg = await bot.api.sendMessage(env.TELEGRAM_APPROVAL_CHAT_ID, text, {
      parse_mode: "HTML",
      reply_markup: kb,
    });
  }

  await apiPost(`/approvals/${approvalId}/tg-message`, { tgMessageId: msg.message_id });
  return msg.message_id;
}

/** Post-decision convergence: drop the buttons, thread a status line (doc 09 §2). */
export async function updateApprovalCardWith(
  bot: Bot,
  approvalId: string,
  line: string,
): Promise<void> {
  const a = await apiGet<{ tgMessageId: number | null }>(`/approvals/${approvalId}`);
  if (!a.tgMessageId) return;
  await bot.api
    .editMessageReplyMarkup(env.TELEGRAM_APPROVAL_CHAT_ID, a.tgMessageId)
    .catch(() => {});
  await bot.api
    .sendMessage(env.TELEGRAM_APPROVAL_CHAT_ID, line, {
      reply_parameters: { message_id: a.tgMessageId },
    })
    .catch(() => {});
}

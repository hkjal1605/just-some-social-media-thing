# 09 · Approvals + Telegram bot (full reference implementation)

Every publishable brief passes one approval. Two surfaces — a Telegram group and the dashboard — backed by **one** state machine (`approvals` table). First decision wins; both surfaces reflect it.

## 1. Approval flow

```
render pass (pre_publish) ──▶ approval.request worker
  ├─ auto-approve check: category.mode=='full_auto_candidate' AND formatSlug ∈ category.autoApproveFormats
  │    └─ yes ▶ status='auto_approved' ▶ posts → 'approved' ▶ publish fast-path/plan
  └─ no ▶ create approvals row (expiresAt=now+24h) ▶ posts → 'awaiting_approval'
        ▶ sendApprovalCard(): TG message with previews + buttons; store tgMessageId
Decision (TG callback or dashboard POST) — inside one transaction:
  SELECT … FOR UPDATE; if status!='pending' → record 'race_ignored' event, notify actor "already decided"
  approve ▶ approvals.approved ▶ posts→approved ▶ enqueue publish.plan fast-path
  reject(reason) ▶ approvals.rejected ▶ posts→draft, brief→abandoned
  edit(instructions) ▶ approvals.edit_requested ▶ brief→scripted, enqueue factory.script (v+1 with instructions) → new compliance/render cycle → NEW approval row
Expiry (approval.remind hourly): >20h old pending → reminder ping; >24h → status='expired', brief→abandoned unless trend still active & llmScore≥80 (then renew once, event 'renewed')
```

`approval_events` records every step (created/reminded/approved/rejected/edit_requested/expired/race_ignored) with actor.

## 2. Telegram bot — complete implementation (`packages/telegram/src/`)

Design: **long-polling** process (`apps/bot`), grammY. The bot never writes the DB directly — it calls the API with `ADMIN_API_TOKEN` (single write path, doc 08 §1). Only user ids in `TELEGRAM_ADMIN_USER_IDS` may press buttons; only the approval group chat is served.

### `packages/telegram/src/bot.ts`

```ts
import { Bot, InlineKeyboard, GrammyError } from 'grammy';
import { env, tgAdminIds } from '@ve/config';

const api = async (path: string, init?: RequestInit) => {
  const res = await fetch(`${env.APP_BASE_URL}/api/v1${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.ADMIN_API_TOKEN}`, ...init?.headers },
  });
  if (!res.ok) throw new Error(`api ${path} ${res.status}: ${await res.text()}`);
  return res.json();
};

export function buildBot() {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  // ── guards ────────────────────────────────────────────────────
  const isAdmin = (id?: number) => !!id && tgAdminIds.includes(id);
  const inApprovalChat = (chatId?: number) => chatId === env.TELEGRAM_APPROVAL_CHAT_ID;

  // ── commands ──────────────────────────────────────────────────
  bot.command('start', (ctx) => ctx.reply('Viral Engine approval bot. Commands: /pending /digest /kill /resume /status'));

  bot.command('pending', async (ctx) => {
    if (!inApprovalChat(ctx.chat?.id)) return;
    const { items } = await api('/approvals?status=pending');
    if (!items.length) return ctx.reply('✅ No pending approvals.');
    for (const a of items) await sendApprovalCard(bot, a.id); // re-sends cards (updates tgMessageId)
  });

  bot.command('status', async (ctx) => {
    if (!inApprovalChat(ctx.chat?.id)) return;
    const s = await api('/ops/summary');
    await ctx.reply(
      `📊 posts today: ${s.postsToday} · pending: ${s.pendingApprovals} · spend MTD: $${s.spendMtd}\n` +
      `queues: ${s.dlqCount} dead-lettered · kill-switch: ${s.killSwitch ? '🔴 ON' : '🟢 off'}`);
  });

  bot.command('kill', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('⛔ not authorized');
    await api('/settings/kill-switch', { method: 'PUT', body: JSON.stringify({ on: true, reason: `tg:${ctx.from!.id}` }) });
    await ctx.reply('🔴 Kill-switch ON — publishing, factory and replies paused.');
  });
  bot.command('resume', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('⛔ not authorized');
    await api('/settings/kill-switch', { method: 'PUT', body: JSON.stringify({ on: false }) });
    await ctx.reply('🟢 Kill-switch OFF.');
  });

  // ── approval buttons ─────────────────────────────────────────
  // callback_data: apr|<approvalId>|approve  /  apr|<approvalId>|reject  /  apr|<approvalId>|edit
  bot.on('callback_query:data', async (ctx) => {
    const [tag, approvalId, action] = ctx.callbackQuery.data.split('|');
    if (tag !== 'apr') return;
    if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery({ text: '⛔ not authorized', show_alert: true });

    if (action === 'approve') {
      const r = await api(`/approvals/${approvalId}/decide`, {
        method: 'POST',
        body: JSON.stringify({ decision: 'approved', via: 'telegram', tgUserId: ctx.from.id }),
      }).catch((e) => ({ error: String(e) }));
      if (r.error || r.raced) return ctx.answerCallbackQuery({ text: r.raced ? 'Already decided elsewhere' : 'Failed — see alerts', show_alert: true });
      await ctx.editMessageReplyMarkup(undefined);                       // remove buttons
      await ctx.editMessageText(`${ctx.callbackQuery.message?.text}\n\n✅ APPROVED by ${ctx.from.first_name} — scheduling.`);
      return ctx.answerCallbackQuery({ text: 'Approved ✅' });
    }

    if (action === 'reject' || action === 'edit') {
      // ask for reason/instructions via force-reply; stash pending intent in memory (bot restarts lose it → user just retaps)
      const prompt = action === 'reject' ? '✏️ Reply to this message with the REJECT reason.' : '✏️ Reply to this message with EDIT instructions (hook/caption/scene changes).';
      const m = await ctx.reply(prompt, { reply_markup: { force_reply: true, selective: true } });
      pendingReplies.set(m.message_id, { approvalId, action, byUserId: ctx.from.id });
      return ctx.answerCallbackQuery();
    }
  });

  // force-reply capture for reject/edit
  const pendingReplies = new Map<number, { approvalId: string; action: 'reject'|'edit'; byUserId: number }>();
  bot.on('message:text', async (ctx) => {
    const replyTo = ctx.message.reply_to_message?.message_id;
    if (!replyTo || !pendingReplies.has(replyTo)) return;
    const intent = pendingReplies.get(replyTo)!;
    if (ctx.from.id !== intent.byUserId) return;               // only the button-presser's reply counts
    pendingReplies.delete(replyTo);
    const body = intent.action === 'reject'
      ? { decision: 'rejected', reason: ctx.message.text, via: 'telegram', tgUserId: ctx.from.id }
      : { decision: 'edit_requested', editInstructions: ctx.message.text, via: 'telegram', tgUserId: ctx.from.id };
    const r = await api(`/approvals/${intent.approvalId}/decide`, { method: 'POST', body: JSON.stringify(body) })
      .catch((e) => ({ error: String(e) }));
    await ctx.reply(r.error ? `❌ failed: ${r.error}` : (r.raced ? '⚠️ already decided elsewhere' :
      intent.action === 'reject' ? '🗑 Rejected.' : '🔁 Edit queued — a new version will arrive for approval.'));
  });

  bot.catch((err) => console.error('bot error', err instanceof GrammyError ? err.description : err));
  return bot;
}
```

### `packages/telegram/src/cards.ts`

```ts
import { InlineKeyboard, type Bot } from 'grammy';
import { env } from '@ve/config';

export async function sendApprovalCard(bot: Bot, approvalId: string) {
  const a = await apiGet(`/approvals/${approvalId}/card`);   // api assembles everything + presigned URLs
  const kb = new InlineKeyboard()
    .text('✅ Approve', `apr|${approvalId}|approve`)
    .text('✏️ Edit', `apr|${approvalId}|edit`)
    .text('❌ Reject', `apr|${approvalId}|reject`);

  const caption =
    `🎬 <b>${esc(a.categoryName)} · ${esc(a.formatSlug)}</b>\n` +
    `<b>Angle:</b> ${esc(a.angle)}\n` +
    `<b>Hook:</b> ${esc(a.hook)}\n` +
    `<b>Platforms:</b> ${a.platforms.join(', ')} · <b>slot:</b> ${esc(a.plannedSlotDisplay)}\n` +
    (a.aiDisclosure ? '🏷 AI-disclosure will be set\n' : '') +
    (a.trendHeadline ? `<b>Trend:</b> ${esc(a.trendHeadline)}\n` : '') +
    `<a href="${a.dashboardUrl}">open in dashboard</a>`;

  // one video preview (first render) + caption; if no render (text formats) send text with script body preview
  const msg = a.previewVideoUrl
    ? await bot.api.sendVideo(env.TELEGRAM_APPROVAL_CHAT_ID, a.previewVideoUrl, { caption, parse_mode: 'HTML', reply_markup: kb })
    : await bot.api.sendMessage(env.TELEGRAM_APPROVAL_CHAT_ID, caption + `\n\n<pre>${esc(a.bodyPreview.slice(0, 900))}</pre>`, { parse_mode: 'HTML', reply_markup: kb });

  await apiPost(`/approvals/${approvalId}/tg-message`, { tgMessageId: msg.message_id });
}

export async function updateApprovalCard(bot: Bot, approvalId: string, line: string) {
  const a = await apiGet(`/approvals/${approvalId}`);
  if (!a.tgMessageId) return;
  await bot.api.editMessageReplyMarkup(env.TELEGRAM_APPROVAL_CHAT_ID, a.tgMessageId).catch(() => {});
  await bot.api.sendMessage(env.TELEGRAM_APPROVAL_CHAT_ID, line, { reply_parameters: { message_id: a.tgMessageId } }).catch(() => {});
}
const esc = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
```

Notes:
- **Video previews:** Telegram fetches the presigned R2 URL server-side (≤50 MB bot-upload limit — our shorts are ~10–30 MB; if >50 MB send thumbnail photo + link instead — implement the size check via `renders.bytes`… store bytes on render upload).
- **Dashboard decisions** call `updateApprovalCard` from the API side (worker enqueues `alert.telegram`-style card-update job) so the TG message shows "✅ approved via dashboard" and loses its buttons — both surfaces always converge.
- **`approval.remind`** worker: pending >20 h → `updateApprovalCard(…, '⏰ expires in <4h')`.
- **Webhook alternative** (documented, not default): `apps/api` route `POST /api/v1/tg/webhook` with `webhookCallback(bot, 'hono')` + `TELEGRAM_WEBHOOK_SECRET`; switch when the VPS has TLS. Long-polling and webhook must never run simultaneously.

### `apps/bot/src/index.ts`

```ts
import { buildBot } from '@ve/telegram';
const bot = buildBot();
bot.start({ drop_pending_updates: true, allowed_updates: ['message', 'callback_query'] });
console.log('bot: long-polling started');
process.on('SIGTERM', () => bot.stop());
```

## 3. API endpoints backing approvals (implemented in doc 11)

- `GET /approvals?status=` — list (+card summary fields).
- `GET /approvals/:id` / `GET /approvals/:id/card` — card payload incl. presigned preview URLs, dashboardUrl, plannedSlotDisplay (from scheduler dry-run), bodyPreview.
- `POST /approvals/:id/decide` `{decision: 'approved'|'rejected'|'edit_requested', reason?, editInstructions?, via: 'telegram'|'dashboard', tgUserId?}` — the single transactional decision path (row lock; returns `{ok, raced?}`); on approve enqueues `publish.plan` fast-path; on edit enqueues `factory.script` with instructions.
- `POST /approvals/:id/tg-message` `{tgMessageId}` — bot stores the card message id.

## 4. Dashboard approvals page (parity spec — UI detail in doc 10)

Pending cards: video player (presigned), hook variants radio (a/b/c — selecting non-default hook counts as an edit that only re-renders the hook segment: v1 simplification = full re-render via edit flow), caption per platform (editable inline → PATCH before approve = `metadata-finalizer` skip), Approve / Reject(reason modal) / Request edit(textarea). Decisions POST the same `/decide` endpoint. Page live-updates via 15 s polling; a decision made on TG disappears from the pending list on next poll.

## 5. Auto-approval earn/revoke

Earn: dashboard Settings per category — human adds `formatSlug` to `categories.autoApproveFormats` (suggested by weekly digest when a format has ≥10 consecutive human approvals with zero edits/rejects — the digest computes and proposes, human clicks). Revoke: automatic on kill-list (doc 07 §3) or any compliance `pre_publish` failure for that pair; event alerts TG. Categories with mode `human_gated` (politics, football, f1) ignore auto-approve entirely — code guard in `approval.request`.

## 6. Acceptance criteria

- TG: card arrives with playable video; Approve by an allowed user schedules the post and edits the card; a second admin tapping Approve after gets "Already decided elsewhere". Non-admin taps get ⛔.
- Reject with reason via force-reply lands `rejected` + brief `abandoned` + events recorded.
- Edit flow produces script v2, a fresh render, and a **new** approval card.
- Dashboard and TG decisions race safely (simulate with two concurrent `/decide` calls in a test — exactly one wins, event log shows `race_ignored`).
- `/kill` from a non-admin id is refused; from admin flips the switch (verified by a blocked `publish.execute` in test).

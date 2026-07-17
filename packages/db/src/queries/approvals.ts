import { sql } from "drizzle-orm";
import { db } from "../client";

export interface PendingApprovalRow {
  id: string;
  briefId: string;
  status: string;
  expiresAt: Date;
  createdAt: Date;
  tgMessageId: number | null;
  categoryName: string;
  categorySlug: string;
  formatSlug: string;
  angle: string;
  trendHeadline: string | null;
  scriptId: string | null;
  hookVariants: unknown;
  chosenHook: string | null;
  perPlatformCaptions: unknown;
  bodyPreview: string | null;
  aiDisclosure: boolean | null;
  targetPlatforms: unknown;
  /** renders as [{id, platform, r2Key, thumbR2Key, bytes}] — presign at the API layer */
  renders: unknown;
}

const APPROVAL_PREVIEW_SELECT = sql`
  select
    a.id, a.brief_id as "briefId", a.status, a.expires_at as "expiresAt",
    a.created_at as "createdAt", a.tg_message_id as "tgMessageId",
    c.name as "categoryName", c.slug as "categorySlug",
    b.format_slug as "formatSlug", b.angle, b.target_platforms as "targetPlatforms",
    t.headline as "trendHeadline",
    s.id as "scriptId", s.hook_variants as "hookVariants", s.chosen_hook as "chosenHook",
    s.per_platform_captions as "perPlatformCaptions",
    left(s.body, 1200) as "bodyPreview", s.ai_disclosure as "aiDisclosure",
    coalesce((
      select json_agg(json_build_object(
        'id', r.id, 'platform', r.platform, 'r2Key', r.r2_key,
        'thumbR2Key', r.thumb_r2_key, 'bytes', r.bytes, 'durationSec', r.duration_sec
      ) order by r.created_at)
      from renders r where r.brief_id = b.id and r.status = 'done'
    ), '[]'::json) as "renders"
  from approvals a
  join briefs b on b.id = a.brief_id
  join categories c on c.id = b.category_id
  left join trends t on t.id = b.trend_id
  left join lateral (
    select * from scripts sc where sc.brief_id = b.id
    order by sc.version desc limit 1
  ) s on true
`;

/** Pending approvals with brief + latest script + done renders (doc 02 §7). Keys are presignable. */
export async function pendingApprovalsWithPreview(): Promise<PendingApprovalRow[]> {
  const rows = await db.execute(sql`
    ${APPROVAL_PREVIEW_SELECT}
    where a.status = 'pending'
    order by a.created_at asc
  `);
  return rows as unknown as PendingApprovalRow[];
}

/** Approvals filtered by status (doc 09 §3 GET /approvals?status=). */
export async function approvalsByStatus(status?: string): Promise<PendingApprovalRow[]> {
  const rows = await db.execute(sql`
    ${APPROVAL_PREVIEW_SELECT}
    ${status ? sql`where a.status = ${status}` : sql``}
    order by a.created_at desc
  `);
  return rows as unknown as PendingApprovalRow[];
}

/** One approval's full card row (any status) — backs GET /approvals/:id and /card. */
export async function approvalRowById(id: string): Promise<PendingApprovalRow | null> {
  const rows = (await db.execute(sql`
    ${APPROVAL_PREVIEW_SELECT}
    where a.id = ${id}
    limit 1
  `)) as unknown as PendingApprovalRow[];
  return rows[0] ?? null;
}

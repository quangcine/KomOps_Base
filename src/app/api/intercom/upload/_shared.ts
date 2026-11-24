import { cookies } from "next/headers";
import { staffServerClient } from "@/adapters/authServer";
import { UUID_RE, readBodyCapped } from "@/adapters/storage";
import { optionalWorkDate } from "../_shared";

/**
 * Phần dùng chung của ba route tải chia mẩu `intercom/upload/{start,part,finish}`. Tệp tiền tố `_` không thành
 * route trong App Router.
 */

export const MAX_BYTES = 2 * 1024 * 1024;
/** Trần một mẩu (máy gửi mẩu 100 KB, chừa khoảng). */
export const PART_MAX_BYTES = 160 * 1024;
/** Trần số mẩu của một ảnh (2 MB chia 100 KB là 21 mẩu). */
export const MAX_PARTS = 32;
/** Trần bytes vẫn tính lại sau giải mã. */
export const PART_TEXT_MAX_BYTES = Math.ceil(PART_MAX_BYTES / 3) * 4 + 1024;

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export function decodeBase64Part(text: string): Uint8Array | null {
  const clean = text.replace(/\s+/g, "");
  if (clean.length === 0 || clean.length % 4 !== 0 || !BASE64_PATTERN.test(clean)) return null;
  let binary: string;
  try {
    binary = atob(clean);
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
/** Trần thân JSON của `start`, `finish`. */
export const JSON_MAX_BYTES = 64 * 1024;
export const ACCEPTED_TYPE = "image/jpeg";
export const JPEG_MAGIC = [0xff, 0xd8, 0xff] as const;
export const SAVE_FAILED = "Chưa lưu được ảnh, thử lại giúp tôi.";
export const TOO_LARGE = "Ảnh vượt trần 2MB.";

export type PartKind = "photo" | "thumb";
export const PART_KINDS: readonly PartKind[] = ["photo", "thumb"];

const KINDS = ["deliver", "collect"] as const;
const SOURCES = ["camera", "library"] as const;

export type StaffSupabase = ReturnType<typeof staffServerClient>;

export type HandoverMeta = {
  handoverId: string;
  projectId: string;
  kind: (typeof KINDS)[number];
  unitIds: string[] | null;
  issueIds: string[] | null;
  personId: string | null;
  department: string | null;
  groupNo: number | null;
  source: string;
  takenAt: string | null;
  workDate: string | null;
};

/** Khoá mẩu tạm: `intercom/tmp/<handover_id>/<photo|thumb>-<i>`. */
export function tmpPartKey(handoverId: string, kind: PartKind, index: number): string {
  return `intercom/tmp/${handoverId}/${kind}-${index}`;
}

/** Cửa nguồn: chỉ nhận yêu cầu cùng gốc từ màn intercom. Sai thì trả `Response` 403. */
export function rejectForeignOrigin(req: Request): Response | null {
  const origin = req.headers.get("origin");
  if (req.headers.get("sec-fetch-site") !== "same-origin" || !origin || origin !== new URL(req.url).origin) {
    return Response.json({ error: "Chỉ lưu ảnh từ màn intercom." }, { status: 403 });
  }
  return null;
}

/** Đòi phiên đăng nhập, không kiểm quyền (quyền do RLS, hàm SQL kiểm); chưa đăng nhập thì trả `Response` 401. */
export async function requireStaff(): Promise<{ supa: StaffSupabase; userId: string } | Response> {
  const supa = staffServerClient(await cookies());
  const { data: auth } = await supa.auth.getUser();
  if (!auth?.user?.id) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  return { supa, userId: auth.user.id };
}

export function optionalUuid(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  return typeof value === "string" && UUID_RE.test(value) ? value.toLowerCase() : undefined;
}

export function optionalDimension(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 100000 ? value : undefined;
}

/** Số nguyên trong `[min, max]`; sai thì `null`. */
export function intInRange(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function uuidList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) return null;
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string" || !UUID_RE.test(v)) return null;
    out.push(v.toLowerCase());
  }
  return out;
}

/** Đọc thân JSON dạng object, có trần; sai dạng là `null`. */
export async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (contentLength > JSON_MAX_BYTES) return null;
  let text: string;
  try {
    const raw = await readBodyCapped(req, JSON_MAX_BYTES);
    if (!raw) return null;
    text = new TextDecoder().decode(raw);
  } catch {
    return null;
  }
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function parseHandoverMeta(m: Record<string, unknown>): HandoverMeta | null {
  const handoverId = optionalUuid(m.handover_id);
  const projectId = optionalUuid(m.project_id);
  if (!handoverId || !projectId) return null;
  const kind = typeof m.kind === "string" ? m.kind : "";
  if (!(KINDS as readonly string[]).includes(kind)) return null;
  const source = typeof m.source === "string" ? m.source : "";
  if (!(SOURCES as readonly string[]).includes(source)) return null;

  let unitIds: string[] | null = null;
  let issueIds: string[] | null = null;
  if (kind === "deliver") {
    unitIds = uuidList(m.unit_ids);
    if (!unitIds) return null;
  } else {
    issueIds = uuidList(m.issue_ids);
    if (!issueIds) return null;
  }
  const personId = optionalUuid(m.person_id);
  if (personId === undefined) return null;
  const department =
    m.department === undefined || m.department === null || m.department === ""
      ? null
      : typeof m.department === "string" && m.department.length <= 200
        ? m.department
        : undefined;
  if (department === undefined) return null;
  const groupNo =
    m.group_no === undefined || m.group_no === null
      ? null
      : typeof m.group_no === "number" && Number.isInteger(m.group_no) && m.group_no >= 1 && m.group_no <= 6
        ? m.group_no
        : undefined;
  if (groupNo === undefined) return null;
  const takenAt =
    m.taken_at === undefined || m.taken_at === null || m.taken_at === ""
      ? null
      : typeof m.taken_at === "string" && !Number.isNaN(Date.parse(m.taken_at))
        ? m.taken_at
        : undefined;
  if (takenAt === undefined) return null;
  const workDate = optionalWorkDate(m.work_date);
  if (workDate === undefined) return null;
  return {
    handoverId,
    projectId,
    kind: kind as HandoverMeta["kind"],
    unitIds,
    issueIds,
    personId,
    department,
    groupNo,
    source,
    takenAt,
    workDate,
  };
}

export type HandoverRow = {
  id: string;
  status: string;
  created_by: string | null;
  photo_key: string;
  thumb_key: string;
};

/** Đọc lượt qua RLS (thành viên dự án, quản lý). Lỗi đọc thì `error`; không có thì `row` null. */
export async function readHandover(
  supa: StaffSupabase,
  handoverId: string,
): Promise<{ row: HandoverRow | null; error: boolean }> {
  const { data, error } = await supa
    .from("intercom_handover")
    .select("id, status, created_by, photo_key, thumb_key")
    .eq("id", handoverId)
    .maybeSingle();
  if (error) return { row: null, error: true };
  return { row: (data ?? null) as HandoverRow | null, error: false };
}

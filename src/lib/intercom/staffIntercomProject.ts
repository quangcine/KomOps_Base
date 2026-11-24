"use client";

// Lời gọi phía trình duyệt cho màn Dự án của intercom.
// - Đọc danh sách dự án kèm số tai, số người: đọc bảng qua RLS.
// Tên tham số RPC là KHOÁ object: sai tên thì `tsc` xanh mà chạy lỗi `PGRST202`.

import { staffClient } from "@/adapters/auth";
import { orderRpcError, type IntercomProject, type IntercomUnit } from "./staffIntercom";
import type { StorageChoice } from "./staffIntercomDrive";

/** Mã tai kèm ghi chú tem của bộ. */
export type IntercomUnitWithNote = IntercomUnit & { tag_note: string | null };

/** Một dòng danh sách dự án: dự án cộng số tai, số người. */
export type IntercomProjectSummary = IntercomProject & { unit_count: number; person_count: number };

/** Kết quả dán nhiều người. `invalid`: số dòng (1 trở đi, theo thứ tự gửi) kèm lý do. */
export type IntercomBulkAddResult = {
  added: number;
  skipped: number;
  invalid: { row: number; reason: string }[];
};

/** Kết quả bỏ mã: mã đã bỏ và mã bị từ chối (đã từng giao). */
export type IntercomUnitRemoveResult = { removed: string[]; rejected: string[] };

/** Trần số mã của bộ CHƯA gắn Model. */
export const INTERCOM_UNIT_SET_MAX = 20;
/** Ghi chú tem tối đa bao nhiêu ký tự (bảng `intercom_unit_set`). */
export const INTERCOM_TAG_NOTE_MAX = 60;
/** Dán nhiều người: tối đa bao nhiêu dòng một lượt. */
export const INTERCOM_BULK_PEOPLE_MAX = 300;
/** Tên dự án, tên người tối đa bao nhiêu ký tự. */
export const INTERCOM_NAME_MAX = 120;
/** Ô số điện thoại tối đa bao nhiêu ký tự gõ. */
export const INTERCOM_PHONE_INPUT_MAX = 20;
/** Câu báo số sai, cùng chữ với hàm SQL `intercom_person_create`, `intercom_person_update`. */
export const INTERCOM_PHONE_ERROR = "Số điện thoại cần 10 số, bắt đầu bằng 0 hoặc +84.";

/**
 * Chuẩn hoá số điện thoại người cầm tai, cùng luật `_intercom_phone_normalize`: bỏ dấu cách, chấm, gạch, ngoặc;
 * `+84`/`84` cộng 9 số thì đổi thành `0` cộng 9 số; đúng 9 số đầu khác 0 thì thêm `0`. Trả `""` khi rỗng (không
 * có số), số dạng `0` cộng 9 chữ số khi đúng, `null` khi sai.
 */
export function normalizeIntercomPhone(raw: string): string | null {
  const digits = raw.replace(/[\s.()-]/g, "");
  if (digits === "") return "";
  let normalized = digits;
  if (/^\+?84[0-9]{9}$/.test(digits)) normalized = `0${digits.slice(-9)}`;
  else if (/^[1-9][0-9]{8}$/.test(digits)) normalized = `0${digits}`;
  return /^0[1-9][0-9]{8}$/.test(normalized) ? normalized : null;
}

const PROJECT_COLUMNS = "id, name, start_date, end_date, group_count, day_count, share_token, share_revoked_at, cover_key";

type EmbeddedCount = { count?: unknown }[] | null | undefined;

function embeddedCount(value: EmbeddedCount): number {
  const n = Array.isArray(value) ? value[0]?.count : undefined;
  return typeof n === "number" ? n : 0;
}

/** Mọi dự án, mới nhất trước, kèm số tai, số người (đếm nhúng trong một câu, không đọc trọn bảng con). */
export async function listIntercomProjectSummaries(): Promise<IntercomProjectSummary[]> {
  const { data, error } = await staffClient()
    .from("intercom_project")
    .select(`${PROJECT_COLUMNS}, units:intercom_unit(count), people:intercom_person(count)`)
    .order("start_date", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw orderRpcError(error, "Chưa tải được danh sách dự án.");
  type Row = IntercomProject & { units?: EmbeddedCount; people?: EmbeddedCount };
  return ((data ?? []) as unknown as Row[]).map(({ units, people, ...p }) => ({
    ...p,
    unit_count: embeddedCount(units),
    person_count: embeddedCount(people),
  }));
}

/** Khoá ảnh dự án, đọc qua RLS (`board.project` không có cột này). Chưa có ảnh hoặc không thấy dự án: `null`. */
export async function getIntercomProjectCoverKey(projectId: string): Promise<string | null> {
  const { data, error } = await staffClient().from("intercom_project").select("cover_key").eq("id", projectId).maybeSingle();
  if (error) throw orderRpcError(error, "Chưa đọc được ảnh dự án.");
  const key = (data as { cover_key?: unknown } | null)?.cover_key;
  return typeof key === "string" ? key : null;
}

export type IntercomProjectInput = { name: string; startDate: string; dayCount: number; groupCount: number };

/**
 * Tạo dự án, trả id. Nơi lưu bắt buộc: `drive` kèm tài khoản là chọn tài khoản có sẵn, `drive_new` gửi `drive`
 * không tài khoản ("Thêm Drive", dự án chưa nối xong tới khi nối Google).
 */
export async function createIntercomProject(input: IntercomProjectInput, storage: StorageChoice): Promise<string> {
  const { data, error } = await staffClient().rpc("intercom_project_create", {
    p_name: input.name,
    p_start_date: input.startDate,
    p_day_count: input.dayCount,
    p_group_count: input.groupCount,
    p_storage: storage.kind === "r2" ? "r2" : "drive",
    p_drive_account: storage.kind === "drive" ? storage.accountId : null,
  });
  if (error) throw orderRpcError(error, "Chưa tạo được dự án.");
  if (typeof data !== "string" || data === "") throw new Error("Chưa tạo được dự án.");
  return data;
}

/** Sửa dự án; rút ngày còn lượt giao ngoài khoảng, giảm nhóm còn người hoặc lượt vướng thì NÉM câu của máy chủ. */
export async function updateIntercomProject(projectId: string, input: IntercomProjectInput): Promise<IntercomProject> {
  const { data, error } = await staffClient().rpc("intercom_project_update", {
    p_project: projectId,
    p_name: input.name,
    p_start_date: input.startDate,
    p_day_count: input.dayCount,
    p_group_count: input.groupCount,
  });
  if (error) throw orderRpcError(error, "Chưa sửa được dự án.");
  return data as IntercomProject;
}

/** Model, cờ, giờ của bộ mới. Giờ điền sẵn từ Model ở form, người dùng sửa được. */
export type IntercomUnitSetModelInput = {
  modelId: string;
  hasMaster: boolean;
  isHub: boolean;
  unitHours: number;
  masterMin: number | null;
  masterMax: number | null;
  hubHours: number | null;
};

/**
 * Thêm bộ mã (hoặc thêm số còn thiếu của bộ đã có tới `count`), trả các mã vừa tạo. Bộ có tai chủ: `count` gồm
 * cả tai chủ `M`. Bộ đã có: máy chủ bỏ qua `model`, giữ Model, giờ của bộ; trần theo Model đã gắn.
 */
export async function addIntercomUnitSet(input: {
  projectId: string;
  prefix: string;
  count: number;
  tagNote: string;
  model?: IntercomUnitSetModelInput;
}): Promise<IntercomUnit[]> {
  const m = input.model;
  const { data, error } = await staffClient().rpc("intercom_unit_set_add", {
    p_project: input.projectId,
    p_prefix: input.prefix,
    p_count: input.count,
    p_tag_note: input.tagNote,
    ...(m
      ? {
          p_model: m.modelId,
          p_has_master: m.hasMaster,
          p_is_hub: m.isHub,
          p_unit_hours: m.unitHours,
          p_master_min: m.hasMaster ? m.masterMin : null,
          p_master_max: m.hasMaster ? m.masterMax : null,
          p_hub_hours: m.isHub ? m.hubHours : null,
        }
      : {}),
  });
  if (error) throw orderRpcError(error, "Chưa thêm được bộ mã.");
  return (Array.isArray(data) ? data : []) as IntercomUnit[];
}

/**
 * Sửa một bộ: ghi chú tem (chuỗi rỗng là bỏ ghi chú), Model, giờ. Model, giờ `null` hoặc bỏ trống là giữ nguyên.
 * Bộ đang có nhiều mã hơn trần của Model mới thì máy chủ từ chối, câu báo nêu số mã và trần.
 */
export async function updateIntercomUnitSet(input: {
  projectId: string;
  prefix: string;
  tagNote: string;
  modelId?: string | null;
  unitHours?: number | null;
  masterMin?: number | null;
  masterMax?: number | null;
  hubHours?: number | null;
}): Promise<void> {
  const { error } = await staffClient().rpc("intercom_unit_set_update", {
    p_project: input.projectId,
    p_prefix: input.prefix,
    p_tag_note: input.tagNote,
    p_model: input.modelId ?? null,
    p_unit_hours: input.unitHours ?? null,
    p_master_min: input.masterMin ?? null,
    p_master_max: input.masterMax ?? null,
    p_hub_hours: input.hubHours ?? null,
  });
  if (error) throw orderRpcError(error, "Chưa sửa được bộ mã.");
}

function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Bỏ các mã chưa từng giao (cùng một dự án). Mã đã từng giao bị từ chối, trả về trong `rejected`. */
export async function removeIntercomUnits(unitIds: string[]): Promise<IntercomUnitRemoveResult> {
  const { data, error } = await staffClient().rpc("intercom_unit_remove", { p_unit_ids: unitIds });
  if (error) throw orderRpcError(error, "Chưa bỏ được mã.");
  const row = (data ?? {}) as { removed?: unknown; rejected?: unknown };
  return { removed: textArray(row.removed), rejected: textArray(row.rejected) };
}

/** Sửa tên, bộ phận, nhóm, số điện thoại của một người; trùng tên người khác trong dự án thì NÉM. */
export async function updateIntercomPerson(input: {
  personId: string;
  fullName: string;
  department: string;
  group: number;
  phone: string;
}): Promise<void> {
  const { error } = await staffClient().rpc("intercom_person_update", {
    p_person: input.personId,
    p_full_name: input.fullName,
    p_department: input.department,
    p_group: input.group,
    p_phone: input.phone,
  });
  if (error) throw orderRpcError(error, "Chưa sửa được người nhận.");
}

export type IntercomPersonRow = { full_name: string; department: string; group_no: number | string };

/** Thêm nhiều người một lượt (tối đa 300 dòng). Tên trùng người đã có thì bỏ qua. */
export async function bulkAddIntercomPeople(projectId: string, rows: IntercomPersonRow[]): Promise<IntercomBulkAddResult> {
  const { data, error } = await staffClient().rpc("intercom_person_bulk_add", { p_project: projectId, p_rows: rows });
  if (error) throw orderRpcError(error, "Chưa thêm được danh sách người.");
  const row = (data ?? {}) as { added?: unknown; skipped?: unknown; invalid?: unknown };
  const invalid = Array.isArray(row.invalid)
    ? row.invalid.map((item) => {
        const it = (item ?? {}) as { row?: unknown; reason?: unknown };
        return { row: Number(it.row ?? 0), reason: typeof it.reason === "string" ? it.reason : "" };
      })
    : [];
  return { added: Number(row.added ?? 0), skipped: Number(row.skipped ?? 0), invalid };
}

/** Khoá so tên trùng, cùng luật máy chủ (`lower(btrim(...))`): để màn xem trước khớp kết quả Lưu. */
export function intercomNameKey(name: string): string {
  return name.trim().toLowerCase();
}

// Người nạp từ Google Sheet

/**
 * Dòng `intercom_people_sheet` của dự án (đọc qua RLS cho thành viên). `loaded_at` có giá trị là "đã có danh
 * sách".
 */
export type IntercomPeopleSheet = {
  project_id: string;
  kind: "template" | "link";
  file_id: string;
  gid: string | null;
  template_file_id: string | null;
  template_account_id: string | null;
  edit_closed_reason: "ended" | "replaced" | null;
  loaded_at: string | null;
};

/** Sheet người của dự án; chưa có thì `null`. Lỗi thì ném. */
export async function getIntercomPeopleSheet(projectId: string): Promise<IntercomPeopleSheet | null> {
  const { data, error } = await staffClient()
    .from("intercom_people_sheet")
    .select("project_id, kind, file_id, gid, template_file_id, template_account_id, edit_closed_reason, loaded_at")
    .eq("project_id", projectId)
    .maybeSingle();
  if (error) throw orderRpcError(error, "Chưa đọc được Sheet danh sách người.");
  return (data ?? null) as IntercomPeopleSheet | null;
}

/** Link mở Sheet: file mẫu mở trang sửa, link khách dán dựng lại từ mã và trang tính. */
export function intercomPeopleSheetUrl(sheet: Pick<IntercomPeopleSheet, "kind" | "file_id" | "gid">): string {
  const base = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheet.file_id)}/edit`;
  return sheet.kind === "link" && sheet.gid ? `${base}#gid=${encodeURIComponent(sheet.gid)}` : base;
}

/** Một dòng gửi `intercom_person_sheet_apply`; `phone` rỗng là ô trống. */
export type IntercomSheetApplyRow = { full_name: string; department: string; group_no: string; phone: string };

/** Kết quả Ghi. `invalid.row` là thứ tự trong mảng đã gửi (1 trở đi). */
export type IntercomSheetApplyResult = {
  added: number;
  updated: number;
  skipped: number;
  invalid: { row: number; reason: string }[];
};

/** Lỗi thì ném câu máy chủ. */
export async function applyIntercomPeopleSheet(
  projectId: string,
  rows: IntercomSheetApplyRow[],
  overwriteIds: string[],
): Promise<IntercomSheetApplyResult> {
  const { data, error } = await staffClient().rpc("intercom_person_sheet_apply", {
    p_project: projectId,
    p_rows: rows,
    p_overwrite: overwriteIds,
  });
  if (error) throw orderRpcError(error, "Chưa ghi được danh sách người.");
  const row = (data ?? {}) as { added?: unknown; updated?: unknown; skipped?: unknown; invalid?: unknown };
  const invalid = Array.isArray(row.invalid)
    ? row.invalid.map((item) => {
        const it = (item ?? {}) as { row?: unknown; reason?: unknown };
        return { row: Number(it.row ?? 0), reason: typeof it.reason === "string" ? it.reason : "" };
      })
    : [];
  return { added: Number(row.added ?? 0), updated: Number(row.updated ?? 0), skipped: Number(row.skipped ?? 0), invalid };
}

/** Lỗi của route Sheet: kèm `reason` máy chủ trả để màn chọn câu. */
export class IntercomPeopleSheetError extends Error {
  readonly reason: string | null;
  constructor(message: string, reason: string | null) {
    super(message);
    this.name = "IntercomPeopleSheetError";
    this.reason = reason;
  }
}

async function callPeopleSheetRoute(
  projectId: string,
  init: RequestInit,
  fallback: string,
  query = "",
): Promise<Record<string, unknown>> {
  const res = await fetch(`/api/intercom/people-sheet/${projectId}${query}`, { credentials: "same-origin", ...init });
  let json: Record<string, unknown> = {};
  try {
    const value: unknown = await res.json();
    if (value && typeof value === "object" && !Array.isArray(value)) json = value as Record<string, unknown>;
  } catch {
    // Phản hồi không phải JSON: dùng câu mặc định.
  }
  if (!res.ok) {
    throw new IntercomPeopleSheetError(
      typeof json.error === "string" ? json.error : fallback,
      typeof json.reason === "string" ? json.reason : null,
    );
  }
  return json;
}

function postPeopleSheet(projectId: string, body: Record<string, unknown>, fallback: string): Promise<Record<string, unknown>> {
  return callPeopleSheetRoute(
    projectId,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    fallback,
  );
}

/**
 * Tạo Sheet mẫu trong thư mục Drive của dự án. `share`: `ok` là đã mở "ai có link đều sửa"; `cannot_share` là
 * tài khoản Google không cho mở link công khai; `failed` là chưa mở được, thử lại sau.
 */
export async function createIntercomPeopleSheetTemplate(projectId: string): Promise<{ share: "ok" | "cannot_share" | "failed" }> {
  const json = await postPeopleSheet(projectId, { action: "create_template" }, "Chưa tạo được Sheet mẫu, thử lại giúp tôi.");
  const share = json.share === "ok" || json.share === "cannot_share" ? json.share : "failed";
  return { share };
}

/**
 * Dán link Sheet (hoặc thay link cũ, thay file mẫu). Máy chủ đọc thử một lần; chưa công khai thì ném lỗi
 * `reason: not_public`.
 */
export async function setIntercomPeopleSheetLink(projectId: string, url: string): Promise<void> {
  await postPeopleSheet(projectId, { action: "set_link", url }, "Chưa lưu được link Sheet, thử lại giúp tôi.");
}

/** Đọc Sheet: hàng tiêu đề và các dòng (tối đa 300). Lỗi thì ném kèm `reason`. */
export async function readIntercomPeopleSheet(projectId: string): Promise<{ header: string[]; rows: string[][] }> {
  const json = await callPeopleSheetRoute(projectId, { method: "GET" }, "Chưa đọc được Sheet, thử lại giúp tôi.", "?action=read");
  const asCells = (value: unknown): string[] => (Array.isArray(value) ? value.map((cell) => (typeof cell === "string" ? cell : "")) : []);
  return { header: asCells(json.header), rows: Array.isArray(json.rows) ? json.rows.map(asCells) : [] };
}

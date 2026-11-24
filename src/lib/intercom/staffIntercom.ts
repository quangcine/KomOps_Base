"use client";

// Lời gọi phía trình duyệt cho mini app giao nhận intercom.
// - Đọc danh sách (dự án, người, mã tai, tai đang ở ngoài): đọc bảng qua RLS bằng `staffClient()`. Hàm theo dự án
// báo `42501` với người ngoài dự án: lời gọi dưới đây đổi thành câu `INTERCOM_NOT_MEMBER_TEXT`.
// - Tạo dự án từ đơn: `intercom_order_candidates`, `intercom_order_prefill`, `intercom_project_apply_order`.
// - Link khách: `intercom_share_board` gọi bằng client KHÔNG phiên (`createWebClient`), không mang cookie nhân
// viên.
// - Lưu một lượt: TẢI CHIA MẨU `/api/intercom/upload/{start,part,finish}`, mẩu 64 KB (chữ base64) gửi tuần tự.
// Đường cũ MỘT request multipart `/api/intercom/photo` giữ làm dự phòng (`uploadIntercomHandoverSingle`).
// `handover_id` máy sinh một lần mỗi lượt, gửi lại đúng id đó khi Thử lại: lượt đã lưu thì route trả
// `already_done`.
// Tên tham số RPC là KHOÁ object: sai tên thì `tsc` xanh mà chạy lỗi `PGRST202`.

import { createWebClient, staffClient } from "@/adapters/auth";
import { APP_ORIGIN } from "@/adapters/brand";
import { currentIntercomDeviceInfo, recordIntercomUploadLog } from "./staffIntercomMonitor";

export type IntercomKind = "deliver" | "collect";
export type IntercomSource = "camera" | "library";
export type IntercomPhotoSize = "thumb" | "full";

/** Một dòng `intercom_project`. `share_token`, `share_revoked_at` chỉ có ở phía nhân viên. */
export type IntercomProject = {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  group_count: number;
  day_count: number;
  share_token?: string | null;
  share_revoked_at?: string | null;
  /** Khoá ảnh ngang; chỉ danh sách dự án đọc cột này, `board.project` không có. */
  cover_key?: string | null;
  /** Nơi lưu ảnh lượt; chỉ `listIntercomProjects` đọc cột này, `board.project` không có. */
  storage_kind?: "r2" | "drive";
};

/** `seq = 0` là tai chủ, mã `<prefix>M`. `is_master` chỉ `_intercom_board_json` trả. */
export type IntercomUnit = { id: string; prefix: string; seq: number; code: string; is_master?: boolean };

/**
 * Một bộ mã trong `board.sets`: Model, cờ tai chủ, cờ Hub. Bốn ô giờ chỉ nhánh nhân viên (`intercom_board`) trả;
 * trang khách không có các khoá này. Bộ cũ chưa gắn Model thì `model_id`, `model_name`, giờ là null.
 */
export type IntercomUnitSetInfo = {
  prefix: string;
  model_id: string | null;
  model_name: string | null;
  is_hub: boolean;
  has_master: boolean;
  unit_hours?: number | null;
  master_hours_min?: number | null;
  master_hours_max?: number | null;
  hub_hours?: number | null;
};

export type IntercomPerson = {
  id: string;
  full_name: string;
  department: string;
  group_no: number;
  /**
   * Số điện thoại dạng `0` cộng 9 số; null là chưa có. Chỉ `intercom_board` (nhân viên) trả; trang khách,
   * `listIntercomPeople` không có khoá này.
   */
  phone?: string | null;
};

/**
 * Một lần tai ra ngoài. `collect_handover_id` null là tai còn ở ngoài. `day_number` = ngày thứ mấy của dự án (1
 * trở đi).
 */
export type IntercomIssue = {
  id: string;
  unit_id: string;
  unit_code: string;
  work_date: string;
  day_number: number;
  person_id: string | null;
  department: string;
  group_no: number;
  deliver_handover_id: string;
  collect_handover_id: string | null;
  collected_at: string | null;
  /** Tình trạng lúc thu: null là Bình thường; có chữ là Lỗi kèm lý do. */
  fault_reason?: string | null;
};

/**
 * Một lượt đã lưu (`done`): ảnh của ô Ảnh giao, Ảnh nhận. Ảnh nhận đi theo ngày giao của tai (nối qua
 * `IntercomIssue`).
 */
export type IntercomHandover = {
  id: string;
  kind: IntercomKind;
  work_date: string;
  person_id: string | null;
  department: string | null;
  group_no: number | null;
  taken_at: string;
  created_at: string;
};

/** `today` là ngày VN của máy chủ. */
export type IntercomBoard = {
  project: IntercomProject;
  today: string;
  units: IntercomUnit[];
  sets: IntercomUnitSetInfo[];
  people: IntercomPerson[];
  issues: IntercomIssue[];
  handovers: IntercomHandover[];
};

/** Tai đang ở ngoài cho tab Nhận: dòng `intercom_issue` chưa thu, kèm mã tai. */
export type IntercomOpenIssue = {
  id: string;
  unit_id: string;
  unit_code: string;
  work_date: string;
  person_id: string | null;
  department: string;
  group_no: number;
};

/** Kết quả một lượt: `codes` mã đã lưu; `already_collected` (lượt thu) mã đã có người thu trước. */
export type IntercomHandoverResult = {
  handover_id: string;
  kind: IntercomKind;
  codes: string[];
  already_collected: string[];
};

/**
 * `meta` gửi route `/api/intercom/photo`. Giao: `unit_ids` cộng `person_id` HOẶC `department` và `group_no`.
 * Thu: `issue_ids`.
 */
export type IntercomUploadMeta = {
  handover_id: string;
  project_id: string;
  kind: IntercomKind;
  unit_ids?: string[];
  issue_ids?: string[];
  person_id?: string | null;
  department?: string | null;
  group_no?: number | null;
  source: IntercomSource;
  /** ISO 8601; ảnh thư viện có giờ chụp thì gửi để lượt giao về đúng ngày VN của ảnh. */
  taken_at?: string | null;
  work_date?: string | null;
  width?: number | null;
  height?: number | null;
};

/**
 * Phản hồi route lưu ảnh. `ok` false: `error` là câu tiếng Việt của route hoặc của hàm (mã ở ngoài, đã có người
 * thu...).
 */
export type IntercomUploadReply = {
  ok: boolean;
  status: number;
  alreadyDone: boolean;
  result: IntercomHandoverResult | null;
  error: string | null;
};

const PHOTO_ROUTE = "/api/intercom/photo";
const SHARE_PHOTO_ROUTE = "/api/intercom/share-photo";
/** Gốc link khách gửi ra ngoài. */
export const INTERCOM_SHARE_ORIGIN = APP_ORIGIN;

const PROJECT_COLUMNS = "id, name, start_date, end_date, group_count, day_count, share_token, share_revoked_at, storage_kind";

/**
 * Câu báo khi hàm theo dự án trả `42501`: người dùng không còn trong danh sách thành viên (bị bỏ khi đang mở
 * màn).
 */
export const INTERCOM_NOT_MEMBER_TEXT = "Bạn không còn là thành viên dự án này.";

const INTERCOM_NO_CONNECTION_TEXT = "Chưa kết nối được máy chủ, kiểm tra mạng rồi thử lại.";

/**
 * Lỗi của hàm nhận `p_project` (kiểm thành viên qua `intercom_can_access`): `42501` đổi thành
 * `INTERCOM_NOT_MEMBER_TEXT`; lỗi không có mã (chưa tới được máy chủ, hoặc phản hồi lỗi không mang `code`) đổi
 * thành `INTERCOM_NO_CONNECTION_TEXT`, như `orderRpcError`.
 */
function projectRpcError(error: { code?: string; message?: string }, fallback: string): Error {
  if (error.code === "42501") return new Error(INTERCOM_NOT_MEMBER_TEXT);
  if (!error.code) return new Error(INTERCOM_NO_CONNECTION_TEXT);
  return new Error(error.message || fallback);
}

/**
 * Câu route trả khi lượt chụp thuộc người khác (cũng `403` kèm `reason: "permission"`): không phải ca mất thành
 * viên.
 */
const OTHER_USER_HANDOVER_TEXT = "Lượt chụp này của người khác";

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function toResult(value: unknown): IntercomHandoverResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  return {
    handover_id: typeof r.handover_id === "string" ? r.handover_id : "",
    kind: r.kind === "collect" ? "collect" : "deliver",
    codes: textList(r.codes),
    already_collected: textList(r.already_collected),
  };
}

// Đọc (RLS thành viên)

/** Mọi dự án, mới nhất trước. */
export async function listIntercomProjects(): Promise<IntercomProject[]> {
  const { data, error } = await staffClient()
    .from("intercom_project")
    .select(PROJECT_COLUMNS)
    .order("start_date", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message || "Chưa tải được danh sách dự án.");
  return (data ?? []) as IntercomProject[];
}

/** Người nhận của dự án, theo Nhóm, Bộ phận, tên. */
export async function listIntercomPeople(projectId: string): Promise<IntercomPerson[]> {
  const { data, error } = await staffClient()
    .from("intercom_person")
    .select("id, full_name, department, group_no")
    .eq("project_id", projectId)
    .order("group_no")
    .order("department")
    .order("full_name");
  if (error) throw new Error(error.message || "Chưa tải được danh sách người nhận.");
  return (data ?? []) as IntercomPerson[];
}

/** Mã tai của dự án, theo Prefix rồi số. */
export async function listIntercomUnits(projectId: string): Promise<IntercomUnit[]> {
  const { data, error } = await staffClient()
    .from("intercom_unit")
    .select("id, prefix, seq, code")
    .eq("project_id", projectId)
    .order("prefix")
    .order("seq");
  if (error) throw new Error(error.message || "Chưa tải được danh sách mã tai.");
  return (data ?? []) as IntercomUnit[];
}

/** Tai đang ở ngoài (mọi ngày, chưa thu) cho tab Nhận và để làm mờ mã ở lưới Giao. */
export async function listOpenIntercomIssues(projectId: string): Promise<IntercomOpenIssue[]> {
  const { data, error } = await staffClient()
    .from("intercom_issue")
    .select("id, unit_id, work_date, person_id, department, group_no, intercom_unit(code)")
    .eq("project_id", projectId)
    .is("collect_handover_id", null)
    .order("work_date");
  if (error) throw new Error(error.message || "Chưa tải được danh sách tai đang ở ngoài.");
  return ((data ?? []) as Record<string, unknown>[]).map((row) => {
    const unit = row.intercom_unit as { code?: unknown } | { code?: unknown }[] | null;
    const code = Array.isArray(unit) ? unit[0]?.code : unit?.code;
    return {
      id: String(row.id ?? ""),
      unit_id: String(row.unit_id ?? ""),
      unit_code: typeof code === "string" ? code : "",
      work_date: String(row.work_date ?? ""),
      person_id: typeof row.person_id === "string" ? row.person_id : null,
      department: String(row.department ?? ""),
      group_no: Number(row.group_no ?? 0),
    };
  });
}

/** Dữ liệu dashboard của một dự án (nhân viên; kèm `share_token`, `share_revoked_at` trong `project`). */
export async function getIntercomBoard(projectId: string): Promise<IntercomBoard> {
  const { data, error } = await staffClient().rpc("intercom_board", { p_project: projectId });
  if (error) throw projectRpcError(error, "Chưa tải được dashboard.");
  return data as IntercomBoard;
}

/** Dữ liệu dashboard qua link khách. Mã sai hoặc đã thu hồi: `null` (một dòng "Link không còn hiệu lực"). */
export async function getIntercomShareBoard(token: string): Promise<IntercomBoard | null> {
  const { data, error } = await createWebClient().rpc("intercom_share_board", { p_token: token });
  if (error) throw new Error(error.message || "Chưa tải được dashboard.");
  return (data ?? null) as IntercomBoard | null;
}

/**
 * Thêm người nhận từ màn chụp; trùng tên trong dự án thì trả id sẵn có (người cũ chưa có số thì máy chủ điền
 * `phone`). Trả id người nhận.
 */
export async function createIntercomPerson(input: {
  projectId: string;
  fullName: string;
  department: string;
  group: number;
  phone?: string | null;
}): Promise<string> {
  const { data, error } = await staffClient().rpc("intercom_person_create", {
    p_project: input.projectId,
    p_full_name: input.fullName,
    p_department: input.department,
    p_group: input.group,
    p_phone: input.phone || null,
  });
  if (error) throw projectRpcError(error, "Chưa thêm được người nhận.");
  if (typeof data !== "string" || data === "") throw new Error("Chưa thêm được người nhận.");
  return data;
}

/** Lý do Lỗi tối đa bao nhiêu ký tự. */
export const INTERCOM_FAULT_REASON_MAX = 200;

/** Ghi tai Lỗi lúc thu; chỉ nhận tai đã thu. Gọi sau khi lượt thu đã lưu xong. */
export async function markIntercomIssueFault(issueId: string, reason: string): Promise<void> {
  const { error } = await staffClient().rpc("intercom_issue_mark_fault", { p_issue: issueId, p_reason: reason });
  if (error) throw new Error(error.message || "Chưa ghi được tình trạng Lỗi.");
}

/**
 * Điền tên sau cho lượt giao chưa rõ tên: gán lượt giao đã lưu sang người của cùng dự án; bộ phận, nhóm theo
 * người.
 */
export async function setIntercomHandoverPerson(input: { handoverId: string; personId: string }): Promise<void> {
  const { error } = await staffClient().rpc("intercom_handover_set_person", {
    p_handover: input.handoverId,
    p_person: input.personId,
  });
  if (error) throw new Error(error.message || "Chưa điền được tên.");
}

/**
 * Sửa lượt giao, thêm tai: thêm mã vào lượt giao đã lưu, cùng người hoặc bộ phận, cùng ảnh; chỉ thêm, không bớt.
 * RPC `intercom_handover_add_units` bỏ qua mã đã có trong lượt, chặn mã đang ở ngoài (lỗi kèm mã). Trả mã đã
 * thêm.
 */
export async function addIntercomHandoverUnits(input: { handoverId: string; unitIds: string[] }): Promise<string[]> {
  const { data, error } = await staffClient().rpc("intercom_handover_add_units", {
    p_handover: input.handoverId,
    p_unit_ids: input.unitIds,
  });
  if (error) throw new Error(error.message || "Chưa thêm được mã tai.");
  const codes = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>).codes : null;
  return textList(codes);
}

/**
 * Người này có được xoá lượt không. Hỏi RPC `intercom_can_delete`; lỗi thì trả `false` (ĐÓNG: không hiện nút).
 * Máy chủ vẫn tự chặn trong RPC xoá.
 */
export async function canDeleteIntercomHandover(): Promise<boolean> {
  const { data, error } = await staffClient().rpc("intercom_can_delete");
  if (error) return false;
  return data === true;
}

/** Xoá một lượt: `DELETE /api/intercom/photo/<handover_id>`. Lỗi thì NÉM kèm câu của máy chủ. */
export async function deleteIntercomHandover(handoverId: string): Promise<void> {
  const res = await fetch(`${PHOTO_ROUTE}/${handoverId}`, { method: "DELETE", credentials: "same-origin" });
  if (res.ok) return;
  let message = "";
  try {
    const data: unknown = await res.json();
    if (data && typeof data === "object" && "error" in data && typeof data.error === "string") message = data.error;
  } catch {
    // Thân hỏng hoặc không phải JSON: dùng câu chung ở dưới.
  }
  throw new Error(message || "Chưa xoá được lượt, thử lại giúp tôi.");
}

/**
 * Xoá một người cùng MỌI lượt giao, thu của người đó ở mọi ngày: `DELETE /api/intercom/person/<person_id>`. Lỗi
 * thì NÉM kèm câu của máy chủ.
 */
export async function deleteIntercomPerson(personId: string): Promise<void> {
  const res = await fetch(`/api/intercom/person/${personId}`, { method: "DELETE", credentials: "same-origin" });
  if (res.ok) return;
  let message = "";
  try {
    const data: unknown = await res.json();
    if (data && typeof data === "object" && "error" in data && typeof data.error === "string") message = data.error;
  } catch {
    // Thân hỏng hoặc không phải JSON: dùng câu chung ở dưới.
  }
  throw new Error(message || "Chưa xoá được người này, thử lại giúp tôi.");
}

// Thành viên dự án

export type IntercomAccess = { is_manager: boolean; project_count: number };

/** Một thành viên dự án. */
export type IntercomMember = {
  profile_id: string;
  name: string;
  is_staff: boolean;
  has_login: boolean;
  source: "order" | "manual" | "backfill" | "creator";
  added_at: string;
};

export type IntercomMemberCandidate = {
  profile_id: string;
  name: string;
  roles: string[];
  is_staff: boolean;
  has_login: boolean;
};

function asRecordList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v))
    : [];
}

/** Quyền vào mini app của người đang đăng nhập. Lỗi thì NÉM (cửa vào tự hiện nút Thử lại). */
export async function getIntercomAccess(): Promise<IntercomAccess> {
  const { data, error } = await staffClient().rpc("intercom_my_access");
  if (error) throw new Error(error.message || "Chưa kiểm tra được quyền intercom.");
  const raw = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  return {
    is_manager: raw.is_manager === true,
    project_count: typeof raw.project_count === "number" ? raw.project_count : 0,
  };
}

/** Thành viên một dự án, theo tên. Người ngoài dự án: máy chủ báo "Không tìm thấy dự án" (`P0002`). */
export async function listIntercomMembers(projectId: string): Promise<IntercomMember[]> {
  const { data, error } = await staffClient().rpc("intercom_member_list", { p_project: projectId });
  if (error) throw projectRpcError(error, "Chưa tải được danh sách kỹ thuật.");
  return asRecordList(data).map((r) => ({
    profile_id: String(r.profile_id ?? ""),
    name: typeof r.name === "string" ? r.name : "",
    is_staff: r.is_staff === true,
    has_login: r.has_login === true,
    source:
      r.source === "order" || r.source === "backfill" || r.source === "creator" ? r.source : "manual",
    added_at: typeof r.added_at === "string" ? r.added_at : "",
  }));
}

/**
 * Trả số dòng thêm MỚI: hồ sơ đã xoá, ngoài nhóm được thêm hay đã là thành viên thì máy chủ bỏ qua, màn so với
 * số người đã chọn để báo lại.
 */
export async function addIntercomMembers(projectId: string, profileIds: string[]): Promise<number> {
  const { data, error } = await staffClient().rpc("intercom_member_add", {
    p_project: projectId,
    p_profile_ids: profileIds,
    p_source: "manual",
  });
  if (error) throw new Error(error.message || "Chưa thêm được kỹ thuật.");
  return typeof data === "number" ? data : 0;
}

/** Bỏ một thành viên (cùng quyền với Thêm). Không chặn tự bỏ mình hay bỏ người cuối. */
export async function removeIntercomMember(projectId: string, profileId: string): Promise<void> {
  const { error } = await staffClient().rpc("intercom_member_remove", {
    p_project: projectId,
    p_profile_id: profileId,
  });
  if (error) throw new Error(error.message || "Chưa bỏ được kỹ thuật.");
}

export async function searchIntercomMemberCandidates(search: string): Promise<IntercomMemberCandidate[]> {
  const { data, error } = await staffClient().rpc("intercom_member_candidates", { p_search: search });
  if (error) throw new Error(error.message || "Chưa tìm được người.");
  return asRecordList(data).map((r) => ({
    profile_id: String(r.profile_id ?? ""),
    name: typeof r.name === "string" ? r.name : "",
    roles: textList(r.roles),
    is_staff: r.is_staff === true,
    has_login: r.has_login === true,
  }));
}

/** `unit_count` null là đơn có dòng thiếu biến thể, chưa rõ số tai. */
export type IntercomOrderCandidate = {
  order_id: string;
  display_code: string;
  start_date: string | null;
  end_date: string | null;
  status: string;
  customer_name: string | null;
  customer_code: string | null;
  unit_count: number | null;
  linked_project_id: string | null;
  linked_project_name: string | null;
};

/** Một người gợi ý từ đơn. */
export type IntercomOrderDraftMember = {
  profile_id: string;
  name: string;
  is_staff: boolean;
  has_login: boolean;
  eligible: boolean;
};

/** Dữ liệu điền sẵn form tạo dự án từ một đơn. */
export type IntercomOrderDraft = {
  order_id: string;
  display_code: string;
  name: string;
  start_date: string | null;
  end_date: string | null;
  day_count: number;
  date_warning: boolean;
  customer_code: string | null;
  customer_name: string | null;
  unit_count: number | null;
  units_by_model: { model_name: string; unit_count: number }[];
  members: IntercomOrderDraftMember[];
  linked_project_id: string | null;
  linked_project_name: string | null;
};

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/**
 * Lỗi không có mã là chưa tới được máy chủ (`postgrest-js` trả `TypeError: Failed to fetch`): đừng in câu tiếng
 * Anh ấy lên màn.
 */
export function orderRpcError(error: { code?: string; message?: string }, fallback: string): Error {
  if (!error.code) return new Error(INTERCOM_NO_CONNECTION_TEXT);
  return new Error(error.message || fallback);
}

export async function listIntercomOrderCandidates(search: string): Promise<IntercomOrderCandidate[]> {
  const { data, error } = await staffClient().rpc("intercom_order_candidates", { p_search: search });
  if (error) throw orderRpcError(error, "Chưa tải được danh sách đơn.");
  return asRecordList(data).map((r) => ({
    order_id: String(r.order_id ?? ""),
    display_code: typeof r.display_code === "string" ? r.display_code : "",
    start_date: textOrNull(r.start_date),
    end_date: textOrNull(r.end_date),
    status: typeof r.status === "string" ? r.status : "",
    customer_name: textOrNull(r.customer_name),
    customer_code: textOrNull(r.customer_code),
    unit_count: numberOrNull(r.unit_count),
    linked_project_id: textOrNull(r.linked_project_id),
    linked_project_name: textOrNull(r.linked_project_name),
  }));
}

/**
 * Dữ liệu điền sẵn của một đơn. Đơn đã huỷ, không có intercom thì máy chủ báo "Không tìm thấy đơn có intercom".
 * Đơn đã qua ngày hoàn thành, hoặc chưa có ngày hoàn thành, thì máy chủ báo "Đơn đã qua ngày hoàn thành".
 */
export async function getIntercomOrderDraft(orderId: string): Promise<IntercomOrderDraft> {
  const { data, error } = await staffClient().rpc("intercom_order_prefill", { p_order: orderId });
  if (error) throw orderRpcError(error, "Chưa đọc được đơn.");
  const r = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  return {
    order_id: String(r.order_id ?? orderId),
    display_code: typeof r.display_code === "string" ? r.display_code : "",
    name: typeof r.name === "string" ? r.name : "",
    start_date: textOrNull(r.start_date),
    end_date: textOrNull(r.end_date),
    day_count: typeof r.day_count === "number" ? r.day_count : 1,
    date_warning: r.date_warning === true,
    customer_code: textOrNull(r.customer_code),
    customer_name: textOrNull(r.customer_name),
    unit_count: numberOrNull(r.unit_count),
    units_by_model: asRecordList(r.units_by_model).map((u) => ({
      model_name: typeof u.model_name === "string" ? u.model_name : "",
      unit_count: typeof u.unit_count === "number" ? u.unit_count : 0,
    })),
    members: asRecordList(r.members).map((m) => ({
      profile_id: String(m.profile_id ?? ""),
      name: typeof m.name === "string" ? m.name : "",
      is_staff: m.is_staff === true,
      has_login: m.has_login === true,
      eligible: m.eligible === true,
    })),
    linked_project_id: textOrNull(r.linked_project_id),
    linked_project_name: textOrNull(r.linked_project_name),
  };
}

/**
 * Nối đơn vào dự án vừa tạo, ghi thành viên nguồn `order` theo danh sách SAU khi người dùng sửa. Gọi lại cùng dự
 * án, cùng đơn là an toàn (nút Thử lại). Đơn đã nối dự án khác thì máy chủ báo "Đơn đã nối dự án <tên>".
 */
export async function applyIntercomOrder(projectId: string, orderId: string, memberIds: string[]): Promise<void> {
  const { error } = await staffClient().rpc("intercom_project_apply_order", {
    p_project: projectId,
    p_order: orderId,
    p_member_ids: memberIds,
  });
  if (error) throw orderRpcError(error, "Chưa nối được đơn vào dự án.");
}

// Link khách

/** Tạo mã mới (mã cũ hết hiệu lực), trả mã. */
export async function rotateIntercomShare(projectId: string): Promise<string> {
  const { data, error } = await staffClient().rpc("intercom_share_rotate", { p_project: projectId });
  if (error) throw projectRpcError(error, "Chưa tạo được link khách.");
  return String(data ?? "");
}

/** Thu hồi link khách đang có. */
export async function revokeIntercomShare(projectId: string): Promise<void> {
  const { error } = await staffClient().rpc("intercom_share_revoke", { p_project: projectId });
  if (error) throw projectRpcError(error, "Chưa thu hồi được link khách.");
}

/** Link khách đầy đủ để chép gửi. */
export function intercomShareUrl(token: string): string {
  return `${INTERCOM_SHARE_ORIGIN}/ic/${token}`;
}

/** Ảnh của một lượt cho nhân viên (cookie phiên, cùng gốc). */
export function intercomPhotoUrl(handoverId: string, size: IntercomPhotoSize = "thumb"): string {
  return `${PHOTO_ROUTE}/${handoverId}?size=${size}`;
}

/** Ảnh của một lượt qua link khách. */
export function intercomSharePhotoUrl(token: string, handoverId: string, size: IntercomPhotoSize = "thumb"): string {
  return `${SHARE_PHOTO_ROUTE}/${token}/${handoverId}?size=${size}`;
}

/** Lý do lượt tải hỏng ở mức mạng (màn hiện "Mã: <lý do>" để chẩn đoán). */
export type IntercomUploadFailReason =
  | "xhr-error"
  | "xhr-abort"
  | "xhr-timeout"
  | "xhr-no-response"
  | "xhr-stalled"
  | "fetch-error"
  | "fetch-timeout"
  | "part-error"
  | "part-timeout";

/** Lỗi mạng của `uploadIntercomHandover`, mang `reason` để màn hiện mã chẩn đoán. */
export class IntercomUploadError extends Error {
  readonly reason: IntercomUploadFailReason;
  /** Số lượt đã gửi trước khi bỏ cuộc (tự gửi lại khi hỏng mức mạng). */
  readonly attempts: number;
  constructor(reason: IntercomUploadFailReason, attempts = 1) {
    super(`Intercom upload failed: ${reason}`);
    this.name = "IntercomUploadError";
    this.reason = reason;
    this.attempts = attempts;
  }
}

/** Đổi mã trạng thái và thân trả về thành `IntercomUploadReply` (dùng chung cho XHR và `fetch`). */
export function toUploadReply(status: number, text: string): IntercomUploadReply {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    // Thân hỏng hoặc không phải JSON: dùng câu chung ở dưới.
  }
  if (status < 200 || status > 299) {
    const message = typeof data.error === "string" && data.error ? data.error : "Chưa lưu được ảnh, thử lại giúp tôi.";
    // Route đổi `42501` của `intercom_handover_begin` thành 403 `reason: "permission"`.
    const lostMembership = status === 403 && data.reason === "permission" && message !== OTHER_USER_HANDOVER_TEXT;
    return {
      ok: false,
      status,
      alreadyDone: false,
      result: null,
      error: lostMembership ? INTERCOM_NOT_MEMBER_TEXT : message,
    };
  }
  return {
    ok: true,
    status,
    alreadyDone: data.already_done === true,
    result: toResult(data.result),
    error: null,
  };
}

/** Gửi xong thân mà chừng này ms chưa có phản hồi thì huỷ lượt XHR (`xhr-no-response`) để gửi lại. */
const INTERCOM_XHR_RESPONSE_WAIT_MS = 15000;

/**
 * Đang đẩy thân mà chừng này ms `loaded` không tăng (kể cả chưa có sự kiện tiến độ nào) thì huỷ lượt XHR
 * (`xhr-stalled`).
 */
export const INTERCOM_UPLOAD_STALL_MS = 8000;

/**
 * Móc của một lượt gửi: `onBodySent` báo thân đã gửi xong (bắt đầu hỏi trạng thái); `setAbort` trao hàm huỷ
 * lượt.
 */
type IntercomSendHooks = {
  onBodySent?: () => void;
  setAbort?: (abort: () => void) => void;
};

/** Gửi bằng `XMLHttpRequest` để có tiến độ. Hỏng mức mạng (kể cả `status` 0): ném `IntercomUploadError`. */
function sendIntercomFormXhr(
  form: FormData,
  timeoutMs?: number,
  onProgress?: (fraction: number) => void,
  hooks?: IntercomSendHooks,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", PHOTO_ROUTE);
    hooks?.setAbort?.(() => xhr.abort());
    // Cùng gốc: cookie phiên tự đi kèm (như `credentials: "same-origin"` của `fetch`).
    if (timeoutMs) xhr.timeout = timeoutMs;
    let noResponse = false;
    let responseTimer: ReturnType<typeof setTimeout> | null = null;
    let stallFired = false;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    let lastLoaded = -1;
    const clearStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = null;
    };
    const armStallTimer = () => {
      clearStallTimer();
      stallTimer = setTimeout(() => {
        stallTimer = null;
        stallFired = true;
        xhr.abort();
      }, INTERCOM_UPLOAD_STALL_MS);
    };
    const clearResponseTimer = () => {
      if (responseTimer) clearTimeout(responseTimer);
      responseTimer = null;
      clearStallTimer();
    };
    xhr.upload.onprogress = (event) => {
      if (event.loaded > lastLoaded) {
        lastLoaded = event.loaded;
        if (stallTimer) armStallTimer();
      }
      if (onProgress && event.lengthComputable && event.total > 0) onProgress(Math.min(1, event.loaded / event.total));
    };
    xhr.upload.onload = () => {
      clearStallTimer();
      onProgress?.(1);
      hooks?.onBodySent?.();
      clearResponseTimer();
      responseTimer = setTimeout(() => {
        responseTimer = null;
        noResponse = true;
        xhr.abort();
      }, INTERCOM_XHR_RESPONSE_WAIT_MS);
    };
    xhr.onerror = () => {
      clearResponseTimer();
      reject(new IntercomUploadError("xhr-error"));
    };
    xhr.ontimeout = () => {
      clearResponseTimer();
      reject(new IntercomUploadError("xhr-timeout"));
    };
    xhr.onabort = () => {
      clearResponseTimer();
      reject(new IntercomUploadError(stallFired ? "xhr-stalled" : noResponse ? "xhr-no-response" : "xhr-abort"));
    };
    xhr.onload = () => {
      clearResponseTimer();
      if (xhr.status === 0) {
        reject(new IntercomUploadError("xhr-error"));
        return;
      }
      let text = "";
      try {
        text = xhr.responseText;
      } catch {
        // Không đọc được thân: coi như rỗng.
      }
      resolve({ status: xhr.status, text });
    };
    armStallTimer();
    xhr.send(form);
  });
}

/** Gửi lại bằng `fetch` (không tiến độ), hết hạn theo `timeoutMs` như XHR. */
async function sendIntercomFormFetch(
  form: FormData,
  timeoutMs?: number,
  hooks?: IntercomSendHooks,
): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  hooks?.setAbort?.(() => controller.abort());
  // `fetch` không báo lúc gửi xong thân: hỏi trạng thái ngay từ khi gửi.
  hooks?.onBodySent?.();
  let timedOut = false;
  const timer = timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs)
    : null;
  try {
    let res: Response;
    try {
      res = await fetch(PHOTO_ROUTE, {
        method: "POST",
        body: form,
        credentials: "same-origin",
        signal: controller.signal,
      });
    } catch {
      throw new IntercomUploadError(timedOut ? "fetch-timeout" : "fetch-error");
    }
    let text = "";
    try {
      text = await res.text();
    } catch {
      // Phản hồi tới mà mất thân: 2xx vẫn coi như đã lưu (`toUploadReply` cho `result` null).
    }
    return { status: res.status, text };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Hỏi trạng thái lượt: chờ chừng này ms sau khi thân gửi xong rồi mới hỏi lần đầu. */
const INTERCOM_STATUS_FIRST_DELAY_MS = 2000;
/** Hỏi trạng thái lượt: khoảng cách giữa các lần hỏi (ms). */
const INTERCOM_STATUS_INTERVAL_MS = 1000;

function unitCodeOf(row: Record<string, unknown>): string {
  const unit = row.intercom_unit as { code?: unknown } | { code?: unknown }[] | null;
  const code = Array.isArray(unit) ? unit[0]?.code : unit?.code;
  return typeof code === "string" ? code : "";
}

/**
 * Dựng kết quả lượt đã `done` từ bảng (khi phản hồi POST không về máy). Giao: mã của các tai lượt này giao. Thu:
 * trong các tai đã chọn, tai có `collect_handover_id` = lượt này là thu được, tai do lượt khác thu là đã có
 * người thu trước. Đọc hỏng thì trả `null` (màn dùng mã đã chọn).
 */
export async function readIntercomHandoverResult(
  meta: IntercomUploadMeta,
  kind: IntercomKind,
): Promise<IntercomHandoverResult | null> {
  const handoverId = meta.handover_id;
  try {
    if (kind === "collect") {
      const issueIds = meta.issue_ids ?? [];
      if (issueIds.length === 0) return null;
      const { data, error } = await staffClient()
        .from("intercom_issue")
        .select("id, collect_handover_id, intercom_unit(code)")
        .in("id", issueIds);
      if (error || !data) return null;
      const codes: string[] = [];
      const alreadyCollected: string[] = [];
      for (const row of data as Record<string, unknown>[]) {
        const code = unitCodeOf(row);
        if (!code) continue;
        if (row.collect_handover_id === handoverId) codes.push(code);
        else if (typeof row.collect_handover_id === "string") alreadyCollected.push(code);
      }
      return { handover_id: handoverId, kind, codes, already_collected: alreadyCollected };
    }
    const { data, error } = await staffClient()
      .from("intercom_issue")
      .select("id, intercom_unit(code)")
      .eq("deliver_handover_id", handoverId);
    if (error || !data) return null;
    const codes = (data as Record<string, unknown>[]).map(unitCodeOf).filter((c) => c);
    return { handover_id: handoverId, kind, codes, already_collected: [] };
  } catch {
    return null;
  }
}

/**
 * Vòng hỏi trạng thái của một lượt gửi. `start` (thân đã gửi xong) thì chờ 2 s rồi mỗi 1 s đọc
 * `intercom_handover.status`; thấy `done` thì `done` trả phản hồi thành công dựng từ bảng. Hỏi lỗi mạng thì bỏ
 * qua lần đó. `stop` dừng vòng (POST đã về hoặc lượt hết hạn).
 */
export function watchIntercomHandoverDone(meta: IntercomUploadMeta): {
  start: () => void;
  stop: () => void;
  done: Promise<IntercomUploadReply>;
} {
  let isRunning = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolveDone: (reply: IntercomUploadReply) => void = () => {};
  const done = new Promise<IntercomUploadReply>((resolve) => {
    resolveDone = resolve;
  });
  const schedule = (ms: number) => {
    if (!stopped) timer = setTimeout(() => void tick(), ms);
  };
  const tick = async () => {
    timer = null;
    if (stopped) return;
    try {
      const { data, error } = await staffClient()
        .from("intercom_handover")
        .select("status, kind")
        .eq("id", meta.handover_id)
        .maybeSingle();
      const row = (data ?? null) as { status?: unknown; kind?: unknown } | null;
      if (!stopped && !error && row && row.status === "done") {
        const kind: IntercomKind = row.kind === "collect" ? "collect" : row.kind === "deliver" ? "deliver" : meta.kind;
        const result = await readIntercomHandoverResult(meta, kind);
        if (stopped) return;
        stopped = true;
        resolveDone({ ok: true, status: 200, alreadyDone: false, result, error: null });
        return;
      }
    } catch {
      // Hỏi lỗi mạng: bỏ qua lần này.
    }
    schedule(INTERCOM_STATUS_INTERVAL_MS);
  };
  return {
    start: () => {
      if (isRunning || stopped) return;
      isRunning = true;
      schedule(INTERCOM_STATUS_FIRST_DELAY_MS);
    },
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    done,
  };
}

// Nhật ký đường truyền Cuối mỗi lần gọi `uploadIntercomHandover`, `uploadIntercomHandoverSingle` (thành công, phản
// hồi lỗi, hay ném lỗi cuối) đẩy một dòng vào hàng chờ nhật ký (`recordIntercomUploadLog`, không chờ). Không đổi
// hợp đồng, không đổi luồng tải.

/** Bộ đếm của một lần tải: số lần gửi (mọi bước), cỡ ảnh lớn thật sự đã gửi (đường dự phòng có thể nén lại). */
export type IntercomUploadTally = { attempts: number; photoBytes: number };

/** Mã lý do hỏng cho nhật ký: lỗi mạng lấy `reason`; phản hồi lỗi HTTP ghi `http-<mã>`; lỗi khác `unexpected`. */
function uploadFailReason(outcome: { reply: IntercomUploadReply } | { error: unknown }): string | null {
  if ("reply" in outcome) return outcome.reply.ok ? null : `http-${outcome.reply.status}`;
  return outcome.error instanceof IntercomUploadError ? outcome.error.reason : "unexpected";
}

export async function withIntercomUploadLog(
  input: { meta: IntercomUploadMeta; file: Blob; thumb: Blob },
  method: "chunk" | "single" | "direct",
  run: (tally: IntercomUploadTally) => Promise<IntercomUploadReply>,
): Promise<IntercomUploadReply> {
  const tally: IntercomUploadTally = { attempts: 0, photoBytes: input.file.size };
  const startedAt = new Date();
  const startTick = typeof performance !== "undefined" ? performance.now() : Date.now();
  const log = (outcome: { reply: IntercomUploadReply } | { error: unknown }) => {
    try {
      const finishTick = typeof performance !== "undefined" ? performance.now() : Date.now();
      const { device, network } = currentIntercomDeviceInfo();
      const ok = "reply" in outcome && outcome.reply.ok;
      recordIntercomUploadLog({
        handover_id: input.meta.handover_id,
        project_id: input.meta.project_id || null,
        kind: input.meta.kind,
        started_at: startedAt.toISOString(),
        finished_at: new Date().toISOString(),
        duration_ms: Math.max(0, Math.round(finishTick - startTick)),
        photo_bytes: tally.photoBytes,
        thumb_bytes: input.thumb.size,
        attempts: Math.max(1, tally.attempts),
        method,
        outcome: ok ? "ok" : "fail",
        fail_reason: ok ? null : uploadFailReason(outcome),
        device,
        network,
      });
    } catch {
      // Nhật ký là phần thêm: hỏng thì bỏ, không đổi kết quả tải.
    }
  };
  try {
    const reply = await run(tally);
    log({ reply });
    return reply;
  } catch (error) {
    log({ error });
    throw error;
  }
}

/** Số lượt gửi tối đa của một lần Lưu (lượt đầu cộng tự gửi lại khi hỏng mức mạng). */
export const INTERCOM_UPLOAD_ATTEMPTS = 3;
/** Chờ trước lượt gửi thứ 2, thứ 3 (ms). */
const INTERCOM_RETRY_DELAYS_MS = [1500, 3000];

/** Tuỳ chọn tự gửi lại của `uploadIntercomHandover`. */
export type IntercomUploadRetryOptions = {
  /** Hạn mỗi lượt từ lượt thứ 2 (ms); thiếu thì dùng `timeoutMs` của lượt đầu. */
  retryTimeoutMs?: number;
  /** Báo màn sắp gửi lượt `attempt` trên `total` (từ lượt thứ 2). */
  onRetry?: (attempt: number, total: number) => void;
  /** Từ lượt thứ 2: nén lại ảnh nhỏ hơn; trả `null` thì giữ ảnh cũ. Gọi một lần, dùng cho mọi lượt sau. */
  shrinkFile?: () => Promise<{ file: Blob; width: number; height: number } | null>;
};

/** Dựng FormData MỚI cho mỗi lượt, Blob tạo lại từ bytes (WebKit hỏng khi dùng lại body của lượt trước). */
async function buildIntercomForm(meta: IntercomUploadMeta, file: Blob, thumb: Blob): Promise<FormData> {
  const [fileBytes, thumbBytes] = await Promise.all([file.arrayBuffer(), thumb.arrayBuffer()]);
  const form = new FormData();
  form.append("meta", JSON.stringify(meta));
  form.append("file", new Blob([fileBytes], { type: file.type || "image/jpeg" }), "photo.jpg");
  form.append("thumb", new Blob([thumbBytes], { type: thumb.type || "image/jpeg" }), "thumb.jpg");
  return form;
}

function waitMs(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Đường DỰ PHÒNG: MỘT request multipart tới `/api/intercom/photo`. Mất mạng, hết hạn: NÉM `IntercomUploadError`
 * (màn giữ ảnh, lựa chọn, `handover_id`, hiện Thử lại kèm mã lý do). Phản hồi lỗi: `ok` false kèm `error`. Phản
 * hồi 2xx mà mất thân: coi như đã lưu (`result` null); Thử lại cùng `handover_id` vẫn an toàn nhờ
 * `already_done`. Dùng `XMLHttpRequest`: `fetch` không báo tiến độ tải lên; `onProgress` nhận tỉ lệ 0 tới 1 phần
 * đã gửi. Hỏng mức mạng (`onerror`, `onabort`, `status` 0, `fetch` hỏng, hết hạn của lượt chưa phải cuối, XHR
 * gửi xong thân mà 15 s chưa có phản hồi, XHR đang đẩy thân mà 8 s `loaded` không tăng) thì tự gửi lại, tối đa
 * `INTERCOM_UPLOAD_ATTEMPTS` lượt, chờ 1,5 s rồi 3 s, cùng `handover_id` (lượt trước thực ra đã tới thì route
 * trả `already_done`). Lượt 2 dùng `fetch`, lượt 3 lại XHR; từ lượt 2 gửi ảnh nén nhỏ hơn (`shrinkFile`). Có
 * phản hồi HTTP thì không gửi lại. Trong lúc chờ phản hồi mỗi lượt, song song hỏi `intercom_handover.status`
 * (`watchIntercomHandoverDone`); thấy `done` thì huỷ chờ POST, trả phản hồi thành công dựng từ bảng. POST về
 * trước thì dừng vòng hỏi.
 */
export async function uploadIntercomHandoverSingle(
  input: { meta: IntercomUploadMeta; file: Blob; thumb: Blob },
  timeoutMs?: number,
  onProgress?: (fraction: number) => void,
  options?: IntercomUploadRetryOptions,
): Promise<IntercomUploadReply> {
  return withIntercomUploadLog(input, "single", (tally) =>
    sendIntercomHandoverSingle(input, tally, timeoutMs, onProgress, options),
  );
}

/** Thân của `uploadIntercomHandoverSingle`; `tally` đếm lượt gửi và cỡ ảnh lớn thật sự đã gửi. */
async function sendIntercomHandoverSingle(
  input: { meta: IntercomUploadMeta; file: Blob; thumb: Blob },
  tally: IntercomUploadTally,
  timeoutMs?: number,
  onProgress?: (fraction: number) => void,
  options?: IntercomUploadRetryOptions,
): Promise<IntercomUploadReply> {
  let meta = input.meta;
  let file = input.file;
  let shrunk = false;
  for (let attempt = 1; ; attempt += 1) {
    const isLast = attempt >= INTERCOM_UPLOAD_ATTEMPTS;
    tally.attempts += 1;
    const attemptTimeout = attempt === 1 ? timeoutMs : (options?.retryTimeoutMs ?? timeoutMs);
    const form = await buildIntercomForm(meta, file, input.thumb);
    let sent: { status: number; text: string };
    const watch = watchIntercomHandoverDone(meta);
    let abortSend: (() => void) | null = null;
    const hooks: IntercomSendHooks = {
      onBodySent: watch.start,
      setAbort: (abort) => {
        abortSend = abort;
      },
    };
    const sending =
      attempt === 2
        ? sendIntercomFormFetch(form, attemptTimeout, hooks)
        : sendIntercomFormXhr(form, attemptTimeout, onProgress, hooks);
    // Vòng hỏi thắng thì lượt gửi bị huỷ và ném lỗi sau đó: nuốt để không thành lỗi chưa bắt.
    sending.catch(() => {});
    try {
      const winner = await Promise.race([
        sending.then((value) => ({ polled: null, value })),
        watch.done.then((reply) => ({ polled: reply, value: null })),
      ]);
      if (winner.polled) {
        (abortSend as (() => void) | null)?.();
        return winner.polled;
      }
      sent = winner.value as { status: number; text: string };
    } catch (e) {
      if (!(e instanceof IntercomUploadError)) throw e;
      if (isLast) throw new IntercomUploadError(e.reason, attempt);
      options?.onRetry?.(attempt + 1, INTERCOM_UPLOAD_ATTEMPTS);
      if (!shrunk && options?.shrinkFile) {
        shrunk = true;
        try {
          const smaller = await options.shrinkFile();
          if (smaller) {
            file = smaller.file;
            tally.photoBytes = file.size;
            meta = { ...meta, width: smaller.width, height: smaller.height };
          }
        } catch {
          // Nén lại hỏng: gửi lại ảnh cũ.
        }
      }
      await waitMs(INTERCOM_RETRY_DELAYS_MS[attempt - 1] ?? 3000);
      continue;
    } finally {
      watch.stop();
    }
    return toUploadReply(sent.status, sent.text);
  }
}

// Tải chia mẩu

const UPLOAD_ROUTE = "/api/intercom/upload";
/** Cỡ một mẩu tính bằng bytes trước mã hoá (route nhận tối đa 160 KB bytes). */
export const INTERCOM_CHUNK_BYTES = 64 * 1024;
/**
 * Cách gửi thân mẩu. Mặc định `"base64"`: chữ `text/plain`. `"binary"` là nhánh dự phòng, route vẫn nhận, không
 * dùng mặc định.
 */
type IntercomPartFormat = "base64" | "binary";
const INTERCOM_PART_FORMAT: IntercomPartFormat = "base64";
/** Cỡ khúc khi đổi bytes ra chuỗi nhị phân (giữ `String.fromCharCode.apply` dưới trần tham số). */
const BASE64_BLOCK_BYTES = 0x2000;

/** Mã hoá base64 theo từng khúc, không trải cả mảng lớn vào một lời gọi. */
function encodeBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  const pieces: string[] = [];
  for (let i = 0; i < view.length; i += BASE64_BLOCK_BYTES) {
    const block = view.subarray(i, Math.min(i + BASE64_BLOCK_BYTES, view.length));
    pieces.push(String.fromCharCode.apply(null, block as unknown as number[]));
  }
  return btoa(pieces.join(""));
}
/** Hạn mỗi lần gửi một mẩu (ms). */
const INTERCOM_PART_TIMEOUT_MS = 8000;
/** Chờ trước lần gửi lại thứ 1 tới 4 của một mẩu (ms); tổng tối đa 5 lần gửi mỗi mẩu. */
const INTERCOM_PART_RETRY_DELAYS_MS = [500, 1000, 2000, 3000];
/** Số lần gửi tối đa của `start`, `finish` (chỉ gửi lại khi hỏng mức mạng). */
const INTERCOM_STEP_ATTEMPTS = 3;
/** Hạn mỗi lần gửi `start`, `finish` (ms). */
const INTERCOM_STEP_TIMEOUT_MS = 15000;
/** Chờ trước lần gửi thứ 2, thứ 3 của `start`, `finish` (ms). */
const INTERCOM_STEP_RETRY_DELAYS_MS = [1000, 2000];

type IntercomPartKind = "photo" | "thumb";
type IntercomPartRef = { kind: IntercomPartKind; index: number };

/** `fetch` có hạn; hỏng mức mạng hay hết hạn thì ném `IntercomUploadError` với lý do truyền vào. */
export async function fetchIntercomText(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  reasons: { error: IntercomUploadFailReason; timeout: IntercomUploadFailReason },
  setAbort?: (abort: () => void) => void,
): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  setAbort?.(() => controller.abort());
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetch(url, { ...init, credentials: "same-origin", signal: controller.signal });
    } catch {
      throw new IntercomUploadError(timedOut ? reasons.timeout : reasons.error);
    }
    let text = "";
    try {
      text = await res.text();
    } catch {
      // Phản hồi tới mà mất thân: dùng mã trạng thái.
    }
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

/** Gửi `start` (JSON), gửi lại khi hỏng mức mạng; `begin` gọi lại cùng `handover_id` an toàn. */
export async function postIntercomStep(
  url: string,
  body: string,
  tally?: IntercomUploadTally,
): Promise<{ status: number; text: string }> {
  for (let attempt = 1; ; attempt += 1) {
    if (tally) tally.attempts += 1;
    try {
      return await fetchIntercomText(
        url,
        { method: "POST", headers: { "content-type": "application/json" }, body },
        INTERCOM_STEP_TIMEOUT_MS,
        { error: "fetch-error", timeout: "fetch-timeout" },
      );
    } catch (e) {
      if (!(e instanceof IntercomUploadError)) throw e;
      if (attempt >= INTERCOM_STEP_ATTEMPTS) throw new IntercomUploadError(e.reason, attempt);
      await waitMs(INTERCOM_STEP_RETRY_DELAYS_MS[attempt - 1] ?? 2000);
    }
  }
}

/**
 * Gửi một mẩu (`PUT`; mặc định thân chữ base64 `text/plain`, dự phòng thân nhị phân). Hỏng mức mạng, hết 8 s,
 * 5xx hay 429: gửi lại tối đa 4 lần. Trả `"ok"`; `"done"` khi route báo lượt đã lưu xong; phản hồi lỗi khác thì
 * trả `IntercomUploadReply` (`ok` false).
 */
async function putIntercomPart(
  handoverId: string,
  part: IntercomPartRef,
  bytes: ArrayBuffer,
  format: IntercomPartFormat = INTERCOM_PART_FORMAT,
  tally?: IntercomUploadTally,
): Promise<"ok" | "done" | IntercomUploadReply> {
  const url = `${UPLOAD_ROUTE}/part?h=${encodeURIComponent(handoverId)}&kind=${part.kind}&i=${part.index}`;
  const init: RequestInit =
    format === "base64"
      ? { method: "PUT", headers: { "content-type": "text/plain" }, body: encodeBase64(bytes) }
      : { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: bytes };
  const total = INTERCOM_PART_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 1; ; attempt += 1) {
    const isLast = attempt >= total;
    if (tally) tally.attempts += 1;
    let sent: { status: number; text: string };
    try {
      sent = await fetchIntercomText(
        url,
        init,
        INTERCOM_PART_TIMEOUT_MS,
        { error: "part-error", timeout: "part-timeout" },
      );
    } catch (e) {
      if (!(e instanceof IntercomUploadError)) throw e;
      if (isLast) throw new IntercomUploadError(e.reason, attempt);
      await waitMs(INTERCOM_PART_RETRY_DELAYS_MS[attempt - 1] ?? 3000);
      continue;
    }
    if (sent.status >= 200 && sent.status <= 299) return "ok";
    if (sent.status === 409) {
      try {
        const data = JSON.parse(sent.text) as { handover_status?: unknown };
        if (data && data.handover_status === "done") return "done";
      } catch {
        // Thân hỏng: coi như lỗi thường.
      }
    }
    if ((sent.status >= 500 || sent.status === 429) && !isLast) {
      await waitMs(INTERCOM_PART_RETRY_DELAYS_MS[attempt - 1] ?? 3000);
      continue;
    }
    return toUploadReply(sent.status, sent.text);
  }
}

/** Đọc danh sách mẩu thiếu từ phản hồi 409 của `finish`; không có thì `null`. */
function parseMissingParts(text: string, photoParts: number, thumbParts: number): IntercomPartRef[] | null {
  try {
    const data = JSON.parse(text) as { missing?: { photo?: unknown; thumb?: unknown } };
    const out: IntercomPartRef[] = [];
    const pick = (value: unknown, kind: IntercomPartKind, limit: number) => {
      if (!Array.isArray(value)) return;
      for (const v of value) {
        if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < limit) out.push({ kind, index: v });
      }
    };
    pick(data?.missing?.photo, "photo", photoParts);
    pick(data?.missing?.thumb, "thumb", thumbParts);
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Lưu một lượt bằng TẢI CHIA MẨU: `POST /api/intercom/upload/start` JSON meta cộng `parts`, `thumb_parts`,
 * `photo_size`, `thumb_size` (route gọi `begin`; lượt đã `done` thì trả ngay kết quả cũ kèm `already_done`). Ảnh
 * lớn rồi ảnh nhỏ chia mẩu 64 KB (`Blob.slice`, gửi dạng chữ base64), gửi TUẦN TỰ `PUT
 * /api/intercom/upload/part`; mỗi mẩu hạn 8 s, hỏng thì gửi lại mẩu đó tối đa 4 lần. `onProgress` nhận tỉ lệ
 * byte đã gửi (1 khi gửi xong mọi mẩu). `POST /api/intercom/upload/finish`; route báo thiếu mẩu (409 kèm
 * `missing`) thì gửi bù rồi gọi lại. Song song hỏi `intercom_handover.status` (`watchIntercomHandoverDone`);
 * thấy `done` thì xong, không chờ phản hồi `finish`. `start`, `finish` gửi tối đa 3 lần khi hỏng mức mạng. Hỏng
 * mức mạng hết lượt: NÉM `IntercomUploadError` (màn giữ ảnh, `handover_id`, hiện Thử lại kèm mã lý do). Phản hồi
 * lỗi: `ok` false kèm `error`, cùng hợp đồng với đường cũ. `timeoutMs`, `options` giữ trong chữ ký cho màn khỏi
 * đổi; đường chia mẩu dùng hạn riêng từng bước, không nén lại ảnh.
 */
export async function uploadIntercomHandover(
  input: { meta: IntercomUploadMeta; file: Blob; thumb: Blob },
  timeoutMs?: number,
  onProgress?: (fraction: number) => void,
  options?: IntercomUploadRetryOptions,
): Promise<IntercomUploadReply> {
  return withIntercomUploadLog(input, "chunk", (tally) => sendIntercomHandoverInParts(input, tally, onProgress));
}

/** Thân của `uploadIntercomHandover`; `tally` đếm mọi lần gửi ở `start`, `part`, `finish`. */
async function sendIntercomHandoverInParts(
  input: { meta: IntercomUploadMeta; file: Blob; thumb: Blob },
  tally: IntercomUploadTally,
  onProgress?: (fraction: number) => void,
): Promise<IntercomUploadReply> {
  const { meta, file, thumb } = input;
  const handoverId = meta.handover_id;
  const photoParts = Math.max(1, Math.ceil(file.size / INTERCOM_CHUNK_BYTES));
  const thumbParts = Math.max(1, Math.ceil(thumb.size / INTERCOM_CHUNK_BYTES));
  const totalBytes = Math.max(1, file.size + thumb.size);

  const doneFromTable = async (): Promise<IntercomUploadReply> => ({
    ok: true,
    status: 200,
    alreadyDone: false,
    result: await readIntercomHandoverResult(meta, meta.kind),
    error: null,
  });

  const startRaw = await postIntercomStep(
    `${UPLOAD_ROUTE}/start`,
    JSON.stringify({
      ...meta,
      parts: photoParts,
      thumb_parts: thumbParts,
      photo_size: file.size,
      thumb_size: thumb.size,
    }),
    tally,
  );
  const startReply = toUploadReply(startRaw.status, startRaw.text);
  if (!startReply.ok || startReply.alreadyDone) return startReply;

  let sentBytes = 0;
  /** Gửi tuần tự danh sách mẩu; `null` là đã gửi đủ. `countProgress` chỉ bật ở lượt gửi đầu. */
  const sendParts = async (
    list: IntercomPartRef[],
    countProgress: boolean,
  ): Promise<IntercomUploadReply | null> => {
    for (const part of list) {
      const source = part.kind === "photo" ? file : thumb;
      const from = part.index * INTERCOM_CHUNK_BYTES;
      const bytes = await source.slice(from, Math.min(from + INTERCOM_CHUNK_BYTES, source.size)).arrayBuffer();
      const outcome = await putIntercomPart(handoverId, part, bytes, INTERCOM_PART_FORMAT, tally);
      if (outcome === "done") return doneFromTable();
      if (outcome !== "ok") return outcome;
      if (countProgress) {
        sentBytes += bytes.byteLength;
        onProgress?.(Math.min(0.99, sentBytes / totalBytes));
      }
    }
    return null;
  };

  const allParts: IntercomPartRef[] = [];
  for (let i = 0; i < photoParts; i += 1) allParts.push({ kind: "photo", index: i });
  for (let i = 0; i < thumbParts; i += 1) allParts.push({ kind: "thumb", index: i });
  const firstPass = await sendParts(allParts, true);
  if (firstPass) return firstPass;
  onProgress?.(1);

  const finishBody = JSON.stringify({
    handover_id: handoverId,
    parts: photoParts,
    thumb_parts: thumbParts,
    width: meta.width ?? null,
    height: meta.height ?? null,
  });
  const watch = watchIntercomHandoverDone(meta);
  watch.start();
  try {
    for (let attempt = 1; ; attempt += 1) {
      const isLast = attempt >= INTERCOM_STEP_ATTEMPTS;
      tally.attempts += 1;
      let abortSend: (() => void) | null = null;
      const sending = fetchIntercomText(
        `${UPLOAD_ROUTE}/finish`,
        { method: "POST", headers: { "content-type": "application/json" }, body: finishBody },
        INTERCOM_STEP_TIMEOUT_MS,
        { error: "fetch-error", timeout: "fetch-timeout" },
        (abort) => {
          abortSend = abort;
        },
      );
      // Vòng hỏi thắng thì lượt gửi bị huỷ và ném lỗi sau đó: nuốt để không thành lỗi chưa bắt.
      sending.catch(() => {});
      let sent: { status: number; text: string };
      try {
        const winner = await Promise.race([
          sending.then((value) => ({ polled: null, value })),
          watch.done.then((reply) => ({ polled: reply, value: null })),
        ]);
        if (winner.polled) {
          (abortSend as (() => void) | null)?.();
          return winner.polled;
        }
        sent = winner.value as { status: number; text: string };
      } catch (e) {
        if (!(e instanceof IntercomUploadError)) throw e;
        if (isLast) throw new IntercomUploadError(e.reason, attempt);
        await waitMs(INTERCOM_STEP_RETRY_DELAYS_MS[attempt - 1] ?? 2000);
        continue;
      }
      if (sent.status === 409 && !isLast) {
        const missing = parseMissingParts(sent.text, photoParts, thumbParts);
        if (missing) {
          const resent = await sendParts(missing, false);
          if (resent) return resent;
          continue;
        }
      }
      return toUploadReply(sent.status, sent.text);
    }
  } finally {
    watch.stop();
  }
}

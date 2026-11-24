"use client";

// Danh mục Model tai nghe intercom: danh mục chung, không theo dự án. Thêm Custom gác
// `intercom_can_use(p_project)`; sửa, duyệt, gộp gác `is_staff()`.
// Tên tham số RPC là KHOÁ object: sai tên thì `tsc` xanh mà chạy lỗi `PGRST202`.

import { staffClient } from "@/adapters/auth";
import { orderRpcError, type IntercomPhotoSize } from "./staffIntercom";

export type IntercomUnitModelStatus = "approved" | "pending";

/** Một dòng `intercom_unit_model`. `merged_into` có giá trị là Model đã gộp vào Model khác. */
export type IntercomUnitModel = {
  id: string;
  name: string;
  max_units: number;
  has_master: boolean;
  is_hub: boolean;
  unit_hours: number;
  master_hours_min: number | null;
  master_hours_max: number | null;
  hub_hours: number | null;
  photo_key: string | null;
  status: IntercomUnitModelStatus;
  merged_into: string | null;
};

/** Thông số một Model khi thêm Custom hoặc sửa. Bộ không có tai chủ thì hai ô tai chủ bỏ qua. */
export type IntercomUnitModelInput = {
  name: string;
  maxUnits: number;
  hasMaster: boolean;
  isHub: boolean;
  unitHours: number;
  masterMin: number | null;
  masterMax: number | null;
  hubHours: number | null;
};

/** Tên Model tối đa bao nhiêu ký tự (CHECK của bảng). */
export const INTERCOM_MODEL_NAME_MAX = 60;
/** Trần tai thường mỗi bộ: 20 tai thường, cộng tai chủ `M` là 21 mã. */
export const INTERCOM_MODEL_REGULAR_MAX = 20;
/** Giờ pin hợp lệ (CHECK của bảng, của hàm thêm, sửa bộ). */
export const INTERCOM_HOURS_MIN = 0.5;
export const INTERCOM_HOURS_MAX = 48;

const MODEL_COLUMNS =
  "id, name, max_units, has_master, is_hub, unit_hours, master_hours_min, master_hours_max, hub_hours, photo_key, status, merged_into";

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function readModelRow(row: Record<string, unknown>): IntercomUnitModel {
  return {
    id: String(row.id ?? ""),
    name: String(row.name ?? ""),
    max_units: Number(row.max_units ?? 0),
    has_master: row.has_master === true,
    is_hub: row.is_hub === true,
    unit_hours: Number(row.unit_hours ?? 0),
    master_hours_min: numberOrNull(row.master_hours_min),
    master_hours_max: numberOrNull(row.master_hours_max),
    hub_hours: numberOrNull(row.hub_hours),
    photo_key: typeof row.photo_key === "string" ? row.photo_key : null,
    status: row.status === "pending" ? "pending" : "approved",
    merged_into: typeof row.merged_into === "string" ? row.merged_into : null,
  };
}

/** Mọi Model theo tên, gồm cả Model đã gộp (màn danh mục hiện mờ; lưới form Thêm bộ tự lọc bỏ). */
export async function listIntercomUnitModels(): Promise<IntercomUnitModel[]> {
  const { data, error } = await staffClient().from("intercom_unit_model").select(MODEL_COLUMNS).order("name");
  if (error) throw orderRpcError(error, "Chưa tải được danh mục Model.");
  return ((data ?? []) as Record<string, unknown>[]).map(readModelRow);
}

/** Lỗi đọc thì coi như không. */
export async function hasStaffRole(): Promise<boolean> {
  const { data, error } = await staffClient().rpc("is_staff");
  if (error) return false;
  return data === true;
}

function modelParams(input: IntercomUnitModelInput) {
  return {
    p_name: input.name,
    p_max_units: input.maxUnits,
    p_has_master: input.hasMaster,
    p_is_hub: input.isHub,
    p_unit_hours: input.unitHours,
    p_master_min: input.hasMaster ? input.masterMin : null,
    p_master_max: input.hasMaster ? input.masterMax : null,
    p_hub_hours: input.hubHours,
  };
}

/**
 * Thêm Model Custom ("Chưa duyệt") cho bộ đang thêm ở dự án `projectId`, trả id. Trùng tên Model đã có (không
 * phân biệt hoa thường) thì máy chủ trả id Model đó; Model đó đã gộp thì trả Model cuối chuỗi.
 */
export async function addIntercomUnitModelCustom(projectId: string, input: IntercomUnitModelInput): Promise<string> {
  const { data, error } = await staffClient().rpc("intercom_unit_model_add_custom", {
    p_project: projectId,
    ...modelParams(input),
  });
  if (error) throw orderRpcError(error, "Chưa thêm được Model.");
  if (typeof data !== "string" || data === "") throw new Error("Chưa thêm được Model.");
  return data;
}

/** Giờ đã chụp trên các bộ không đổi. */
export async function saveIntercomUnitModel(id: string, input: IntercomUnitModelInput): Promise<void> {
  const { error } = await staffClient().rpc("intercom_unit_model_save", { p_id: id, ...modelParams(input) });
  if (error) throw orderRpcError(error, "Chưa lưu được Model.");
}

export async function approveIntercomUnitModel(id: string): Promise<void> {
  const { error } = await staffClient().rpc("intercom_unit_model_approve", { p_id: id });
  if (error) throw orderRpcError(error, "Chưa duyệt được Model.");
}

export async function mergeIntercomUnitModel(fromId: string, intoId: string): Promise<number> {
  const { data, error } = await staffClient().rpc("intercom_unit_model_merge", { p_from: fromId, p_into: intoId });
  if (error) throw orderRpcError(error, "Chưa gộp được Model.");
  return typeof data === "number" ? data : 0;
}

const MODEL_PHOTO_VERSION_LENGTH = 8;

/** Đường đọc ảnh Model; `v=` là 8 ký tự đầu uuid tên ảnh nên thay ảnh là đổi đường, không dính bản đã đệm. */
export function unitModelPhotoUrl(modelId: string, photoKey: string, size: IntercomPhotoSize): string {
  const name = photoKey.slice(photoKey.lastIndexOf("/") + 1);
  return `/api/intercom/unit-model-photo/${modelId}?size=${size}&v=${name.slice(0, MODEL_PHOTO_VERSION_LENGTH)}`;
}

/**
 * Nhãn giờ pin của một Model hay một bộ: `10 h · tai chủ 3 tới 10 h · Hub 5 h`. Thiếu giờ tai thường thì chuỗi
 * rỗng.
 */
export function intercomHoursLabel(hours: {
  unit_hours?: number | null;
  master_hours_min?: number | null;
  master_hours_max?: number | null;
  hub_hours?: number | null;
  has_master: boolean;
  is_hub: boolean;
}): string {
  if (hours.unit_hours === null || hours.unit_hours === undefined) return "";
  const fmt = (n: number) => String(n).replace(".", ",");
  const parts = [`${fmt(hours.unit_hours)} h`];
  if (hours.has_master && hours.master_hours_min !== null && hours.master_hours_min !== undefined) {
    const max = hours.master_hours_max ?? hours.master_hours_min;
    parts.push(`tai chủ ${fmt(hours.master_hours_min)} tới ${fmt(max)} h`);
  }
  if (hours.is_hub && hours.hub_hours !== null && hours.hub_hours !== undefined) parts.push(`Hub ${fmt(hours.hub_hours)} h`);
  return parts.join(" · ");
}

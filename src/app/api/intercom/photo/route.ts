import { cookies } from "next/headers";
import { staffServerClient } from "@/adapters/authServer";
import {
  UUID_RE,
  dbError,
  getBucket,
  readBodyCapped,
  stripJpegMetadata,
  type R2BucketLike,
} from "@/adapters/storage";
import { INTERCOM_PHOTO_KEY_RE, INTERCOM_THUMB_KEY_RE, optionalWorkDate } from "../_shared";

/**
 * Nhân viên lưu một lượt Giao hoặc Nhận intercom. Chỉ `POST`, thân `multipart/form-data`: `meta` (JSON:
 * `handover_id` do máy sinh một lần mỗi lượt, `project_id`, `kind`, `unit_ids` hoặc `issue_ids`, `person_id`
 * hoặc `department` cộng `group_no`, `source`, `taken_at`, `work_date` tuỳ chọn, `width`, `height`), `file`
 * (JPEG đã in dấu, tối đa 2 MB), `thumb` (JPEG 480px, tối đa 2 MB). `begin` gặp `handover_id` đã `done` thì trả
 * kết quả cũ kèm `already_done`: route bỏ `put`, `finish`, trả luôn (máy mất trả lời mà máy chủ đã lưu thì Thử
 * lại không báo lỗi giả). Hỏng sau `begin` thì xoá hai khoá, gọi `intercom_handover_abort`. Phiên nhân viên,
 * không `service_role`: hàm DEFINER tự kiểm `intercom_can_access`. Cửa nguồn: `sec-fetch-site === "same-origin"` và
 * `Origin` khớp gốc.
 */
export const dynamic = "force-dynamic";

const MAX_BYTES = 2 * 1024 * 1024;
/** Hai tệp cộng phần đầu multipart và ô `meta`. */
const MAX_BODY_BYTES = 2 * MAX_BYTES + 64 * 1024;
const ACCEPTED_TYPE = "image/jpeg";
const JPEG_MAGIC = [0xff, 0xd8, 0xff] as const;
const KINDS = ["deliver", "collect"] as const;
const SOURCES = ["camera", "library"] as const;
const LOG_TAG = "[intercom/photo]";
const SAVE_FAILED = "Chưa lưu được ảnh, thử lại giúp tôi.";
const TOO_LARGE = "Ảnh vượt trần 2MB.";

type HandoverKind = (typeof KINDS)[number];

type HandoverMeta = {
  handoverId: string;
  projectId: string;
  kind: HandoverKind;
  unitIds: string[] | null;
  issueIds: string[] | null;
  personId: string | null;
  department: string | null;
  groupNo: number | null;
  source: string;
  takenAt: string | null;
  workDate: string | null;
  width: number | null;
  height: number | null;
};

function optionalUuid(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  return typeof value === "string" && UUID_RE.test(value) ? value.toLowerCase() : undefined;
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

function optionalDimension(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 100000 ? value : undefined;
}

/** Soát dạng `meta`; sai dạng là `null` (400). */
function parseMeta(raw: string): HandoverMeta | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const m = value as Record<string, unknown>;
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
  const width = optionalDimension(m.width);
  const height = optionalDimension(m.height);
  if (width === undefined || height === undefined) return null;
  return {
    handoverId,
    projectId,
    kind: kind as HandoverKind,
    unitIds,
    issueIds,
    personId,
    department,
    groupNo,
    source,
    takenAt,
    workDate,
    width,
    height,
  };
}

/** Lấy tệp JPEG từ biểu mẫu, soát kiểu, trần, byte đầu, bỏ siêu dữ liệu. Lỗi thì trả `Response`. */
async function readJpegPart(form: FormData, field: string): Promise<Uint8Array | Response> {
  const part = form.get(field);
  if (part === null || typeof part === "string") {
    return Response.json({ error: "Ảnh gửi lên không đúng dạng tệp." }, { status: 400 });
  }
  const type = part.type.split(";")[0].trim().toLowerCase();
  if (type !== ACCEPTED_TYPE) return Response.json({ error: "Chỉ nhận ảnh JPEG." }, { status: 415 });
  const raw = new Uint8Array(await part.arrayBuffer());
  if (raw.byteLength > MAX_BYTES) return Response.json({ error: TOO_LARGE }, { status: 413 });
  if (raw.byteLength < JPEG_MAGIC.length || JPEG_MAGIC.some((b, i) => raw[i] !== b)) {
    return Response.json({ error: "Chỉ nhận ảnh JPEG." }, { status: 415 });
  }
  const content = stripJpegMetadata(raw);
  if (!content || content.byteLength === 0) {
    return Response.json({ error: "Ảnh JPEG bị hỏng, chụp lại giúp tôi." }, { status: 415 });
  }
  return content;
}

export async function POST(req: Request): Promise<Response> {
  const origin = req.headers.get("origin");
  if (req.headers.get("sec-fetch-site") !== "same-origin" || !origin || origin !== new URL(req.url).origin) {
    return Response.json({ error: "Chỉ lưu ảnh từ màn intercom." }, { status: 403 });
  }
  const supa = staffServerClient(await cookies());
  const { data: auth } = await supa.auth.getUser();
  if (!auth?.user?.id) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });

  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) return Response.json({ error: TOO_LARGE }, { status: 413 });
  const body = await readBodyCapped(req, MAX_BODY_BYTES);
  if (!body) return Response.json({ error: TOO_LARGE }, { status: 413 });
  let form: FormData;
  try {
    form = await new Response(body.buffer as ArrayBuffer, {
      headers: { "content-type": req.headers.get("content-type") ?? "" },
    }).formData();
  } catch {
    return Response.json({ error: "Thân yêu cầu không đúng dạng biểu mẫu." }, { status: 400 });
  }

  const meta = parseMeta(String(form.get("meta") ?? ""));
  if (!meta) return Response.json({ error: "Tham số không hợp lệ" }, { status: 400 });
  const photo = await readJpegPart(form, "file");
  if (photo instanceof Response) return photo;
  const thumb = await readJpegPart(form, "thumb");
  if (thumb instanceof Response) return thumb;

  let bucket: R2BucketLike;
  try {
    bucket = getBucket(LOG_TAG);
  } catch (e) {
    console.error(LOG_TAG, e instanceof Error ? e.message : e);
    return Response.json({ error: "Chưa lưu được ảnh lên kho, thử lại giúp tôi." }, { status: 502 });
  }

  const begin = await supa.rpc("intercom_handover_begin", {
    p_handover: meta.handoverId,
    p_project: meta.projectId,
    p_kind: meta.kind,
    p_unit_ids: meta.unitIds,
    p_issue_ids: meta.issueIds,
    p_person: meta.personId,
    p_department: meta.department,
    p_group: meta.groupNo,
    p_source: meta.source,
    p_taken_at: meta.takenAt,
    ...(meta.workDate ? { p_work_date: meta.workDate } : {}),
  });
  if (begin.error) return dbError(begin.error, "intercom_handover_begin", LOG_TAG, SAVE_FAILED);
  const opened = (begin.data ?? null) as {
    photo_key?: unknown;
    thumb_key?: unknown;
    already_done?: unknown;
    result?: unknown;
  } | null;
  if (opened?.already_done === true) {
    return Response.json({ ok: true, already_done: true, result: opened.result ?? null });
  }
  const photoKey = typeof opened?.photo_key === "string" ? opened.photo_key : "";
  const thumbKey = typeof opened?.thumb_key === "string" ? opened.thumb_key : "";

  /** Lượt đã `done` (finish đã commit mà phản hồi đứt, hay request khác cùng id đã xong) thì giữ ảnh. */
  const rollback = async (step: string, detail: unknown): Promise<Response> => {
    console.error(LOG_TAG, step, "failed", meta.handoverId, detail instanceof Error ? detail.message : detail);
    const abort = await supa.rpc("intercom_handover_abort", { p_handover: meta.handoverId });
    const keys = [photoKey, thumbKey].filter((k) => INTERCOM_PHOTO_KEY_RE.test(k) || INTERCOM_THUMB_KEY_RE.test(k));
    if (abort.error) {
      console.error(LOG_TAG, "intercom_handover_abort failed, keep R2 keys", meta.handoverId, abort.error.code, abort.error.message, keys.join(","));
    } else if (abort.data !== true) {
      console.error(LOG_TAG, "intercom_handover_abort removed nothing, keep R2 keys", meta.handoverId, keys.join(","));
    } else if (keys.length > 0) {
      await bucket.delete(keys).catch((e: unknown) => {
        console.error(LOG_TAG, "orphan R2 keys", keys.join(","), e instanceof Error ? e.message : e);
      });
    }
    return Response.json({ error: SAVE_FAILED }, { status: 502 });
  };

  if (
    !INTERCOM_PHOTO_KEY_RE.test(photoKey) ||
    !INTERCOM_THUMB_KEY_RE.test(thumbKey) ||
    !photoKey.includes(meta.handoverId)
  ) {
    return rollback("begin result", JSON.stringify(opened ?? null));
  }
  try {
    await bucket.put(photoKey, photo, { httpMetadata: { contentType: ACCEPTED_TYPE } });
  } catch (e) {
    return rollback("put photo", e);
  }
  try {
    await bucket.put(thumbKey, thumb, { httpMetadata: { contentType: ACCEPTED_TYPE } });
  } catch (e) {
    return rollback("put thumb", e);
  }

  const finish = await supa.rpc("intercom_handover_finish", {
    p_handover: meta.handoverId,
    p_size_bytes: photo.byteLength,
    p_width: meta.width,
    p_height: meta.height,
  });
  if (finish.error) {
    await rollback("intercom_handover_finish", `${finish.error.code ?? ""} ${finish.error.message}`);
    return dbError(finish.error, "intercom_handover_finish", LOG_TAG, SAVE_FAILED);
  }
  return Response.json({ ok: true, already_done: false, result: finish.data ?? null });
}

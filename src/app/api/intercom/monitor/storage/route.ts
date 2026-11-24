import { cookies } from "next/headers";
import { staffServerClient } from "@/adapters/authServer";
import { INTERCOM_PHOTO_KEY_RE, INTERCOM_THUMB_KEY_RE } from "../../_shared";
import {
  INTERCOM_PREFIX,
  MISSING_BUCKET_MESSAGE,
  NO_STORE_HEADERS,
  TMP_STALE_MS,
  UUID_SEGMENT_RE,
  isSameOriginGet,
  listPrefix,
  monitorBucket,
} from "../_shared";

/**
 * Phiên nhân viên (`staffServerClient`), không `service_role`. Liệt kê `MEDIA_BUCKET` tiền tố `intercom/` theo
 * trang 1000, trần 20 trang rồi trả cờ `truncated`; gom theo đoạn thứ hai của khoá. Dòng theo dự án chỉ trả cho
 * dự án có trong kết quả `intercom_monitor_stats`; thư mục `intercom/<uuid>/` mà dự án không còn trong DB là tệp
 * mồ côi; còn lại gộp vào `other`. Không đệm: màn gọi khi mở và khi bấm Làm mới.
 */
export const dynamic = "force-dynamic";

const LOG_TAG = "[intercom/monitor/storage]";

type Bucket = { files: number; bytes: number };
type ProjectBucket = Bucket & { project_id: string; photo_files: number; thumb_files: number };

export async function GET(req: Request): Promise<Response> {
  if (!isSameOriginGet(req)) {
    return Response.json({ error: "Chỉ mở từ màn intercom." }, { status: 403, headers: NO_STORE_HEADERS });
  }
  const supa = staffServerClient(await cookies());
  const { data: auth } = await supa.auth.getUser();
  if (!auth?.user?.id) return Response.json({ error: "Chưa đăng nhập" }, { status: 401, headers: NO_STORE_HEADERS });

  const { data: stats, error } = await supa.rpc("intercom_monitor_stats", { p_since: new Date().toISOString() });
  if (error) {
    if (error.code === "42501") {
      return Response.json({ error: "Chỉ nhân viên được xem", reason: "permission" }, { status: 403, headers: NO_STORE_HEADERS });
    }
    console.error(LOG_TAG, "intercom_monitor_stats failed", error.code, error.message);
    return Response.json({ error: "Chưa đọc được số liệu, thử lại giúp tôi." }, { status: 500, headers: NO_STORE_HEADERS });
  }
  const raw = (stats ?? {}) as { projects?: unknown; project_ids?: unknown };
  const visible = new Set(
    (Array.isArray(raw.projects) ? raw.projects : [])
      .map((p) => String((p as { project_id?: unknown }).project_id ?? ""))
      .filter((id) => id !== ""),
  );
  const existing = new Set((Array.isArray(raw.project_ids) ? raw.project_ids : []).map((id) => String(id)));

  const { data: managerFlag, error: managerError } = await supa.rpc("intercom_is_manager");
  if (managerError) console.error(LOG_TAG, "intercom_is_manager failed", managerError.code, managerError.message);
  const isManager = !managerError && managerFlag === true;

  const bucket = monitorBucket();
  if (!bucket) return Response.json({ error: MISSING_BUCKET_MESSAGE }, { status: 500, headers: NO_STORE_HEADERS });

  let listed: Awaited<ReturnType<typeof listPrefix>>;
  try {
    listed = await listPrefix(bucket, INTERCOM_PREFIX);
  } catch (e) {
    console.error(LOG_TAG, "R2 list failed", e instanceof Error ? e.message : e);
    return Response.json({ error: "Chưa liệt kê được kho R2, thử lại giúp tôi." }, { status: 502, headers: NO_STORE_HEADERS });
  }

  const staleBefore = Date.now() - TMP_STALE_MS;
  const total: Bucket = { files: 0, bytes: 0 };
  const tmp = { files: 0, bytes: 0, stale_files: 0, stale_bytes: 0 };
  const other: Bucket = { files: 0, bytes: 0 };
  const projects = new Map<string, ProjectBucket>();
  const orphans = new Map<string, Bucket & { project_id: string }>();

  for (const obj of listed.objects) {
    const size = Number(obj.size) || 0;
    total.files += 1;
    total.bytes += size;
    const segment = obj.key.slice(INTERCOM_PREFIX.length).split("/")[0] ?? "";
    if (segment === "tmp") {
      tmp.files += 1;
      tmp.bytes += size;
      if (new Date(obj.uploaded).getTime() < staleBefore) {
        tmp.stale_files += 1;
        tmp.stale_bytes += size;
      }
      continue;
    }
    if (visible.has(segment)) {
      const row = projects.get(segment) ?? { project_id: segment, files: 0, bytes: 0, photo_files: 0, thumb_files: 0 };
      row.files += 1;
      row.bytes += size;
      if (INTERCOM_THUMB_KEY_RE.test(obj.key)) row.thumb_files += 1;
      else if (INTERCOM_PHOTO_KEY_RE.test(obj.key)) row.photo_files += 1;
      projects.set(segment, row);
      continue;
    }
    if (UUID_SEGMENT_RE.test(segment) && !existing.has(segment)) {
      const row = orphans.get(segment) ?? { project_id: segment, files: 0, bytes: 0 };
      row.files += 1;
      row.bytes += size;
      orphans.set(segment, row);
      continue;
    }
    other.files += 1;
    other.bytes += size;
  }

  const projectRows = [...projects.values()];
  const memberTotal: Bucket = projectRows.reduce(
    (sum, row) => ({ files: sum.files + row.files, bytes: sum.bytes + row.bytes }),
    { files: 0, bytes: 0 },
  );
  return Response.json(
    {
      total: isManager ? total : memberTotal,
      projects: projectRows,
      tmp: isManager ? tmp : null,
      orphans: isManager ? [...orphans.values()] : null,
      other: isManager ? other : null,
      truncated: listed.truncated,
    },
    { headers: NO_STORE_HEADERS },
  );
}

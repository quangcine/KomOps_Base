import { createWebClient } from "@/adapters/auth";
import { getBucket, type R2BucketLike } from "@/adapters/storage";
import { INTERCOM_PHOTO_KEY_RE, INTERCOM_THUMB_KEY_RE } from "../../_shared";
import {
  DRIVE_THUMBS_FOLDER,
  DRIVE_UPLOAD_URL,
  DriveError,
  fetchDrive,
  placeDriveHandoverFiles,
  readDriveSecret,
  readJsonBody,
  resolveDriveSubFolder,
  runDrivePermissions,
  runDriveQueue,
  trashUnusedDriveFile,
} from "../_shared";

/**
 * Nhịp hẹn giờ Drive: `pg_cron` gọi `kick_intercom_drive_cron()` mỗi 10 phút, hàm đó `POST` tới đây kèm header
 * `x-cron-secret`. Không có phiên: hàm cổng gọi bằng `createWebClient()` cộng `INTERCOM_DRIVE_GATE`, như
 * `runDriveQueue`. Lỗi từng lượt ghi `*_fail`, không ném ra ngoài.
 */
export const dynamic = "force-dynamic";

const LOG_TAG = "[intercom/drive/cron]";
const NO_STORE = { "cache-control": "no-store" };
const CRON_BUDGET_MS = 20000;
const CRON_BATCH = 10;

/** So băm hai chuỗi: thời gian so không phụ thuộc nội dung, độ dài của secret. */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all(
    [a, b].map(async (text) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))),
  );
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

type WebClient = ReturnType<typeof createWebClient>;
type StepSummary = Record<string, number> | "skipped" | "failed";

/** Một việc của nhịp: quá trần thì bỏ lượt này; lỗi chỉ ghi log. */
async function runStep(step: string, deadline: number, work: () => Promise<Record<string, number>>): Promise<StepSummary> {
  if (Date.now() > deadline) return "skipped";
  try {
    return await work();
  } catch (error) {
    console.error(LOG_TAG, step, "failed", error instanceof DriveError ? error.code : "unexpected");
    return "failed";
  }
}

type MoveRow = {
  handover_id: string;
  project_id: string;
  photo_key: string;
  thumb_key: string;
  account_id: string;
  folder_id: string;
};

/** Tải một tệp lên Drive bằng `uploadType=multipart`. Trả mã tệp, hoặc mã trạng thái Google. Lỗi Drive ném ra. */
async function uploadDriveFile(
  accountId: string,
  parentId: string,
  name: string,
  bytes: ArrayBuffer,
): Promise<{ fileId: string | null; status: number }> {
  const boundary = `part${crypto.randomUUID().replace(/-/g, "")}`;
  const metadata = JSON.stringify({ name, parents: [parentId], mimeType: "image/jpeg" });
  const body = new Blob([
    `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\ncontent-type: image/jpeg\r\n\r\n`,
    bytes,
    `\r\n--${boundary}--`,
  ]);
  const res = await fetchDrive(accountId, `${DRIVE_UPLOAD_URL}?uploadType=multipart&fields=id`, {
    method: "POST",
    headers: { "content-type": `multipart/related; boundary=${boundary}` },
    body,
  });
  const json = await readJsonBody(res);
  return { fileId: res.ok && typeof json.id === "string" ? json.id : null, status: res.status };
}

async function readR2Bytes(bucket: R2BucketLike, key: string): Promise<ArrayBuffer | null> {
  const object = await bucket.get(key);
  if (!object?.body) return null;
  return new Response(object.body).arrayBuffer();
}

/** Trả `null` khi xong, hoặc mã lỗi ngắn. */
async function moveOneToDrive(client: WebClient, gate: string, bucket: R2BucketLike, row: MoveRow): Promise<string | null> {
  if (!INTERCOM_PHOTO_KEY_RE.test(row.photo_key) || !INTERCOM_THUMB_KEY_RE.test(row.thumb_key)) return "bad_key";
  let photoBytes: ArrayBuffer | null;
  let thumbBytes: ArrayBuffer | null;
  try {
    [photoBytes, thumbBytes] = await Promise.all([readR2Bytes(bucket, row.photo_key), readR2Bytes(bucket, row.thumb_key)]);
  } catch {
    return "r2_read";
  }
  if (!photoBytes || !thumbBytes) return "r2_missing";

  const uploaded: string[] = [];
  const trashUploaded = async () => {
    for (const fileId of uploaded) await trashUnusedDriveFile(row.account_id, fileId, LOG_TAG);
  };
  try {
    const thumbFolder = await resolveDriveSubFolder(row.account_id, row.folder_id, DRIVE_THUMBS_FOLDER);
    if (!thumbFolder.folderId) return `subfolder_${thumbFolder.status}`;
    const photo = await uploadDriveFile(row.account_id, row.folder_id, `${row.handover_id}.jpg`, photoBytes);
    if (!photo.fileId) return `http_${photo.status}`;
    uploaded.push(photo.fileId);
    const thumb = await uploadDriveFile(row.account_id, thumbFolder.folderId, `${row.handover_id}_t.jpg`, thumbBytes);
    if (!thumb.fileId) {
      await trashUploaded();
      return `http_${thumb.status}`;
    }
    uploaded.push(thumb.fileId);
  } catch (error) {
    await trashUploaded();
    return error instanceof DriveError ? error.code : "unexpected";
  }

  const done = await client.rpc("intercom_drive_move_done", {
    p_gate: gate,
    p_handover: row.handover_id,
    p_file_id: uploaded[0],
    p_thumb_id: uploaded[1],
  });
  if (done.error || ((done.data ?? []) as unknown[]).length === 0) {
    if (done.error) console.error(LOG_TAG, "move_done failed", done.error.code);
    await trashUploaded();
    return done.error ? "db_error" : "not_moved";
  }
  try {
    await bucket.delete([row.photo_key, row.thumb_key]);
  } catch {
    console.error(LOG_TAG, "delete r2 copy failed");
  }
  return null;
}

async function moveFallbackHandovers(client: WebClient, gate: string, deadline: number): Promise<Record<string, number>> {
  const { data, error } = await client.rpc("intercom_drive_move_take", { p_gate: gate, p_limit: CRON_BATCH });
  if (error) {
    console.error(LOG_TAG, "move_take failed", error.code);
    throw new DriveError("drive_network");
  }
  const rows = (data ?? []) as MoveRow[];
  const result = { taken: rows.length, moved: 0, failed: 0 };
  if (rows.length === 0) return result;
  const bucket = getBucket(LOG_TAG);
  for (const row of rows) {
    if (Date.now() > deadline) break;
    const failure = await moveOneToDrive(client, gate, bucket, row);
    if (!failure) {
      result.moved += 1;
      continue;
    }
    result.failed += 1;
    const saved = await client.rpc("intercom_drive_move_fail", { p_gate: gate, p_handover: row.handover_id, p_error: failure });
    if (saved.error) console.error(LOG_TAG, "move_fail failed", saved.error.code);
  }
  return result;
}

// (2) Chuyển từ thư mục tạm vào thư mục dự án

type PlaceRow = {
  handover_id: string;
  project_id: string;
  account_id: string;
  file_id: string;
  thumb_file_id: string;
  folder_id: string;
  staging_folder_id: string | null;
};

async function placeStagedHandovers(client: WebClient, gate: string, deadline: number): Promise<Record<string, number>> {
  const { data, error } = await client.rpc("intercom_drive_place_take", { p_gate: gate, p_limit: CRON_BATCH });
  if (error) {
    console.error(LOG_TAG, "place_take failed", error.code);
    throw new DriveError("drive_network");
  }
  const rows = (data ?? []) as PlaceRow[];
  const result = { taken: rows.length, placed: 0, failed: 0 };
  for (const row of rows) {
    if (Date.now() > deadline) break;
    const failure = await placeDriveHandoverFiles({
      accountId: row.account_id,
      folderId: row.folder_id,
      photoFileId: row.file_id,
      thumbFileId: row.thumb_file_id,
      photoFrom: row.staging_folder_id,
      thumbFrom: row.staging_folder_id,
    });
    const saved = failure
      ? await client.rpc("intercom_drive_place_fail", { p_gate: gate, p_handover: row.handover_id, p_error: failure })
      : await client.rpc("intercom_drive_place_done", { p_gate: gate, p_handover: row.handover_id });
    if (saved.error) console.error(LOG_TAG, "place mark failed", saved.error.code);
    if (failure) result.failed += 1;
    else result.placed += 1;
  }
  return result;
}

// (3), (4) Quyền, ngày cuối Sheet mẫu

async function applyPermissions(client: WebClient): Promise<Record<string, number>> {
  const results = await runDrivePermissions(client, null, LOG_TAG);
  return { applied: results.filter((r) => !r.error).length, failed: results.filter((r) => r.error).length };
}

async function scheduleSheets(client: WebClient, gate: string): Promise<Record<string, number>> {
  const { data, error } = await client.rpc("intercom_drive_sheet_schedule", { p_gate: gate });
  if (error) {
    console.error(LOG_TAG, "sheet_schedule failed", error.code);
    throw new DriveError("drive_network");
  }
  const counts = (data ?? {}) as { closed?: unknown; reopened?: unknown };
  return { closed: Number(counts.closed) || 0, reopened: Number(counts.reopened) || 0 };
}

export async function POST(req: Request): Promise<Response> {
  let expected: string;
  let gate: string;
  try {
    expected = readDriveSecret("INTERCOM_CRON_SECRET");
    gate = readDriveSecret("INTERCOM_DRIVE_GATE");
  } catch (error) {
    if (!(error instanceof DriveError)) throw error;
    return Response.json({ error: "Nhịp hẹn giờ Drive chưa cấu hình xong.", reason: "drive_config" }, { status: 500, headers: NO_STORE });
  }
  if (!(await safeEqual(req.headers.get("x-cron-secret") ?? "", expected))) {
    return Response.json({ error: "Không có quyền gọi nhịp hẹn giờ." }, { status: 403, headers: NO_STORE });
  }

  const client = createWebClient();
  const deadline = Date.now() + CRON_BUDGET_MS;
  const move = await runStep("move", deadline, () => moveFallbackHandovers(client, gate, deadline));
  const place = await runStep("place", deadline, () => placeStagedHandovers(client, gate, deadline));
  const permissions = await runStep("permissions", deadline, () => applyPermissions(client));
  const sheets = await runStep("sheet_schedule", deadline, () => scheduleSheets(client, gate));
  const sheetPermissions = await runStep("sheet_permissions", deadline, () => applyPermissions(client));
  const queue = await runStep("queue", deadline, () => runDriveQueue());
  return Response.json({ ok: true, move, place, permissions, sheets, sheetPermissions, queue }, { headers: NO_STORE });
}

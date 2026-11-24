"use client";

// Năm tuỳ chọn đo của màn `/intercom/drive-bench`. Mỗi nút chạy một lần, in từng bước. Tệp sinh ra ghi `bench_log`
// để nút thùng rác dọn được. Không in địa chỉ phiên.

import { useState } from "react";
import {
  askDriveSessionProgress,
  createDriveBenchSession,
  logDriveBench,
  probeDriveFile,
  putDriveSession,
  type DriveBenchSession,
  type DriveFileProbe,
  type DriveSessionReply,
} from "@/lib/intercom/staffIntercomDrive";

const ONE_MB = 1024 * 1024;
/** Khác cỡ ảnh A để nhìn cỡ tệp là biết phiên nào thắng. */
const SECOND_PHOTO_BYTES = 700 * 1024;
/** Đoạn resumable giữa chừng phải là bội của 256 KB. */
const FIRST_CHUNK_BYTES = 256 * 1024;

const ORIGIN_HEADER = "Origin";
const FILES_GET = "files.get";

const BUTTON_CLASS =
  "h-11 w-full rounded-control border border-border bg-surface px-3 text-left text-base text-fg active:bg-surface-2 disabled:opacity-50";

function describeReply(reply: DriveSessionReply): string {
  if (reply.kind === "reply") return `mã ${reply.status}, Range ${reply.range ?? "không đọc được"}`;
  if (reply.kind === "timeout") return "hết hạn chờ";
  if (reply.kind === "stopped") return "đã dừng";
  return "không đọc được phản hồi (đứt mạng hoặc CORS chặn)";
}

function describeSession(session: DriveBenchSession): string {
  return session.ok
    ? `tạo được, Google trả ${session.googleStatus}`
    : `không tạo được, bước ${session.step ?? "route"}, Google trả ${session.googleStatus ?? "không có"}, máy chủ trả ${session.httpStatus}`;
}

function describeProbe(probe: DriveFileProbe): string {
  return `Google trả ${probe.googleStatus ?? "không có"} (máy chủ ${probe.httpStatus}), cỡ ${probe.size ?? "không rõ"}, md5 ${probe.md5 ?? "không rõ"}${probe.inTrash ? ", trong thùng rác" : ""}`;
}

export function IntercomDriveBenchOptions({
  projectId,
  accountId,
  device,
  network,
  disabled,
  makePhoto,
  startRun,
  appendLog,
}: {
  projectId: string;
  accountId: string;
  device: string;
  network: string;
  disabled: boolean;
  makePhoto: (targetBytes: number) => Promise<Blob>;
  /** Mã lượt để gắn dòng `bench_log`, cùng cơ chế nút thùng rác. */
  startRun: () => string;
  appendLog: (line: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [probeId, setProbeId] = useState("");

  const log = async (runId: string, outcome: string, bytes: number, fileId: string | null, uploadMode = "session") => {
    try {
      await logDriveBench({
        runId,
        projectId,
        accountId,
        seq: null,
        bytes,
        ms: null,
        attempts: 1,
        outcome,
        error: null,
        device,
        network,
        uploadMode,
        fileId,
      });
    } catch (e) {
      appendLog(`Chưa ghi được số đo: ${e instanceof Error ? e.message : "lỗi không rõ"}`);
    }
  };

  const run = async (title: string, work: () => Promise<void>) => {
    setBusy(true);
    appendLog(`--- ${title}`);
    try {
      await work();
    } catch (e) {
      appendLog(`Lỗi: ${e instanceof Error ? e.message : "không rõ"}`);
    } finally {
      setBusy(false);
    }
  };

  const testOverwrite = async () => {
    const runId = startRun();
    const photoA = await makePhoto(ONE_MB);
    const photoB = await makePhoto(SECOND_PHOTO_BYTES);
    appendLog(`Ảnh A ${photoA.size} byte, ảnh B ${photoB.size} byte.`);
    const sessionA = await createDriveBenchSession({ projectId, bytes: photoA.size });
    appendLog(`Phiên A: ${describeSession(sessionA)}`);
    if (!sessionA.ok) return;
    await log(runId, "opt_overwrite", photoA.size, sessionA.fileId);
    const partial = await putDriveSession(sessionA.sessionUrl, photoA, { range: { start: 0, end: FIRST_CHUNK_BYTES } });
    appendLog(`A gửi 256 KB đầu: ${describeReply(partial)}`);
    const sessionB = await createDriveBenchSession({ projectId, bytes: photoB.size, fileId: sessionA.fileId });
    appendLog(`Phiên B cùng mã: ${describeSession(sessionB)}`);
    if (!sessionB.ok) return;
    appendLog(`B gửi trọn: ${describeReply(await putDriveSession(sessionB.sessionUrl, photoB))}`);
    const afterB = await probeDriveFile(projectId, sessionA.fileId);
    appendLog(`Sau B: ${describeProbe(afterB)}`);
    const rest = await putDriveSession(sessionA.sessionUrl, photoA, { range: { start: FIRST_CHUNK_BYTES, end: photoA.size } });
    appendLog(`A gửi tiếp: ${describeReply(rest)}`);
    const afterA = await probeDriveFile(projectId, sessionA.fileId);
    appendLog(`Sau A: ${describeProbe(afterA)}`);
    appendLog(afterA.md5 !== null && afterA.md5 === afterB.md5 ? "Kết luận: ảnh đã xong KHÔNG bị ghi đè." : "Kết luận: ảnh đã xong BỊ ghi đè, hoặc không đọc được md5.");
  };

  const testProgress = async () => {
    const runId = startRun();
    const photo = await makePhoto(ONE_MB);
    const session = await createDriveBenchSession({ projectId, bytes: photo.size });
    appendLog(`Phiên: ${describeSession(session)}`);
    if (!session.ok) return;
    // Chưa gửi trọn nên chưa có tệp trên Drive: không ghi mã tệp để khỏi vào hàng đợi thùng rác.
    await log(runId, "opt_progress", photo.size, null);
    appendLog(`Gửi 256 KB đầu: ${describeReply(await putDriveSession(session.sessionUrl, photo, { range: { start: 0, end: FIRST_CHUNK_BYTES } }))}`);
    appendLog(`Hỏi Content-Range: ${describeReply(await askDriveSessionProgress(session.sessionUrl, photo.size))}`);
  };

  const testNoOrigin = async () => {
    const runId = startRun();
    const photo = await makePhoto(ONE_MB);
    const session = await createDriveBenchSession({ projectId, bytes: photo.size, omitOrigin: true });
    appendLog(`Phiên không ${ORIGIN_HEADER}: ${describeSession(session)}`);
    if (!session.ok) return;
    await log(runId, "opt_no_origin", photo.size, session.fileId, "no_origin");
    appendLog(`PUT: ${describeReply(await putDriveSession(session.sessionUrl, photo))}`);
    appendLog(`Tệp: ${describeProbe(await probeDriveFile(projectId, session.fileId))}`);
  };

  const testRecreate = async () => {
    const runId = startRun();
    const photo = await makePhoto(ONE_MB);
    const session = await createDriveBenchSession({ projectId, bytes: photo.size });
    appendLog(`Phiên đầu: ${describeSession(session)}`);
    if (!session.ok) return;
    await log(runId, "opt_recreate", photo.size, session.fileId);
    appendLog(`PUT: ${describeReply(await putDriveSession(session.sessionUrl, photo))}`);
    const again = await createDriveBenchSession({ projectId, bytes: photo.size, fileId: session.fileId });
    appendLog(`Phiên lại trên mã đã có tệp: ${describeSession(again)}`);
  };

  const testProbe = async () => {
    appendLog(`files.get: ${describeProbe(await probeDriveFile(projectId, probeId.trim()))}`);
  };

  const locked = disabled || busy;
  return (
    <section className="space-y-2 rounded-card border border-border bg-surface p-3">
      <h2 className="text-block font-semibold text-fg">Tuỳ chọn đo</h2>
      <button type="button" disabled={locked} onClick={() => void run("Hoàn tất phiên cũ có ghi đè không", testOverwrite)} className={BUTTON_CLASS}>
        Giữ phiên A, xong bằng phiên B, gửi tiếp A
      </button>
      <button type="button" disabled={locked} onClick={() => void run("Hỏi Content-Range", testProgress)} className={BUTTON_CLASS}>
        Gửi 256 KB rồi hỏi Content-Range
      </button>
      <button type="button" disabled={locked} onClick={() => void run(`Phiên không ${ORIGIN_HEADER}`, testNoOrigin)} className={BUTTON_CLASS}>
        Tạo phiên không kèm {ORIGIN_HEADER}
      </button>
      <button type="button" disabled={locked} onClick={() => void run("Phiên lại trên mã đã có tệp", testRecreate)} className={BUTTON_CLASS}>
        Tạo phiên lại trên mã đã có tệp
      </button>
      <label className="block text-sm text-muted">
        Mã tệp để hỏi {FILES_GET}
        <input
          value={probeId}
          onChange={(e) => setProbeId(e.target.value)}
          autoComplete="off"
          autoCapitalize="none"
          className="mt-1 h-12 w-full rounded-control border border-border bg-surface px-3 text-base text-fg"
        />
      </label>
      <button type="button" disabled={locked || probeId.trim() === ""} onClick={() => void run(FILES_GET, testProbe)} className={BUTTON_CLASS}>
        Hỏi {FILES_GET}
      </button>
    </section>
  );
}

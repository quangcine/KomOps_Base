"use client";

// Màn đo `/intercom/drive-bench?project=<id>`: quản lý, dự án trong pilot, không có link từ menu. Không tạo lượt.
// Mỗi ảnh: tạo phiên ở Worker, `PUT` thẳng lên Google từ máy, ghi `bench_log`. Tuần tự, có nút dừng. `ms` tính cả
// bước tạo phiên: đúng thời gian người chụp phải chờ. Chỉ ảnh `ok` vào trung vị, p90. Thử lại là gửi trọn ảnh trên
// cùng phiên, không dựa vào bước hỏi `Content-Range`, vì bước đó chưa biết có qua CORS không.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { getIntercomAccess } from "@/lib/intercom/staffIntercom";
import {
  createDriveBenchSession,
  getIntercomProjectStorage,
  logDriveBench,
  prepareDriveJpeg,
  putDriveSession,
  trashDriveBenchRun,
  type IntercomProjectStorage,
} from "@/lib/intercom/staffIntercomDrive";
import { IntercomDriveBenchOptions } from "./IntercomDriveBenchOptions";

const TARGET_BYTES = 1024 * 1024;
const SIZE_TOLERANCE = 0.05;
const NOISE_MAX_TRIES = 6;
const INITIAL_EDGE = 800;
const RANDOM_BLOCK_BYTES = 65536;
const JPEG_QUALITY = 0.8;
const MAX_PUT_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

const FIELD_CLASS = "mt-1 h-12 w-full rounded-control border border-border bg-surface px-3 text-base text-fg disabled:bg-surface-2 disabled:text-muted";
const SECONDARY_CLASS = "h-11 rounded-control border border-border bg-surface px-3 text-base text-fg active:bg-surface-2 disabled:opacity-50";

type BenchRow = {
  seq: number;
  bytes: number;
  ms: number;
  attempts: number;
  cuts: number;
  outcome: string;
  error: string | null;
};

function encodeCanvasAsJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Máy chưa tạo được ảnh."))), "image/jpeg", JPEG_QUALITY);
  });
}

/** Ảnh nhiễu, chỉnh cạnh tới gần cỡ đích cộng trừ 5%. Hết số lần chỉnh thì trả ảnh cuối, chỗ gọi ghi cỡ thật. */
async function makeNoiseJpeg(targetBytes: number, startEdge: number): Promise<{ blob: Blob; edge: number }> {
  let edge = startEdge;
  let blob: Blob | null = null;
  for (let attempt = 0; attempt < NOISE_MAX_TRIES; attempt += 1) {
    const canvas = document.createElement("canvas");
    canvas.width = edge;
    canvas.height = edge;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Máy chưa vẽ được canvas.");
    const image = context.createImageData(edge, edge);
    for (let offset = 0; offset < image.data.length; offset += RANDOM_BLOCK_BYTES) {
      crypto.getRandomValues(image.data.subarray(offset, offset + RANDOM_BLOCK_BYTES));
    }
    for (let alpha = 3; alpha < image.data.length; alpha += 4) image.data[alpha] = 255;
    context.putImageData(image, 0, 0);
    blob = await encodeCanvasAsJpeg(canvas);
    if (Math.abs(blob.size - targetBytes) <= targetBytes * SIZE_TOLERANCE) break;
    edge = Math.max(16, Math.round(edge * Math.sqrt(targetBytes / blob.size)));
  }
  if (!blob) throw new Error("Máy chưa tạo được ảnh.");
  return { blob, edge };
}

function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function formatMs(value: number | null): string {
  return value === null ? "-" : `${value} ms`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function IntercomDriveBenchScreen({ projectId }: { projectId: string | null }) {
  const [storage, setStorage] = useState<IntercomProjectStorage | null>(null);
  const [gateMessage, setGateMessage] = useState<string | null>("Đang tải...");
  const [countText, setCountText] = useState("20");
  const [device, setDevice] = useState("");
  const [network, setNetwork] = useState("");
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<BenchRow[]>([]);
  const [lines, setLines] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const stopRef = useRef<AbortController | null>(null);
  const runIdsRef = useRef<string[]>([]);
  const edgeRef = useRef(INITIAL_EDGE);

  useEffect(() => {
    if (!projectId) {
      setGateMessage("Thiếu mã dự án trên đường dẫn.");
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const [access, nextStorage] = await Promise.all([getIntercomAccess(), getIntercomProjectStorage(projectId)]);
        if (!alive) return;
        if (!access.is_manager) setGateMessage("Chỉ quản lý intercom xem được màn này.");
        else if (!nextStorage?.is_pilot) setGateMessage("Dự án không trong danh sách thử Drive.");
        else if (!nextStorage.account_id) setGateMessage("Dự án chưa chọn tài khoản Google, chọn ở khối Lưu ảnh trước.");
        else {
          setStorage(nextStorage);
          setGateMessage(null);
        }
      } catch (e) {
        if (alive) setGateMessage(e instanceof Error ? e.message : "Chưa tải được màn đo.");
      }
    })();
    return () => {
      alive = false;
    };
  }, [projectId]);

  const stats = useMemo(() => {
    const done = rows.filter((row) => row.outcome === "ok");
    const durations = done.map((row) => row.ms).sort((a, b) => a - b);
    return {
      total: rows.length,
      done: done.length,
      median: percentile(durations, 0.5),
      p90: percentile(durations, 0.9),
      cuts: rows.reduce((sum, row) => sum + row.cuts, 0),
      retries: rows.reduce((sum, row) => sum + Math.max(0, row.attempts - 1), 0),
    };
  }, [rows]);

  const accountId = storage?.account_id ?? null;
  if (gateMessage || !projectId || !accountId) {
    return <p className="py-6 text-base text-muted">{gateMessage ?? "Đang tải..."}</p>;
  }

  const addRun = () => {
    const runId = crypto.randomUUID();
    runIdsRef.current.push(runId);
    return runId;
  };

  const makePhoto = async (targetBytes: number) => {
    const { blob, edge } = await makeNoiseJpeg(targetBytes, edgeRef.current);
    edgeRef.current = edge;
    // `canvas.toBlob` trên Safari có thể tạo đoạn APP1: gỡ như lượt thật, mọi ảnh đo đều qua đây.
    const prepared = await prepareDriveJpeg(blob);
    if (!prepared.ok) throw new Error(prepared.error);
    return prepared.blob;
  };

  /** Gửi một ảnh. Không ném lỗi: mọi kết cục đều thành một dòng đo. */
  const benchOnePhoto = async (runId: string, seq: number, signal: AbortSignal): Promise<BenchRow> => {
    const row: BenchRow = { seq, bytes: 0, ms: 0, attempts: 0, cuts: 0, outcome: "stopped", error: null };
    let fileId: string | null = null;
    const startedAt = performance.now();
    try {
      const photo = await makePhoto(TARGET_BYTES);
      row.bytes = photo.size;
      const photoReadyAt = performance.now();
      const session = await createDriveBenchSession({ projectId, bytes: photo.size });
      if (!session.ok) {
        row.outcome = "session_fail";
        row.error = `${session.step ?? "route"}:${session.googleStatus ?? session.httpStatus}`;
      } else {
        fileId = session.fileId;
        while (row.attempts < MAX_PUT_ATTEMPTS && !signal.aborted) {
          row.attempts += 1;
          // Blob tạo lại từ bytes mỗi lần như `sendDriveFile`: WebKit hỏng khi dùng lại thân của lần trước, số "thử lại" sẽ
          // xấu giả.
          const body = new Blob([await photo.arrayBuffer()], { type: "image/jpeg" });
          const reply = await putDriveSession(session.sessionUrl, body, { signal });
          if (reply.kind === "reply" && (reply.status === 200 || reply.status === 201)) {
            row.outcome = "ok";
            break;
          }
          if (reply.kind === "stopped") {
            row.outcome = "stopped";
            break;
          }
          if (reply.kind === "reply") {
            row.outcome = `http_${reply.status}`;
            if (reply.status < 500) break;
          } else {
            row.cuts += 1;
            row.outcome = reply.kind;
          }
          if (row.attempts < MAX_PUT_ATTEMPTS) await wait(RETRY_DELAY_MS);
        }
      }
      row.ms = Math.round(performance.now() - photoReadyAt);
    } catch (e) {
      row.ms = Math.round(performance.now() - startedAt);
      row.outcome = "error";
      row.error = e instanceof Error ? e.message.slice(0, 200) : "không rõ";
    }
    try {
      await logDriveBench({
        runId,
        projectId,
        accountId,
        seq,
        bytes: row.bytes,
        ms: row.ms,
        attempts: row.attempts,
        outcome: row.outcome,
        error: row.error,
        device,
        network,
        uploadMode: "session",
        fileId,
      });
    } catch (e) {
      setNotice(`Chưa ghi được số đo: ${e instanceof Error ? e.message : "lỗi không rõ"}`);
    }
    return row;
  };

  const start = async () => {
    const count = Number(countText);
    if (!Number.isInteger(count) || count < 1) {
      setNotice("Nhập số ảnh là số nguyên từ 1.");
      return;
    }
    const controller = new AbortController();
    stopRef.current = controller;
    const runId = addRun();
    setRows([]);
    setNotice(null);
    setRunning(true);
    let wakeLock: WakeLockSentinel | null = null;
    try {
      wakeLock = await navigator.wakeLock?.request("screen");
    } catch {
      // Máy không cho giữ màn: chữ hướng dẫn đã ghi rõ màn phải sáng.
    }
    for (let seq = 1; seq <= count && !controller.signal.aborted; seq += 1) {
      const row = await benchOnePhoto(runId, seq, controller.signal);
      setRows((previous) => [...previous, row]);
    }
    try {
      await wakeLock?.release();
    } catch {
      // Máy đã tự nhả.
    }
    setRunning(false);
  };

  const summaryText = () => {
    const header = `máy ${device} | sóng ${network} | xong ${stats.done}/${stats.total} | trung vị ${formatMs(stats.median)} | p90 ${formatMs(stats.p90)} | đứt ${stats.cuts} | thử lại ${stats.retries} | lượt ${runIdsRef.current.join(",")}`;
    const table = rows.map((r) => [r.seq, r.bytes, r.ms, r.attempts, r.outcome, r.error ?? ""].join("\t"));
    return [header, "stt\tbyte\tmili giây\tlần gửi\tkết quả\tlỗi", ...table, ...lines].join("\n");
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(summaryText());
      setNotice("Đã chép số đo.");
    } catch {
      setNotice("Máy chưa cho chép.");
    }
  };

  const trash = async () => {
    setNotice(null);
    try {
      let queued = 0;
      for (const runId of runIdsRef.current) queued += await trashDriveBenchRun(runId);
      setNotice(`Đã đưa ${queued} tệp đo vào hàng đợi thùng rác.`);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Chưa đưa được tệp đo vào thùng rác.");
    }
  };

  return (
    <div className="mx-auto w-full max-w-2xl space-y-3">
      <div className="flex items-center gap-2">
        <Link
          href={`/intercom/projects/${projectId}`}
          aria-label="Về màn dự án"
          className="flex size-11 shrink-0 items-center justify-center rounded-control text-fg active:bg-surface-2"
        >
          <ChevronLeft className="size-5" aria-hidden />
        </Link>
        <h1 className="min-w-0 flex-1 truncate text-card font-semibold text-fg">Đo gửi ảnh lên Drive</h1>
      </div>

      <section className="space-y-2 rounded-card border border-border bg-surface p-3">
        <label className="block text-sm text-muted">
          Số ảnh
          <input
            value={countText}
            onChange={(e) => setCountText(e.target.value)}
            inputMode="numeric"
            disabled={running}
            className={FIELD_CLASS}
          />
        </label>
        <label className="block text-sm text-muted">
          Nhãn máy
          <input value={device} onChange={(e) => setDevice(e.target.value)} disabled={running} className={FIELD_CLASS} />
        </label>
        <label className="block text-sm text-muted">
          Sóng
          <input value={network} onChange={(e) => setNetwork(e.target.value)} disabled={running} className={FIELD_CLASS} />
        </label>
        <p className="text-sm text-muted">Màn phải sáng suốt lượt đo: khoá màn là đứt.</p>
        <div className="flex flex-wrap gap-2">
          {running ? (
            <button type="button" onClick={() => stopRef.current?.abort()} className="h-11 rounded-control border border-danger px-3 text-base text-danger active:bg-danger/10">
              Dừng
            </button>
          ) : (
            <button type="button" onClick={() => void start()} className="h-11 rounded-control bg-brand-cta px-3 text-base font-semibold text-white active:bg-brand-cta-hover">
              Bắt đầu đo
            </button>
          )}
          <button type="button" onClick={() => void copy()} className={SECONDARY_CLASS}>
            Chép số đo
          </button>
          <button type="button" disabled={running} onClick={() => void trash()} className={SECONDARY_CLASS}>
            Đưa tệp đo vào thùng rác
          </button>
        </div>
        {notice ? <p className="text-sm text-muted">{notice}</p> : null}
      </section>

      <section className="space-y-2 rounded-card border border-border bg-surface p-3">
        <h2 className="text-block font-semibold text-fg">Kết quả</h2>
        <div className="space-y-1 text-base text-fg">
          <div className="flex justify-between gap-2">
            <span className="shrink-0">Xong</span>
            <span className="min-w-0 break-all text-right">
              {stats.done}/{stats.total}
            </span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="shrink-0">Trung vị</span>
            <span className="min-w-0 break-all text-right">{formatMs(stats.median)}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="shrink-0">p90</span>
            <span className="min-w-0 break-all text-right">{formatMs(stats.p90)}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="shrink-0">Đứt</span>
            <span className="min-w-0 break-all text-right">{stats.cuts}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="shrink-0">Thử lại</span>
            <span className="min-w-0 break-all text-right">{stats.retries}</span>
          </div>
        </div>
        {rows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-fg">
              <thead>
                <tr className="text-left text-label font-medium text-muted">
                  <th className="h-11 px-3 py-2">STT</th>
                  <th className="h-11 px-3 py-2 text-right">Byte</th>
                  <th className="h-11 px-3 py-2 text-right">Ms</th>
                  <th className="h-11 px-3 py-2 text-right">Lần gửi</th>
                  <th className="h-11 px-3 py-2">Kết quả</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.seq} className="border-t border-border">
                    <td className="h-11 px-3 py-2">{row.seq}</td>
                    <td className="h-11 px-3 py-2 text-right tabular-nums">{row.bytes}</td>
                    <td className="h-11 px-3 py-2 text-right tabular-nums">{row.ms}</td>
                    <td className="h-11 px-3 py-2 text-right tabular-nums">{row.attempts}</td>
                    <td className="h-11 px-3 py-2">{row.error ? `${row.outcome} (${row.error})` : row.outcome}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <IntercomDriveBenchOptions
        projectId={projectId}
        accountId={accountId}
        device={device}
        network={network}
        disabled={running}
        makePhoto={makePhoto}
        startRun={addRun}
        appendLog={(line) => setLines((previous) => [...previous, line])}
      />

      {lines.length > 0 ? (
        <section className="space-y-1 rounded-card border border-border bg-surface p-3">
          <h2 className="text-block font-semibold text-fg">Nhật ký tuỳ chọn</h2>
          {lines.map((line, index) => (
            <p key={index} className="break-all text-sm text-fg">
              {line}
            </p>
          ))}
        </section>
      ) : null}
    </div>
  );
}

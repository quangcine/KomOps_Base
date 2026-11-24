"use client";

// - Đường truyền app (nhật ký `intercom_upload_log` qua `intercom_monitor_stats`) và Cloudflare (route `traffic`),
// cùng khoảng: mặc định 24 giờ, nút 7 ngày.
// - Google Drive: nhãn lấy từ `storage_kind` của danh sách dự án; dự án `drive` không báo lệch, không tính vào số
// dọn ảnh gốc. Quản lý thấy thêm hàng đợi thùng rác; biết quản lý từ `tmp` của route `storage`, nên người khác
// không tốn thêm lời gọi.

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { canDeleteIntercomHandover, listIntercomProjects } from "@/lib/intercom/staffIntercom";
import {
  getIntercomDriveMonitor,
  getIntercomDriveTrashNote,
  runIntercomDriveQueue,
  type IntercomDriveMonitor,
} from "@/lib/intercom/staffIntercomDrive";
import {
  IntercomMonitorNoSeatError,
  getIntercomMonitorStats,
  getIntercomMonitorStorage,
  getIntercomMonitorTraffic,
  runIntercomCleanup,
  type IntercomCleanupKind,
  type IntercomMonitorEdgeTraffic,
  type IntercomMonitorStats,
  type IntercomMonitorStorage,
  type IntercomTrafficRange,
  type IntercomUploadStorage,
} from "@/lib/intercom/staffIntercomMonitor";
import { Card } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { Button, Input, Select } from "@/components/ui/Control";
import { SegmentedGroup, type SegmentedOption } from "@/components/ui/SegmentedGroup";

const RANGE_OPTIONS: readonly SegmentedOption<IntercomTrafficRange>[] = [
  { value: "24h", label: "24 giờ" },
  { value: "7d", label: "7 ngày" },
];

const STORAGE_OPTIONS: readonly SegmentedOption<IntercomUploadStorage>[] = [
  { value: "r2", label: "Kho R2" },
  { value: "drive", label: "Google Drive" },
];

const RANGE_MS: Record<IntercomTrafficRange, number> = { "24h": 24 * 3600 * 1000, "7d": 7 * 24 * 3600 * 1000 };

const NUMBER = new Intl.NumberFormat("vi-VN");
const DECIMAL = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 });

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${NUMBER.format(bytes)} B`;
  if (bytes < 1024 * 1024) return `${DECIMAL.format(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${DECIMAL.format(bytes / 1024 / 1024)} MB`;
  return `${DECIMAL.format(bytes / 1024 / 1024 / 1024)} GB`;
}

function formatMs(ms: number | null): string {
  if (ms === null) return "-";
  return ms < 1000 ? `${NUMBER.format(Math.round(ms))} ms` : `${DECIMAL.format(ms / 1000)} s`;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  return y && m && d ? `${d}/${m}/${y}` : isoDate;
}

/** Mã lỗi `runDriveQueue` ghi vào `last_error`. */
const DRIVE_QUEUE_REASONS: Record<string, string> = {
  not_found: "Không còn tệp trên Drive",
  drive_revoked: "Drive mất quyền",
  drive_account_missing: "Không tìm thấy tài khoản Google",
  drive_config: "Drive chưa cấu hình xong",
  drive_network: "Chưa gọi được Google Drive",
  bad_file_id: "Mã tệp sai khuôn",
  unexpected: "Lỗi không rõ",
};

/** Dòng đỏ theo `intercom_drive_monitor`. */
const DRIVE_ATTENTION_LINES: {
  key: "fallback_pending" | "place_pending" | "permission_failed" | "revoked_projects";
  label: string;
}[] = [
  { key: "fallback_pending", label: "Lượt lưu tạm R2 chờ chuyển sang Drive" },
  { key: "place_pending", label: "Lượt chờ vào thư mục dự án" },
  { key: "permission_failed", label: "Quyền Drive chưa đổi được" },
  { key: "revoked_projects", label: "Dự án dính tài khoản Google mất quyền" },
];

function driveQueueReason(reason: string): string {
  if (reason.startsWith("http_")) return `Google trả mã ${reason.slice(5)}`;
  return DRIVE_QUEUE_REASONS[reason] ?? reason;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col rounded-control bg-surface-2 px-3 py-2">
      <span className="text-sm text-muted">{label}</span>
      <span className="text-base font-semibold text-fg tabular-nums">{value}</span>
    </div>
  );
}

function SectionTitle({ children }: { children: string }) {
  return <p className="text-label font-medium text-muted">{children}</p>;
}

type CleanupPlan = {
  kind: IntercomCleanupKind;
  title: string;
  summary: string;
};

export function IntercomMonitorScreen() {
  const [range, setRange] = useState<IntercomTrafficRange>("24h");
  const [uploadStorage, setUploadStorage] = useState<IntercomUploadStorage>("r2");
  const [noSeat, setNoSeat] = useState(false);
  const [stats, setStats] = useState<IntercomMonitorStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [storage, setStorage] = useState<IntercomMonitorStorage | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [edgeTraffic, setEdgeTraffic] = useState<IntercomMonitorEdgeTraffic | null>(null);
  const [canDelete, setCanDelete] = useState(false);
  const [loading, setLoading] = useState(true);

  const [cleanup, setCleanup] = useState<CleanupPlan | null>(null);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const [cleanupNotice, setCleanupNotice] = useState<string | null>(null);
  const [deleteProjectId, setDeleteProjectId] = useState("");
  const [confirmName, setConfirmName] = useState("");

  /** Mã các dự án lưu Drive; `null` khi chưa đọc xong danh sách. */
  const [driveProjectIds, setDriveProjectIds] = useState<ReadonlySet<string> | null>(null);
  const [driveProjectsFailed, setDriveProjectsFailed] = useState(false);
  const [driveMonitor, setDriveMonitor] = useState<IntercomDriveMonitor | null>(null);
  const [driveError, setDriveError] = useState<string | null>(null);
  const [driveBusy, setDriveBusy] = useState(false);
  const [driveNotice, setDriveNotice] = useState<string | null>(null);
  const [driveTrashNote, setDriveTrashNote] = useState<string | null>(null);

  const loadStorage = useCallback(async (): Promise<IntercomMonitorStorage | null> => {
    setStorageError(null);
    try {
      const next = await getIntercomMonitorStorage();
      setStorage(next);
      return next;
    } catch (e) {
      if (e instanceof IntercomMonitorNoSeatError) {
        setNoSeat(true);
        return null;
      }
      setStorage(null);
      setStorageError(e instanceof Error ? e.message : "Chưa đọc được dung lượng R2.");
      return null;
    }
  }, []);

  const loadDriveProjects = useCallback(async () => {
    try {
      const projects = await listIntercomProjects();
      setDriveProjectIds(new Set(projects.filter((p) => p.storage_kind === "drive").map((p) => p.id)));
      setDriveProjectsFailed(false);
    } catch {
      setDriveProjectIds(new Set());
      setDriveProjectsFailed(true);
    }
  }, []);

  /**
   * Hàng đợi thùng rác, chỉ quản lý. Route `storage` đã báo không phải quản lý thì dừng; route đó hỏng thì để hàm
   * `intercom_drive_monitor` tự từ chối. `runQueue`: lúc mở màn, có dòng chưa xong thì chạy một lượt rồi đọc lại;
   * hàng đợi rỗng thì không gọi Worker.
   */
  const loadDriveMonitor = useCallback(async (nextStorage: IntercomMonitorStorage | null, runQueue: boolean) => {
    if (nextStorage && nextStorage.tmp === null) return;
    setDriveError(null);
    try {
      const current = await getIntercomDriveMonitor();
      setDriveMonitor(current);
      if (!current || !runQueue || current.waiting_count + current.missed_count === 0) return;
      await runIntercomDriveQueue();
      setDriveMonitor(await getIntercomDriveMonitor());
    } catch (e) {
      setDriveError(e instanceof Error ? e.message : "Chưa đọc được hàng đợi thùng rác.");
    }
  }, []);

  const loadRange = useCallback(async (value: IntercomTrafficRange): Promise<boolean> => {
    setStatsError(null);
    try {
      setStats(await getIntercomMonitorStats(new Date(Date.now() - RANGE_MS[value])));
    } catch (e) {
      if (e instanceof IntercomMonitorNoSeatError) {
        setNoSeat(true);
        return false;
      }
      setStatsError(e instanceof Error ? e.message : "Chưa tải được số liệu Monitor.");
    }
    setEdgeTraffic(null);
    try {
      setEdgeTraffic(await getIntercomMonitorTraffic(value));
    } catch (e) {
      if (e instanceof IntercomMonitorNoSeatError) {
        setNoSeat(true);
        return false;
      }
      setEdgeTraffic({ configured: true, error: e instanceof Error ? e.message : "Chưa đọc được số liệu Cloudflare." });
    }
    return true;
  }, []);

  const loadAll = useCallback(
    async (value: IntercomTrafficRange, runQueue = false) => {
      setLoading(true);
      const seated = await loadRange(value);
      if (seated) {
        const [nextStorage] = await Promise.all([loadStorage(), loadDriveProjects()]);
        setCanDelete(await canDeleteIntercomHandover());
        // Không chờ: một lượt hàng đợi có thể tới 15 giây, không giữ nút Làm mới.
        void loadDriveMonitor(nextStorage, runQueue);
      }
      setLoading(false);
    },
    [loadRange, loadStorage, loadDriveProjects, loadDriveMonitor],
  );

  useEffect(() => {
    void loadAll("24h", true);
    // Chỉ chạy khi mở màn; đổi khoảng gọi `loadRange` riêng.
  }, [loadAll]);

  function changeRange(value: IntercomTrafficRange) {
    setRange(value);
    setLoading(true);
    void loadRange(value).finally(() => setLoading(false));
  }

  const projectNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of stats?.projects ?? []) map.set(p.project_id, p.name);
    return map;
  }, [stats]);

  const pendingStale = (stats?.projects ?? []).reduce((sum, p) => sum + p.pending_stale_count, 0);
  // Dự án `drive` không dọn ảnh gốc (`intercom_cleanup_originals` bỏ qua): không để hộp thoại báo sẽ xoá.
  const purgeableProjects = (stats?.projects ?? []).filter((p) => !driveProjectIds?.has(p.project_id));
  const purgeableCount = purgeableProjects.reduce((sum, p) => sum + p.purgeable_count, 0);
  const purgeableBytes = purgeableProjects.reduce((sum, p) => sum + p.purgeable_bytes, 0);

  /** Lựa chọn của hộp Xoá dự án: dự án còn trong DB (gõ lại tên) và thư mục mồ côi (gõ lại mã). */
  const deleteTargets = useMemo(() => {
    const r2 = new Map((storage?.projects ?? []).map((p) => [p.project_id, p]));
    const live = (stats?.projects ?? []).map((p) => ({
      id: p.project_id,
      label: p.name,
      confirm: p.name,
      files: r2.get(p.project_id)?.files ?? null,
      bytes: r2.get(p.project_id)?.bytes ?? null,
      rows: p.done_count + p.pending_count,
    }));
    const orphans = (storage?.orphans ?? []).map((o) => ({
      id: o.project_id,
      label: `Tệp mồ côi ${o.project_id.slice(0, 8)}`,
      confirm: o.project_id,
      files: o.files,
      bytes: o.bytes,
      rows: 0,
    }));
    return [...live, ...orphans];
  }, [stats, storage]);
  const deleteTarget = deleteTargets.find((t) => t.id === deleteProjectId) ?? null;

  /** Dự án `drive` mà hộp đang mở sẽ xoá lượt: chuỗi mã nối để effect không chạy lại khi tải lại số. */
  const trashProjectKey = (() => {
    if (!driveProjectIds) return "";
    if (cleanup?.kind === "project") return driveProjectIds.has(deleteProjectId) ? deleteProjectId : "";
    if (cleanup?.kind !== "pending") return "";
    return (stats?.projects ?? [])
      .filter((p) => p.pending_stale_count > 0 && driveProjectIds.has(p.project_id))
      .map((p) => p.project_id)
      .join(",");
  })();

  useEffect(() => {
    setDriveTrashNote(null);
    if (!trashProjectKey) return;
    let active = true;
    getIntercomDriveTrashNote(trashProjectKey.split(","))
      .catch(() => "Ảnh cũng vào thùng rác Google Drive của dự án.")
      .then((note) => {
        if (active) setDriveTrashNote(note);
      });
    return () => {
      active = false;
    };
  }, [trashProjectKey]);

  async function retryDriveQueue() {
    setDriveBusy(true);
    setDriveError(null);
    setDriveNotice(null);
    try {
      const result = await runIntercomDriveQueue(true);
      setDriveNotice(`Đã chạy lại: ${NUMBER.format(result.finished)} tệp xong, ${NUMBER.format(result.failed)} tệp lỗi.`);
      setDriveMonitor(await getIntercomDriveMonitor());
    } catch (e) {
      setDriveError(e instanceof Error ? e.message : "Chưa chạy được hàng đợi thùng rác.");
    } finally {
      setDriveBusy(false);
    }
  }

  function openCleanup(kind: IntercomCleanupKind) {
    setCleanupError(null);
    setCleanupNotice(null);
    setConfirmName("");
    setDeleteProjectId("");
    if (kind === "tmp") {
      const summary = storage?.tmp
        ? `Sẽ xoá ${NUMBER.format(storage.tmp.stale_files)} mẩu tạm cũ hơn 1 giờ, ${formatBytes(storage.tmp.stale_bytes)}. Mẩu của lượt đang tải (mới hơn 1 giờ) giữ nguyên.`
        : storage
          ? "Tài khoản này không đếm được mẩu tạm. Chỉ mẩu cũ hơn 1 giờ bị xoá."
          : "Chưa đếm được mẩu tạm (khối Dung lượng chưa tải). Chỉ mẩu cũ hơn 1 giờ bị xoá.";
      setCleanup({ kind, title: "Dọn mẩu tạm", summary });
    } else if (kind === "pending") {
      setCleanup({
        kind,
        title: "Dọn lượt treo",
        summary: `Sẽ xoá ${NUMBER.format(pendingStale)} lượt chưa xong quá 1 giờ, cùng mẩu tạm của chúng trên R2.`,
      });
    } else if (kind === "originals") {
      setCleanup({
        kind,
        title: "Dọn ảnh gốc",
        summary: `Sẽ xoá ảnh gốc của ${NUMBER.format(purgeableCount)} lượt, khoảng ${formatBytes(purgeableBytes)}, ở dự án đã qua ngày cuối 7 ngày. Ảnh nhỏ giữ lại; Dashboard và link khách hiện ảnh nhỏ.`,
      });
    } else {
      setCleanup({ kind, title: "Xoá hẳn dự án", summary: "" });
    }
  }

  async function confirmCleanup() {
    if (!cleanup) return;
    setCleanupBusy(true);
    setCleanupError(null);
    try {
      const result = await runIntercomCleanup(
        cleanup.kind === "project"
          ? { kind: "project", projectId: deleteProjectId, confirmName: confirmName.normalize("NFC") }
          : { kind: cleanup.kind },
      );
      setCleanupNotice(
        `${cleanup.title}: đã xoá ${NUMBER.format(result.files)} tệp, ${formatBytes(result.bytes)}` +
          (result.rows > 0 ? `, ${NUMBER.format(result.rows)} dòng dữ liệu.` : "."),
      );
      setCleanup(null);
      await loadAll(range);
    } catch (e) {
      setCleanupError(e instanceof Error ? e.message : "Chưa dọn được, thử lại giúp tôi.");
    } finally {
      setCleanupBusy(false);
    }
  }

  if (noSeat) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 py-3 md:p-3">
        <Card>
          <p className="text-base text-fg">Chỉ nhân viên được xem</p>
        </Card>
      </div>
    );
  }

  const storageView = stats?.by_storage?.[uploadStorage] ?? null;
  const traffic = storageView?.traffic ?? stats?.traffic ?? null;
  const recentSends = storageView?.recent ?? stats?.recent ?? [];
  const okRate = traffic && traffic.sends > 0 ? (traffic.ok_count / traffic.sends) * 100 : null;
  const driveQueueOpen = driveMonitor ? driveMonitor.waiting_count + driveMonitor.missed_count : 0;
  const deleteReady =
    cleanup?.kind !== "project" ||
    (deleteTarget !== null &&
      confirmName.normalize("NFC").trim() === deleteTarget.confirm.normalize("NFC").trim());

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 py-3 md:p-3">
      <div className="flex items-center gap-2">
        <h1 className="flex-1 text-lg font-semibold text-fg">Monitor</h1>
        <Button
          icon={<RefreshCw className="size-4" aria-hidden />}
          disabled={loading}
          onClick={() => void loadAll(range)}
        >
          {loading ? "Đang tải..." : "Làm mới"}
        </Button>
      </div>
      {cleanupNotice ? <p className="text-base text-fg">{cleanupNotice}</p> : null}

      {/* Dung lượng */}
      <Card className="flex flex-col gap-3">
        <SectionTitle>Dung lượng</SectionTitle>
        {storageError ? <p className="text-base text-danger">{storageError}</p> : null}
        {storage ? (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Stat label={storage.tmp ? "Tổng R2 (intercom/)" : "Tổng R2 dự án của bạn"} value={formatBytes(storage.total.bytes)} />
              <Stat label="Số tệp" value={NUMBER.format(storage.total.files)} />
            </div>
            {storage.truncated ? (
              <p className="text-sm text-danger">Kho quá 20.000 tệp: số trên chỉ tính 20.000 tệp đầu.</p>
            ) : null}
          </>
        ) : null}
        <div className="flex flex-col divide-y divide-border">
          {(stats?.projects ?? []).map((p) => {
            const r2 = storage?.projects.find((x) => x.project_id === p.project_id);
            const isDrive = driveProjectIds?.has(p.project_id) === true;
            // Chưa đọc xong danh sách thì chưa biết nơi lưu: chưa báo lệch.
            const photoMismatch =
              driveProjectIds !== null && !isDrive && r2 !== undefined && r2.photo_files !== p.done_count - p.purged_count;
            return (
              <div key={p.project_id} className="flex flex-col gap-0.5 py-2">
                <p className="text-base font-medium text-fg">
                  {p.name}
                  {isDrive ? <span className="text-sm font-normal text-muted"> · Google Drive</span> : null}
                </p>
                <p className="text-sm text-muted">
                  R2: {r2 ? `${NUMBER.format(r2.files)} tệp, ${formatBytes(r2.bytes)}` : storage ? "0 tệp" : "-"} · DB:{" "}
                  {NUMBER.format(p.done_count)} lượt xong, ảnh gốc {formatBytes(p.done_bytes)}
                  {p.purged_count > 0 ? `, đã dọn ảnh gốc ${NUMBER.format(p.purged_count)} lượt` : ""}
                </p>
                {r2 && photoMismatch ? (
                  <p className="text-sm text-danger">
                    Lệch: R2 có {NUMBER.format(r2.photo_files)} ảnh gốc, DB cần{" "}
                    {NUMBER.format(p.done_count - p.purged_count)}.
                  </p>
                ) : null}
                <p className="text-sm text-muted">
                  Ngày cuối {formatDate(p.last_date)}
                  {isDrive ? "" : `; dọn ảnh gốc từ ${formatDate(p.originals_open_from)}`}
                  {p.pending_count > 0 ? ` · ${NUMBER.format(p.pending_count)} lượt chưa xong` : ""}
                </p>
              </div>
            );
          })}
          {storage?.tmp && storage.orphans && storage.other ? (
            <>
              <div className="py-2 text-sm text-muted">
                Mẩu tạm (tmp): {NUMBER.format(storage.tmp.files)} tệp, {formatBytes(storage.tmp.bytes)}; cũ hơn 1 giờ{" "}
                {NUMBER.format(storage.tmp.stale_files)} tệp
              </div>
              <div className="py-2 text-sm text-muted">
                Tệp mồ côi (dự án đã xoá):{" "}
                {NUMBER.format(storage.orphans.reduce((s, o) => s + o.files, 0))} tệp,{" "}
                {formatBytes(storage.orphans.reduce((s, o) => s + o.bytes, 0))}
              </div>
              {storage.other.files > 0 ? (
                <div className="py-2 text-sm text-muted">
                  Khác: {NUMBER.format(storage.other.files)} tệp, {formatBytes(storage.other.bytes)}
                </div>
              ) : null}
            </>
          ) : null}
          {driveMonitor && ((driveProjectIds?.size ?? 0) > 0 || driveQueueOpen > 0) ? (
            <div className="flex flex-col gap-1 py-2 text-sm text-muted">
              <p>
                Google Drive: chờ vào thùng rác {NUMBER.format(driveMonitor.waiting_count)} tệp; ảnh sót{" "}
                {NUMBER.format(driveMonitor.missed_count)} tệp
              </p>
              {driveMonitor.reasons.map((r) => (
                <p key={r.reason} className="text-danger">
                  {driveQueueReason(r.reason)}: {NUMBER.format(r.count)}
                </p>
              ))}
              {DRIVE_ATTENTION_LINES.map(({ key, label }) => {
                const count = Number(driveMonitor[key] ?? 0);
                return count > 0 ? (
                  <p key={key} className="text-danger">
                    {label}: {NUMBER.format(count)}
                  </p>
                ) : null;
              })}
              {driveQueueOpen > 0 ? (
                <Button className="self-start" disabled={driveBusy} onClick={() => void retryDriveQueue()}>
                  {driveBusy ? "Đang chạy..." : "Chạy lại"}
                </Button>
              ) : null}
              {driveNotice ? <p className="text-fg">{driveNotice}</p> : null}
            </div>
          ) : null}
          {driveError ? <p className="py-2 text-sm text-danger">{driveError}</p> : null}
          {driveProjectsFailed ? (
            <p className="py-2 text-sm text-danger">Chưa đọc được nơi lưu của dự án: số lệch và số dọn ảnh gốc có thể chưa đúng.</p>
          ) : null}
        </div>
      </Card>

      <SegmentedGroup
        options={RANGE_OPTIONS}
        value={range}
        onChange={changeRange}
        ariaLabel="Khoảng thời gian"
        className="self-start"
      />

      {/* Đường truyền app */}
      <Card className="flex flex-col gap-3">
        <SectionTitle>Đường truyền app</SectionTitle>
        {stats?.by_storage ? (
          <SegmentedGroup
            options={STORAGE_OPTIONS}
            value={uploadStorage}
            onChange={setUploadStorage}
            ariaLabel="Đường lưu ảnh"
            className="self-start"
          />
        ) : null}
        {statsError ? <p className="text-base text-danger">{statsError}</p> : null}
        {traffic ? (
          traffic.sends === 0 ? (
            <p className="text-base text-muted">Chưa có lần gửi ảnh nào trong khoảng này.</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <Stat label="Số lần gửi" value={NUMBER.format(traffic.sends)} />
                <Stat label="Tỉ lệ thành công" value={okRate === null ? "-" : `${DECIMAL.format(okRate)}%`} />
                <Stat label="Trung vị (lần thành công)" value={formatMs(traffic.median_ms)} />
                <Stat label="p90 (lần thành công)" value={formatMs(traffic.p90_ms)} />
                <Stat
                  label="Tốc độ trung bình"
                  value={traffic.average_speed === null ? "-" : `${DECIMAL.format(traffic.average_speed)} KB/s`}
                />
                <Stat
                  label="Số lần thử trung bình"
                  value={traffic.mean_attempts === null ? "-" : DECIMAL.format(traffic.mean_attempts)}
                />
              </div>
              {traffic.fail_reasons.length > 0 ? (
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-medium text-muted">Lý do hỏng</p>
                  {traffic.fail_reasons.map((r) => (
                    <p key={r.reason} className="text-sm text-fg">
                      {r.reason}: {NUMBER.format(r.count)}
                    </p>
                  ))}
                </div>
              ) : null}
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium text-muted">Theo máy</p>
                {traffic.devices.map((d) => (
                  <p key={d.device} className="text-sm text-fg">
                    {d.device}: {NUMBER.format(d.ok_count)}/{NUMBER.format(d.sends)} thành công, trung vị{" "}
                    {formatMs(d.median_ms)}
                    {d.average_speed !== null ? `, ${DECIMAL.format(d.average_speed)} KB/s` : ""}
                  </p>
                ))}
              </div>
            </>
          )
        ) : null}
        {recentSends.length > 0 ? (
          <details className="flex flex-col gap-1">
            <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium text-muted">
              {NUMBER.format(recentSends.length)} lần gửi gần nhất
            </summary>
            <div className="flex flex-col divide-y divide-border">
              {recentSends.map((r, i) => (
                <div key={`${r.started_at}-${i}`} className="flex flex-col py-1.5 text-sm">
                  <span className={r.outcome === "ok" ? "text-fg" : "text-danger"}>
                    {formatTime(r.started_at)} · {r.outcome === "ok" ? "Xong" : `Hỏng ${r.fail_reason ?? ""}`} ·{" "}
                    {formatMs(r.duration_ms)} · {formatBytes(r.photo_bytes + r.thumb_bytes)} · {r.attempts} lần ·{" "}
                    {r.method === "chunk" ? "chia mẩu" : r.method === "direct" ? "thẳng Drive" : "một lần"}
                  </span>
                  <span className="text-muted">
                    {[r.created_by_name, r.project_name ?? "dự án đã xoá", r.device, r.network].filter(Boolean).join(" · ")}
                  </span>
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </Card>

      {/* Cloudflare */}
      <Card className="flex flex-col gap-3">
        <SectionTitle>Cloudflare</SectionTitle>
        {edgeTraffic === null ? (
          <p className="text-base text-muted">Đang tải...</p>
        ) : !edgeTraffic.configured ? (
          <p className="text-base text-muted">Chưa nối Cloudflare (chờ token chỉ đọc)</p>
        ) : edgeTraffic.error !== undefined ? (
          <p className="text-base text-danger">{edgeTraffic.error}</p>
        ) : (
          <>
            {edgeTraffic.range === "7d" && edgeTraffic.days_covered < 7 ? (
              <p className="text-sm text-muted">
                Cloudflare chỉ giữ {NUMBER.format(edgeTraffic.retention_days ?? edgeTraffic.days_covered)} ngày: số dưới
                là {NUMBER.format(edgeTraffic.days_covered)} ngày gần nhất.
              </p>
            ) : null}
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Số yêu cầu" value={NUMBER.format(edgeTraffic.requests)} />
              <Stat label="Byte ra" value={formatBytes(edgeTraffic.bytes_out)} />
              <Stat
                label="Byte vào"
                value={edgeTraffic.bytes_in === null ? "Không có" : formatBytes(edgeTraffic.bytes_in)}
              />
              <Stat label="Lỗi 5xx" value={NUMBER.format(edgeTraffic.server_errors)} />
              <Stat label="Lỗi 4xx (trừ 499)" value={NUMBER.format(edgeTraffic.client_errors)} />
              <Stat label="499 (máy bỏ giữa chừng)" value={NUMBER.format(edgeTraffic.status_499)} />
            </div>
            {edgeTraffic.bytes_in === null ? (
              <p className="text-sm text-muted">Cloudflare không cấp byte vào.</p>
            ) : null}
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-muted">Đường gửi ảnh</p>
              {edgeTraffic.upload_paths.length === 0 ? (
                <p className="text-sm text-muted">Không có yêu cầu nào.</p>
              ) : (
                edgeTraffic.upload_paths.map((p) => (
                  <p key={p.path} className="text-sm text-fg">
                    {p.path}: {NUMBER.format(p.requests)}
                  </p>
                ))
              )}
            </div>
          </>
        )}
      </Card>

      {canDelete ? (
        <Card className="flex flex-col gap-3">
          <SectionTitle>Dọn</SectionTitle>
          <div className="grid grid-cols-2 gap-2">
            <Button onClick={() => openCleanup("tmp")}>Mẩu tạm</Button>
            <Button onClick={() => openCleanup("pending")}>Lượt treo</Button>
            <Button onClick={() => openCleanup("originals")}>Ảnh gốc</Button>
            <Button variant="danger" onClick={() => openCleanup("project")}>
              Xoá dự án
            </Button>
          </div>
        </Card>
      ) : null}

      <Modal
        open={cleanup !== null}
        onClose={() => {
          if (!cleanupBusy) setCleanup(null);
        }}
        title={cleanup?.title ?? "Dọn"}
        width="narrow"
        footer={
          <>
            <Button variant="ghost" disabled={cleanupBusy} onClick={() => setCleanup(null)}>
              Huỷ
            </Button>
            <Button
              variant="danger"
              disabled={cleanupBusy || !deleteReady}
              onClick={() => void confirmCleanup()}
            >
              {cleanupBusy ? "Đang xoá..." : "Xoá"}
            </Button>
          </>
        }
      >
        {cleanup?.kind === "project" ? (
          <div className="flex flex-col gap-3">
            <Select
              className="text-base"
              value={deleteProjectId}
              aria-label="Dự án cần xoá"
              onChange={(e) => {
                setDeleteProjectId(e.target.value);
                setConfirmName("");
              }}
            >
              <option value="">Chọn dự án</option>
              {deleteTargets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </Select>
            {deleteTarget ? (
              <>
                <p className="text-base text-fg">
                  Sẽ xoá {deleteTarget.files === null ? "mọi" : NUMBER.format(deleteTarget.files)} tệp
                  {deleteTarget.bytes !== null ? `, ${formatBytes(deleteTarget.bytes)}` : ""} trên R2
                  {deleteTarget.rows > 0
                    ? ` và toàn bộ dữ liệu của dự án (${NUMBER.format(deleteTarget.rows)} lượt, mã tai, người, tai đã giao).`
                    : "."}
                </p>
                {driveTrashNote ? <p className="text-base text-fg">{driveTrashNote}</p> : null}
                <p className="text-sm text-muted">
                  Gõ lại đúng {deleteTarget.rows > 0 || projectNames.has(deleteTarget.id) ? "tên dự án" : "mã thư mục"}:{" "}
                  <span className="font-medium text-fg">{deleteTarget.confirm}</span>
                </p>
                {/* Ô không điều khiển: bàn phím tiếng Việt iOS xoá lùi rồi chèn lại dấu, ô `value={}` ghi đè giữa chừng làm hỏng chữ. `key` theo dự án: đổi dự án, mở lại hộp thì ô dựng mới, trống. */}
                <Input
                  key={deleteProjectId}
                  className="text-base"
                  defaultValue=""
                  aria-label="Gõ lại tên để xác nhận"
                  onInput={(e) => setConfirmName(e.currentTarget.value)}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                />
              </>
            ) : null}
            <p className="text-base font-medium text-danger">Thao tác này không hoàn tác.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-base text-fg">{cleanup?.summary}</p>
            {driveTrashNote ? <p className="text-base text-fg">{driveTrashNote}</p> : null}
            {cleanup?.kind === "originals" ? (
              <p className="text-base font-medium text-danger">Ảnh gốc đã xoá không lấy lại được.</p>
            ) : null}
          </div>
        )}
        {cleanupError ? <p className="mt-2 text-base text-danger">{cleanupError}</p> : null}
      </Modal>
    </div>
  );
}

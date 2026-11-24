"use client";

// `playsInline` để Safari không bung toàn màn.
// - Ảnh giữ dạng khung vẽ thô; dấu in lúc bấm Lưu vì dấu chứa mã, người nhận chọn sau khi chụp. Lớp dấu vẽ đè lên
// xem trước (camera hoặc ảnh đã chụp) để người chụp thấy trước dấu sẽ in.
// - Bố cục kiểu Camera iPhone: camera toàn màn, nút Home góc trên trái, chip dự án, nút Chụp tròn giữa đáy, ô thư
// viện góc dưới trái; chụp hoặc chọn ảnh xong mới hiện sheet chọn mã, người (`IntercomCaptureSheet`).
// - Một lượt một request (`uploadIntercomHandover`); `handover_id` máy sinh một lần, giữ qua mọi lần Thử lại tới
// khi lưu xong (route trả `already_done` nếu máy chủ đã lưu mà máy mất trả lời). Lưu xong mới sinh id mới.
// - Làm mới dữ liệu mỗi 15 giây và ngay sau mỗi lần lưu.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Camera, ChevronDown, ChevronLeft, Home, Images, Search, X } from "lucide-react";
import {
  STAMP_STAGE_LABELS,
  decodeUprightImage,
  drawStamp,
  loadStampAvatar,
  readLibraryPhotoMeta,
  type StampInput,
  type StampOrigin,
  type StampSource,
} from "@/lib/photoStamp";
import {
  INTERCOM_FAULT_REASON_MAX,
  createIntercomPerson,
  getIntercomBoard,
  markIntercomIssueFault,
  IntercomUploadError,
  uploadIntercomHandover,
  type IntercomBoard,
  type IntercomIssue,
  type IntercomKind,
  type IntercomUploadMeta,
} from "@/lib/intercom/staffIntercom";
import {
  INTERCOM_STORED_ON_R2_TEXT,
  getIntercomProjectStorage,
  uploadIntercomHandoverDrive,
} from "@/lib/intercom/staffIntercomDrive";
import {
  INTERCOM_PHONE_ERROR,
  INTERCOM_PHONE_INPUT_MAX,
  normalizeIntercomPhone,
} from "@/lib/intercom/staffIntercomProject";
import { useWork } from "@/adapters/SessionGate";
import { cn } from "@/lib/cn";
import {
  addDays,
  compactCodes,
  compareCodes,
  departmentLabel,
  issueRowKey,
  knownDepartments,
  openUnitIds,
  shortDate,
  UNNAMED_DEPARTMENT,
  stampCodes,
  vnDate,
} from "./intercomView";
import { drawStageBadge, stageBadgeLabel } from "./intercomStageBadge";
import { IntercomCaptureSheet } from "./IntercomCaptureSheet";
import { IntercomUnitPicker } from "./IntercomUnitPicker";
import { intercomPhotoLimits, readIntercomCaptureSettings } from "./intercomCaptureSettings";
import { useImageZoom } from "./useImageZoom";
import { useIntercomProject } from "./useIntercomProject";

const REFRESH_MS = 15000;
const THUMB_LONG_SIDE = 480;
const THUMB_QUALITY = 0.8;
// Trần ảnh lần gửi đầu, cạnh dài, dãy co cạnh, trần lần gửi lại: theo mức "Chất lượng ảnh gửi", đọc
// `intercomPhotoLimits` mỗi lần chụp, chọn ảnh, Lưu. Nén: bắt đầu 0,85, giảm dần; tới sàn chất lượng thì co cạnh
// dài.
const PHOTO_START_QUALITY = 0.85;
const PHOTO_MIN_QUALITY = 0.5;
const PHOTO_QUALITY_STEP = 0.1;
const PHOTO_SHRINK = 0.85;
const PHOTO_MAX_SHRINKS = 4;
const UPLOAD_TIMEOUT_MS = 60000;
/** Hạn mỗi lượt tự gửi lại (từ lượt thứ 2). */
const UPLOAD_RETRY_TIMEOUT_MS = 45000;
/** Câu báo xong nổi trên camera tự ẩn sau khoảng này. */
const NOTICE_HIDE_MS = 4000;
/** Nhịp vẽ lại lớp dấu xem trước. */
const OVERLAY_TICK_MS = 1000;
/** Khung gợi ý tên: cao tối đa như cũ (17rem), tối thiểu đủ thấy hơn hai dòng khi chỗ trống quá hẹp. */
const PERSON_LIST_MAX_PX = 272;
const PERSON_LIST_MIN_PX = 132;

const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: "environment",
  width: { ideal: 1920 },
  height: { ideal: 1080 },
};
const MUTE_GRACE_MS = 1500;
const VIDEO_SETTLE_MS = 2000;
const MEDIA_REQUEST_STALE_MS = 8000;

type Position = { latitude: number; longitude: number };

/** Ảnh đã chụp hoặc đã chọn, chưa in dấu. */
type Shot = {
  canvas: HTMLCanvasElement;
  previewUrl: string;
  /** Khoá ảnh, sinh mỗi lần chụp hoặc chọn ảnh mới; vào dấu vân nội dung lượt (gắn `handover_id`). */
  key: string;
  source: StampSource;
  takenAt: Date;
  /** Gửi `taken_at`: ảnh thư viện không có giờ chụp thì null (máy chủ lấy giờ tải). */
  sentTakenAt: string | null;
  timeSource: StampOrigin;
  latitude: number | null;
  longitude: number | null;
  locationSource: StampOrigin | null;
};

/** `code`: mã chẩn đoán (lý do lỗi mạng khi lưu), hiện chữ nhỏ dưới câu báo. */
type Notice = { tone: "success" | "error"; text: string; code?: string };

/** Tiến độ Lưu: nén ảnh, tải lên, lưu. `percent` là tỉ lệ cả lượt (0 tới 100). */
type SaveProgress = { label: string; percent: number };

/** Tai Lỗi chưa ghi được tình trạng sau khi lượt thu đã lưu: giữ để bấm ghi lại. */
type PendingFault = { issueId: string; code: string; reason: string };

/** Tỉ lệ cả lượt dành cho từng bước: nén tới 15, tải lên tới 90, lưu phần còn lại. */
const PROGRESS_COMPRESSED = 15;
const PROGRESS_SENT = 90;

function encodeImage(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((done) => canvas.toBlob((blob) => done(blob), "image/jpeg", quality));
}

function drawScaled(
  source: CanvasImageSource,
  width: number,
  height: number,
  longSide: number,
): HTMLCanvasElement | null {
  const scale = Math.min(1, longSide / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Trần ảnh theo mức chất lượng đang đặt ở màn Tôi (lưu trên máy). */
function currentPhotoLimits() {
  return intercomPhotoLimits(readIntercomCaptureSettings().photoQuality);
}

/**
 * JPEG không quá `maxBytes`: giảm chất lượng từng nấc, tới sàn thì co khung (theo `longSides` trước, hết thì
 * `PHOTO_SHRINK`) rồi thử lại. Trả khung đã dùng.
 */
async function encodeUnderLimit(
  start: HTMLCanvasElement,
  maxBytes: number,
  longSides: readonly number[] = [],
): Promise<{ blob: Blob; canvas: HTMLCanvasElement } | null> {
  let canvas = start;
  let last: Blob | null = null;
  for (let shrink = 0; shrink <= PHOTO_MAX_SHRINKS; shrink += 1) {
    for (let q = PHOTO_START_QUALITY; q >= PHOTO_MIN_QUALITY - 1e-6; q -= PHOTO_QUALITY_STEP) {
      last = await encodeImage(canvas, q);
      if (!last) return null;
      if (last.size <= maxBytes) return { blob: last, canvas };
    }
    const currentLongSide = Math.max(canvas.width, canvas.height);
    const nextSide = longSides.find((side) => side < currentLongSide);
    const smaller = drawScaled(
      start,
      start.width,
      start.height,
      nextSide ?? currentLongSide * PHOTO_SHRINK,
    );
    if (!smaller) break;
    canvas = smaller;
  }
  return last ? { blob: last, canvas } : null;
}

/** Bỏ dấu tiếng Việt, chữ thường: tìm "nguyen" ra "Nguyễn". */
function searchable(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
}

function newHandoverId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // Máy cũ không có `randomUUID`: dựng uuid v4 từ `getRandomValues`.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function IntercomCaptureScreen() {
  const { profile } = useWork();
  const { projects, projectId, selectProject, error: projectError } = useIntercomProject();
  const boardHref = "/";

  const [board, setBoard] = useState<IntercomBoard | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Ghi theo mã dự án, để đổi dự án thì câu cũ tự hết hiệu lực. Đọc lỗi thì để màn chụp như cũ: đường tải vẫn chặn.
  const [driveUnreadyProjectId, setDriveUnreadyProjectId] = useState<string | null>(null);
  const currentStorageKind = projects?.find((p) => p.id === projectId)?.storage_kind;
  useEffect(() => {
    if (!projectId || currentStorageKind !== "drive") return;
    let alive = true;
    getIntercomProjectStorage(projectId)
      .then((storage) => {
        if (!alive) return;
        const unready = storage?.storage_kind === "drive" && (!storage.account_id || !storage.folder_id);
        setDriveUnreadyProjectId((prev) => (unready ? projectId : prev === projectId ? null : prev));
      })
      .catch(() => {
        // Đọc lỗi: giữ màn như cũ, đường tải vẫn trả 409 khi dự án chưa nối.
      });
    return () => {
      alive = false;
    };
  }, [currentStorageKind, projectId]);
  const [tab, setTab] = useState<IntercomKind>("deliver");
  // `null` là màn chụp thường (vào từ nút "Chụp giao").
  const [collectHandoverId, setCollectHandoverId] = useState<string | null>(null);
  // Cờ này bật khi bấm "Chụp ảnh thu", tắt khi "‹ Chọn lại" hoặc lưu xong còn ở lại màn. Giao không đọc cờ này.
  const [collectCameraOpen, setCollectCameraOpen] = useState(false);
  const router = useRouter();

  // Lựa chọn tab Giao.
  const [personId, setPersonId] = useState<string | null>(null);
  const [personQuery, setPersonQuery] = useState("");
  const [byDepartment, setByDepartment] = useState(false);
  // Lưu như giao bộ phận "Chưa rõ tên", Nhóm 1; điền tên sau ở Dashboard. Công tắc "Giao cho bộ phận" bật thì bộ
  // phận gõ tay thắng.
  const [unnamed, setUnnamed] = useState(false);
  const [department, setDepartment] = useState("");
  const [group, setGroup] = useState(1);
  const [unitIds, setUnitIds] = useState<Set<string>>(new Set());
  // Lựa chọn tab Nhận.
  const [issueIds, setIssueIds] = useState<Set<string>>(new Set());
  // Tình trạng lúc thu: có khoá là Lỗi, giá trị là lý do; không có khoá là Bình thường (mặc định).
  const [faultReasons, setFaultReasons] = useState<Map<string, string>>(new Map());
  const [pendingFaults, setPendingFaults] = useState<PendingFault[]>([]);
  const [faultRetryBusy, setFaultRetryBusy] = useState(false);

  const [shot, setShot] = useState<Shot | null>(null);
  // Thu bước 1: tấm danh sách tai che camera (chưa bấm "Chụp ảnh thu", hoặc đã "‹ Chọn lại").
  const collectListOpen = tab === "collect" && !shot && !collectCameraOpen;
  // Ảnh vừa chụp phủ phần màn trên sheet: bấm phóng to toàn màn.
  const [previewExpanded, setPreviewExpanded] = useState(false);
  useEffect(() => {
    if (!shot) setPreviewExpanded(false);
  }, [shot]);
  // Về 1x khi đổi ảnh, khi mở hay đóng toàn màn. Chạm một lần ở 1x giữ hành vi cũ, chạy sau khoảng chạm hai lần.
  const zoomResetKey = `${shot?.key ?? ""}:${previewExpanded ? "expanded" : "overlay"}`;
  const expandPreview = useCallback(() => setPreviewExpanded(true), []);
  const collapsePreview = useCallback(() => setPreviewExpanded(false), []);
  const overlayZoom = useImageZoom({
    resetKey: zoomResetKey,
    contentWidth: shot?.canvas.width ?? 0,
    contentHeight: shot?.canvas.height ?? 0,
    onSingleTap: expandPreview,
  });
  const expandedZoom = useImageZoom({
    resetKey: zoomResetKey,
    contentWidth: shot?.canvas.width ?? 0,
    contentHeight: shot?.canvas.height ?? 0,
    onSingleTap: collapsePreview,
  });
  const sheetRootRef = useRef<HTMLDivElement | null>(null);
  const [sheetTop, setSheetTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const root = shot ? sheetRootRef.current : null;
    if (!root) {
      setSheetTop(null);
      return;
    }
    const measure = () => {
      const top = Math.max(0, Math.round(root.getBoundingClientRect().top));
      setSheetTop((prev) => (prev === top ? prev : top));
    };
    measure();
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(root);
    const styleObserver = new MutationObserver(measure);
    styleObserver.observe(root, { attributes: true, attributeFilter: ["style"] });
    root.addEventListener("transitionend", measure);
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", measure);
    viewport?.addEventListener("scroll", measure);
    window.addEventListener("resize", measure);
    return () => {
      resizeObserver.disconnect();
      styleObserver.disconnect();
      root.removeEventListener("transitionend", measure);
      viewport?.removeEventListener("resize", measure);
      viewport?.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [shot]);
  // Ảnh "Chọn ảnh" mỗi lần chọn ảnh mới về mặc định của cài đặt "Chèn dấu giờ, mã cho ảnh tải lên" ở màn Tôi; ảnh
  // chụp bằng camera trong app luôn in dấu.
  const [libraryStamp, setLibraryStamp] = useState(false);
  const shouldStamp = !shot || shot.source !== "library" || libraryStamp;
  // Lựa chọn tay gắn với khoá ảnh (`shot.key`): chọn ảnh khác thì về mặc định; Thử lại cùng ảnh giữ ngày đã chọn.
  // Ảnh camera không gửi ngày.
  const [pickedWorkDate, setPickedWorkDate] = useState<{ shotKey: string; date: string } | null>(null);
  const projectDays = useMemo(() => {
    if (!board) return [];
    return Array.from({ length: board.project.day_count }, (_, i) => addDays(board.project.start_date, i));
  }, [board]);
  const workDate = useMemo(() => {
    if (!shot || shot.source !== "library" || projectDays.length === 0) return null;
    if (pickedWorkDate && pickedWorkDate.shotKey === shot.key && projectDays.includes(pickedWorkDate.date)) {
      return pickedWorkDate.date;
    }
    const natural = vnDate(shot.sentTakenAt ?? new Date());
    const first = projectDays[0];
    const last = projectDays[projectDays.length - 1];
    return natural < first ? first : natural > last ? last : natural;
  }, [pickedWorkDate, projectDays, shot]);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const [progress, setProgress] = useState<SaveProgress | null>(null);
  // `handover_id` gắn với dấu vân nội dung lượt: nội dung khác thì sinh id mới; chỉ giữ id khi Thử lại đúng nội dung
  // cũ sau lỗi mạng hoặc 5xx (máy chủ gặp id đã xong trả kết quả CŨ, không đọc lựa chọn mới).
  const handoverRef = useRef<{ id: string; fingerprint: string } | null>(null);
  // Khoá đồng bộ: bấm Lưu dồn dập không gửi hai lượt (state `saving` chỉ cập nhật sau lần vẽ kế).
  const savingRef = useRef(false);
  // Ô gõ chữ không điều khiển (bàn phím tiếng Việt iOS bỏ dấu bằng xoá lùi rồi chèn lại, ô `value` ghi đè giữa
  // chuỗi).
  const personInputRef = useRef<HTMLInputElement | null>(null);
  const newDepartmentInputRef = useRef<HTMLInputElement | null>(null);
  const newPhoneInputRef = useRef<HTMLInputElement | null>(null);

  // Dữ liệu

  // Lời đáp `getIntercomBoard` có thể về sai thứ tự: bỏ lời của dự án khác và lời cũ hơn lời đã nhận. Không so `seq`
  // với lượt mới nhất: lời đáp lâu hơn `REFRESH_MS` sẽ bị nhịp sau huỷ mãi, màn kẹt ở Đang tải.
  const activeProjectRef = useRef(projectId);
  activeProjectRef.current = projectId;
  const reloadSeqRef = useRef(0);
  const appliedSeqRef = useRef(0);

  // Trả bản vừa áp; `null` khi không áp được (lỗi mạng, lời cũ, dự án khác).
  const reload = useCallback(async (): Promise<IntercomBoard | null> => {
    if (!projectId) return null;
    const seq = ++reloadSeqRef.current;
    try {
      const next = await getIntercomBoard(projectId);
      if (projectId !== activeProjectRef.current || seq < appliedSeqRef.current) return null;
      appliedSeqRef.current = seq;
      setBoard(next);
      setLoadError(null);
      return next;
    } catch (e) {
      if (projectId !== activeProjectRef.current || seq < appliedSeqRef.current) return null;
      appliedSeqRef.current = seq;
      setLoadError(e instanceof Error ? e.message : "Chưa tải được dữ liệu.");
      return null;
    }
  }, [projectId]);

  useEffect(() => {
    setBoard(null);
    setPersonId(null);
    setPersonQuery("");
    if (personInputRef.current) personInputRef.current.value = "";
    setUnnamed(false);
    setUnitIds(new Set());
    setIssueIds(new Set());
    setFaultReasons(new Map());
    setPendingFaults([]);
    setCanRetry(false);
    handoverRef.current = null;
    void reload();
    const timer = window.setInterval(() => void reload(), REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reload]);

  const outUnits = useMemo(() => (board ? openUnitIds(board) : new Set<string>()), [board]);
  const openIssues = useMemo(() => (board ? board.issues.filter((i) => !i.collect_handover_id) : []), [board]);
  const peopleById = useMemo(() => new Map((board?.people ?? []).map((p) => [p.id, p])), [board]);
  const departments = useMemo(() => (board ? knownDepartments(board) : []), [board]);
  // `group_count` 1 thì Nhóm luôn là 1, ẩn ô chọn Nhóm.
  const groupCount = board?.project.group_count ?? 1;

  // Máy khác vừa giao, thu: bỏ khỏi lựa chọn các mã không còn chọn được.
  useEffect(() => {
    setUnitIds((prev) => {
      const next = new Set([...prev].filter((id) => !outUnits.has(id)));
      return next.size === prev.size ? prev : next;
    });
    const openIds = new Set(openIssues.map((i) => i.id));
    setIssueIds((prev) => {
      const next = new Set([...prev].filter((id) => openIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [outUnits, openIssues]);

  // Query từ Dashboard: `?project=<dự án>` (nút "Chụp giao", cả nút "Thu") chọn đúng dự án; `&collect=<lượt giao>`
  // (nút "Thu") mở chế độ Thu về, chọn sẵn các tai CÒN NGOÀI của lượt đó sau khi tải dữ liệu đúng dự án. Đọc một lần
  // rồi xoá query khỏi thanh địa chỉ.
  const pendingProjectRef = useRef<string | null>(null);
  const pendingCollectRef = useRef<{ projectId: string | null; handoverId: string } | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const wantProject = params.get("project");
    const handoverId = params.get("collect");
    if (!wantProject && !handoverId) return;
    pendingProjectRef.current = wantProject;
    if (handoverId) {
      pendingCollectRef.current = { projectId: wantProject, handoverId };
      setCollectHandoverId(handoverId);
      setTab("collect");
    }
    window.history.replaceState(window.history.state, "", window.location.pathname);
  }, []);
  useEffect(() => {
    const want = pendingProjectRef.current;
    if (!want || !projects) return;
    pendingProjectRef.current = null;
    if (!projects.some((p) => p.id === want)) {
      pendingCollectRef.current = null;
      setCollectHandoverId(null);
      setTab("deliver");
      return;
    }
    if (projectId !== want) selectProject(want);
  }, [projectId, projects, selectProject]);
  useEffect(() => {
    const pending = pendingCollectRef.current;
    if (!pending || !board) return;
    if (pending.projectId && board.project.id !== pending.projectId) return;
    pendingCollectRef.current = null;
    const ids = board.issues
      .filter((i) => i.deliver_handover_id === pending.handoverId && !i.collect_handover_id)
      .map((i) => i.id);
    handoverRef.current = null;
    setCanRetry(false);
    setNotice(null);
    setTab("collect");
    setIssueIds(new Set(ids));
  }, [board]);

  const selectedPerson = personId ? (peopleById.get(personId) ?? null) : null;

  const rowLabel = useCallback(
    (issue: Pick<IntercomIssue, "person_id" | "department" | "group_no">) => {
      const person = issue.person_id ? peopleById.get(issue.person_id) : null;
      return person ? person.full_name : departmentLabel(issue.department, issue.group_no);
    },
    [peopleById],
  );

  const selectedCodes = useMemo(() => {
    if (!board) return [] as string[];
    if (tab === "deliver") return board.units.filter((u) => unitIds.has(u.id)).map((u) => u.code);
    return openIssues.filter((i) => issueIds.has(i.id)).map((i) => i.unit_code);
  }, [board, issueIds, openIssues, tab, unitIds]);

  const recipientLabel = useMemo(() => {
    if (tab === "deliver") {
      if (byDepartment) return department.trim() ? departmentLabel(department.trim(), group) : "";
      if (unnamed) return UNNAMED_DEPARTMENT;
      return selectedPerson?.full_name ?? "";
    }
    const labels = [...new Set(openIssues.filter((i) => issueIds.has(i.id)).map(rowLabel))];
    if (labels.length <= 2) return labels.join(", ");
    return `${labels.length} người, bộ phận`;
  }, [byDepartment, department, group, issueIds, openIssues, rowLabel, selectedPerson, tab, unnamed]);

  // Camera, vị trí, avatar

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const avatarRef = useRef<ImageBitmap | null>(null);
  const positionRef = useRef<Position | null>(null);
  const mountedRef = useRef(true);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  // Nút "Mở camera" còn cho ca lỗi quyền. Cờ này nhớ đã xin để nhánh `visibilitychange` chỉ xin lại khi trước đó đã
  // mở.
  const cameraRequestedRef = useRef(false);
  const [cameraStarting, setCameraStarting] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Lượt treo (hộp hỏi quyền bị bỏ lơ) quá MEDIA_REQUEST_STALE_MS thì nhả khoá, bật lại nút "Mở camera"; số lượt
  // `cameraSeqRef` để lượt cũ trả về muộn tự dừng rãnh của nó, không đè lượt mới.
  const cameraPendingRef = useRef(false);
  const cameraSeqRef = useRef(0);
  // Mốc gán luồng vào `<video>` gần nhất: nút Chụp chỉ mở lại camera khi luồng đã gắn quá lâu mà vẫn chưa có hình.
  const videoBoundAtRef = useRef(0);

  const acquireCamera = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("Trình duyệt này chưa mở được camera. Vẫn chọn ảnh có sẵn được.");
      return;
    }
    if (cameraPendingRef.current) return;
    const seq = ++cameraSeqRef.current;
    cameraPendingRef.current = true;
    setCameraStarting(true);
    const staleTimer = setTimeout(() => {
      if (seq !== cameraSeqRef.current) return;
      cameraPendingRef.current = false;
      if (mountedRef.current) setCameraStarting(false);
    }, MEDIA_REQUEST_STALE_MS);
    try {
      const next = await navigator.mediaDevices.getUserMedia({
        video: VIDEO_CONSTRAINTS,
        audio: false,
      });
      // Gỡ màn, tab đã ẩn trong lúc chờ quyền, hoặc đã có lượt mới hơn: trả camera ngay (hiện lại thì `visibilitychange`
      // xin lại).
      if (!mountedRef.current || document.visibilityState === "hidden" || seq !== cameraSeqRef.current) {
        next.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = next;
      setCameraError(null);
      setStream(next);
    } catch {
      if (mountedRef.current && seq === cameraSeqRef.current) {
        setCameraError("Chưa mở được camera (máy chưa cho quyền hoặc không có camera). Vẫn chọn ảnh có sẵn được.");
        // `restartCamera` đã dừng rãnh cũ: bỏ khỏi state để hiện lại nút "Mở camera", tắt nút Chụp.
        if (!streamRef.current) setStream(null);
      }
    } finally {
      clearTimeout(staleTimer);
      if (seq === cameraSeqRef.current) {
        cameraPendingRef.current = false;
        if (mountedRef.current) setCameraStarting(false);
      }
    }
  }, []);

  const restartCamera = useCallback(() => {
    if (cameraPendingRef.current) return;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void acquireCamera();
  }, [acquireCamera]);

  const openCamera = useCallback(() => {
    cameraRequestedRef.current = true;
    void acquireCamera();
  }, [acquireCamera]);

  // Lỗi quyền thì vẫn hiện nút "Mở camera", chọn ảnh vẫn dùng được. Lần vẽ đầu `tab` còn là "deliver" nhưng hiệu ứng
  // đọc query ở trên đã gán `pendingCollectRef`, nên lối Thu không mở; Thu rơi về Giao (dự án không còn, đổi dự án
  // tay) thì `tab` đổi, hiệu ứng chạy lại và mở như Giao.
  useEffect(() => {
    if (tab !== "deliver" || pendingCollectRef.current || cameraRequestedRef.current) return;
    openCamera();
  }, [openCamera, tab]);

  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    },
    [],
  );

  // Lần vào thứ hai quyền camera đã có nên `getUserMedia` xong TRƯỚC khi `<video>` gắn vào; effect theo `stream` gặp
  // `videoRef` rỗng rồi không chạy lại, khung đen mà rãnh vẫn sống. Ref dạng hàm gán luồng ngay khi `<video>` gắn
  // vào.
  const bindVideo = useCallback((video: HTMLVideoElement | null) => {
    videoRef.current = video;
    const current = streamRef.current;
    if (!video || !current || video.srcObject === current) return;
    video.srcObject = current;
    videoBoundAtRef.current = Date.now();
    void video.play().catch(() => undefined);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.srcObject !== stream) {
      video.srcObject = stream;
      videoBoundAtRef.current = Date.now();
    }
    if (stream) void video.play().catch(() => undefined);
  }, [stream]);

  // `mute` thường chỉ là ngắt tạm (iOS mở bộ chọn ảnh, Trung tâm điều khiển, cuộc gọi) và tự `unmute`: chờ
  // MUTE_GRACE_MS, còn `mute` mà màn vẫn hiện, có focus mới xin lại.
  useEffect(() => {
    const track = stream?.getVideoTracks()[0];
    if (!track) return;
    let muteTimer: ReturnType<typeof setTimeout> | null = null;
    const clearMuteTimer = () => {
      if (muteTimer !== null) clearTimeout(muteTimer);
      muteTimer = null;
    };
    const onEnded = () => {
      clearMuteTimer();
      if (!cameraRequestedRef.current || document.visibilityState !== "visible") return;
      if (streamRef.current !== stream) return;
      restartCamera();
    };
    const onMute = () => {
      clearMuteTimer();
      muteTimer = setTimeout(() => {
        muteTimer = null;
        if (!cameraRequestedRef.current || streamRef.current !== stream) return;
        if (!track.muted || track.readyState !== "live") return;
        if (document.visibilityState !== "visible" || !document.hasFocus()) return;
        restartCamera();
      }, MUTE_GRACE_MS);
    };
    track.addEventListener("mute", onMute);
    track.addEventListener("unmute", clearMuteTimer);
    track.addEventListener("ended", onEnded);
    return () => {
      clearMuteTimer();
      track.removeEventListener("mute", onMute);
      track.removeEventListener("unmute", clearMuteTimer);
      track.removeEventListener("ended", onEnded);
    };
  }, [restartCamera, stream]);

  // Chọn ảnh thư viện xong mà rãnh hình đã dừng, hoặc mất hẳn (xin lại hỏng giữa chừng), thì xin lại camera.
  const reacquireIfEnded = useCallback(() => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (cameraRequestedRef.current && (!track || track.readyState === "ended")) void acquireCamera();
  }, [acquireCamera]);

  useEffect(() => {
    window.addEventListener("focus", reacquireIfEnded);
    return () => window.removeEventListener("focus", reacquireIfEnded);
  }, [reacquireIfEnded]);

  // Ẩn tab thì tắt camera (pin iPhone); hiện lại thì chỉ xin lại khi camera đã được xin trước đó (vào Giao, bấm "Mở
  // camera" hay "Chụp ảnh thu"), kể cả khi đang ở tấm danh sách Thu.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        setStream(null);
        return;
      }
      const track = streamRef.current?.getVideoTracks()[0];
      if (cameraRequestedRef.current && (!track || track.readyState !== "live")) void acquireCamera();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [acquireCamera]);

  useEffect(() => {
    if (!navigator.geolocation) return;
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        positionRef.current = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
        };
      },
      () => undefined,
      { enableHighAccuracy: true, maximumAge: 10000 },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  const avatarUrl = profile?.avatar_url ?? null;
  useEffect(() => {
    let cancelled = false;
    void loadStampAvatar(avatarUrl).then((bitmap) => {
      if (cancelled) bitmap?.close();
      else avatarRef.current = bitmap;
    });
    return () => {
      cancelled = true;
      avatarRef.current?.close();
      avatarRef.current = null;
    };
  }, [avatarUrl]);

  const stampText = useMemo(() => {
    const codes = selectedCodes.length > 0 ? stampCodes(selectedCodes) : "?";
    return recipientLabel ? `${codes} · ${recipientLabel}` : codes;
  }, [recipientLabel, selectedCodes]);

  const stampBase = useCallback(
    (): Pick<StampInput, "stageLabel" | "orderCode" | "staffName" | "avatar"> => ({
      stageLabel: tab === "deliver" ? STAMP_STAGE_LABELS.delivery : STAMP_STAGE_LABELS.return,
      orderCode: stampText,
      staffName: profile?.full_name ?? null,
      avatar: avatarRef.current,
    }),
    [profile?.full_name, stampText, tab],
  );

  // Lớp dấu xem trước: đè lên camera (giờ chạy) hoặc lên ảnh đã chụp (giờ của ảnh).
  useEffect(() => {
    const paint = () => {
      const overlay = overlayRef.current;
      const ctx = overlay?.getContext("2d");
      if (!overlay || !ctx) return;
      let width = 0;
      let height = 0;
      let stamp: Pick<StampInput, "takenAt" | "source" | "timeSource" | "latitude" | "longitude" | "locationSource">;
      if (shot) {
        width = shot.canvas.width;
        height = shot.canvas.height;
        stamp = shot;
        if (!shouldStamp) {
          if (overlay.width !== width) overlay.width = width;
          if (overlay.height !== height) overlay.height = height;
          ctx.clearRect(0, 0, width, height);
          return;
        }
      } else {
        const video = videoRef.current;
        if (!video || video.videoWidth === 0 || video.videoHeight === 0) return;
        width = video.videoWidth;
        height = video.videoHeight;
        const position = positionRef.current;
        stamp = {
          takenAt: new Date(),
          source: "camera",
          timeSource: "device",
          latitude: position?.latitude ?? null,
          longitude: position?.longitude ?? null,
          locationSource: position ? "device" : null,
        };
      }
      if (overlay.width !== width) overlay.width = width;
      if (overlay.height !== height) overlay.height = height;
      ctx.clearRect(0, 0, width, height);
      drawStamp(ctx, { ...stampBase(), ...stamp, width, height });
      drawStageBadge(ctx, { label: stageBadgeLabel(tab), width, height });
    };
    paint();
    const timer = window.setInterval(paint, OVERLAY_TICK_MS);
    const video = videoRef.current;
    video?.addEventListener("loadedmetadata", paint);
    video?.addEventListener("resize", paint);
    return () => {
      window.clearInterval(timer);
      video?.removeEventListener("loadedmetadata", paint);
      video?.removeEventListener("resize", paint);
    };
    // `previewExpanded`: lớp dấu dời giữa ảnh phủ trên sheet và ảnh phóng to (canvas gắn lại), vẽ lại ngay. Canvas vẽ
    // theo cỡ gốc của ảnh, CSS `object-contain` co theo khung nên khung ảnh phủ đổi cao không cần vẽ lại.
  }, [shot, previewExpanded, shouldStamp, stampBase, stream, tab]);

  // Chụp, chọn ảnh

  const replaceShot = useCallback(
    async (canvas: HTMLCanvasElement, rest: Omit<Shot, "canvas" | "previewUrl" | "key">) => {
      const preview = await encodeImage(canvas, 0.8);
      if (!preview) return false;
      handoverRef.current = null;
      setCanRetry(false);
      setLibraryStamp(readIntercomCaptureSettings().stampLibraryByDefault);
      setShot((old) => {
        if (old) URL.revokeObjectURL(old.previewUrl);
        return {
          ...rest,
          canvas,
          previewUrl: URL.createObjectURL(preview),
          key: newHandoverId(),
        };
      });
      return true;
    },
    [],
  );

  useEffect(
    () => () => {
      setShot((old) => {
        if (old) URL.revokeObjectURL(old.previewUrl);
        return null;
      });
    },
    [],
  );

  const capture = useCallback(async () => {
    const video = videoRef.current;
    const track = streamRef.current?.getVideoTracks()[0];
    // Rãnh hình đã dừng (hệ điều hành lấy camera, tab vừa ẩn) thì không chụp khung đứng hình hoặc đen: xin lại camera.
    if (!track || track.readyState !== "live") {
      void acquireCamera();
      setNotice({
        tone: "error",
        text: "Camera chưa sẵn sàng, đang mở lại. Bấm Chụp lần nữa.",
      });
      return;
    }
    if (
      !video ||
      video.srcObject !== streamRef.current ||
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      video.videoWidth === 0 ||
      video.videoHeight === 0
    ) {
      // `<video>` thiếu luồng thì chỉ gắn lại (không xin camera, không giết rãnh tốt); camera vừa mở chưa kịp lên hình
      // thì chờ. Chỉ mở lại khi rãnh `mute` hoặc luồng đã gắn quá lâu vẫn không hình.
      if (video && video.srcObject !== streamRef.current) {
        video.srcObject = streamRef.current;
        videoBoundAtRef.current = Date.now();
        void video.play().catch(() => undefined);
      } else if (video && (track.muted || Date.now() - videoBoundAtRef.current > VIDEO_SETTLE_MS)) {
        restartCamera();
        setNotice({
          tone: "error",
          text: "Đang mở lại camera, bấm Chụp lần nữa.",
        });
        return;
      } else if (video?.paused) {
        void video.play().catch(() => undefined);
      }
      setNotice({
        tone: "error",
        text: "Camera đang lên hình, bấm Chụp lần nữa.",
      });
      return;
    }
    const canvas = drawScaled(video, video.videoWidth, video.videoHeight, currentPhotoLimits().firstLongSide);
    const position = positionRef.current;
    const takenAt = new Date();
    const ok =
      canvas &&
      (await replaceShot(canvas, {
        source: "camera",
        takenAt,
        sentTakenAt: takenAt.toISOString(),
        timeSource: "device",
        latitude: position?.latitude ?? null,
        longitude: position?.longitude ?? null,
        locationSource: position ? "device" : null,
      }));
    if (!ok)
      setNotice({
        tone: "error",
        text: "Chưa chụp được ảnh, thử lại giúp tôi.",
      });
    else setNotice(null);
  }, [acquireCamera, replaceShot, restartCamera]);

  const pickLibrary = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      try {
        if (!file.type.startsWith("image/")) throw new Error("not image");
        // Đọc EXIF TRƯỚC khi vẽ lại (vẽ lại là mất EXIF).
        const meta = await readLibraryPhotoMeta(file);
        const bitmap = await decodeUprightImage(file);
        const canvas = drawScaled(bitmap, bitmap.width, bitmap.height, currentPhotoLimits().firstLongSide);
        bitmap.close();
        const position = positionRef.current;
        const hasFilePosition = meta.latitude !== null && meta.longitude !== null;
        const ok =
          canvas &&
          (await replaceShot(canvas, {
            source: "library",
            takenAt: meta.takenAt ?? new Date(),
            sentTakenAt: meta.takenAt ? meta.takenAt.toISOString() : null,
            timeSource: meta.takenAt ? "exif" : "device",
            latitude: hasFilePosition ? meta.latitude : (position?.latitude ?? null),
            longitude: hasFilePosition ? meta.longitude : (position?.longitude ?? null),
            locationSource: hasFilePosition ? "exif" : position ? "device" : null,
          }));
        if (!ok) throw new Error("draw failed");
        setNotice(null);
      } catch {
        setNotice({
          tone: "error",
          text: "Chưa đọc được ảnh, chọn lại giúp tôi.",
        });
      }
      reacquireIfEnded();
    },
    [reacquireIfEnded, replaceShot],
  );

  const discardShot = useCallback(() => {
    handoverRef.current = null;
    setCanRetry(false);
    setShot((old) => {
      if (old) URL.revokeObjectURL(old.previewUrl);
      return null;
    });
  }, []);

  // Thu bước 1 sang bước 2: xin camera ngay trong cú bấm (iPhone Safari hỏi quyền đúng lúc bấm); camera đã sống thì
  // thôi.
  const openCollectCamera = useCallback(() => {
    setCollectCameraOpen(true);
    if (!streamRef.current) openCamera();
  }, [openCamera]);

  // "‹ Chọn lại": về tấm danh sách, giữ tai và lý do đã chọn; có ảnh thì bỏ. Camera để sống.
  const backToCollectList = useCallback(() => {
    discardShot();
    setCollectCameraOpen(false);
  }, [discardShot]);

  const [lastThumbUrl, setLastThumbUrl] = useState<string | null>(null);
  useEffect(
    () => () => {
      if (lastThumbUrl) URL.revokeObjectURL(lastThumbUrl);
    },
    [lastThumbUrl],
  );

  useEffect(() => {
    if (shot || notice?.tone !== "success") return;
    const timer = window.setTimeout(() => setNotice((current) => (current === notice ? null : current)), NOTICE_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [notice, shot]);

  useEffect(() => {
    if (shot) return;
    const video = videoRef.current;
    if (video && video.srcObject && video.paused) void video.play().catch(() => undefined);
  }, [shot]);

  // Chọn người, mã

  const choosePerson = useCallback((id: string) => {
    setPersonId(id);
    setPersonQuery("");
    if (personInputRef.current) personInputRef.current.value = "";
    setNewPersonOpen(false);
  }, []);

  const yesterdayUnits = useMemo(() => {
    if (!board || !personId) return [];
    const before = board.issues.filter((i) => i.person_id === personId && i.work_date < board.today);
    const lastDate = before.reduce<string | null>((max, i) => (!max || i.work_date > max ? i.work_date : max), null);
    return before
      .filter((i) => i.work_date === lastDate && !outUnits.has(i.unit_id))
      .sort((a, b) => compareCodes(a.unit_code, b.unit_code));
  }, [board, outUnits, personId]);

  // Gõ tên không có trong danh sách: thêm người mới kèm số (không bắt buộc) (RPC `intercom_person_create`; trùng tên
  // thì trả id cũ).
  const [newPersonOpen, setNewPersonOpen] = useState(false);
  const [newDepartment, setNewDepartment] = useState("");
  const [newGroup, setNewGroup] = useState(1);
  const [addingPerson, setAddingPerson] = useState(false);
  const [newPhoneError, setNewPhoneError] = useState<string | null>(null);
  const nameInput = personQuery.trim().replace(/\s+/g, " ");
  const exactMatch = useMemo(() => {
    const q = searchable(nameInput);
    return Boolean(q) && (board?.people ?? []).some((p) => searchable(p.full_name.trim()) === q);
  }, [board, nameInput]);

  const addPerson = useCallback(async () => {
    if (!projectId || !nameInput || !newDepartment.trim()) return;
    const phone = normalizeIntercomPhone(newPhoneInputRef.current?.value ?? "");
    if (phone === null) {
      setNewPhoneError(INTERCOM_PHONE_ERROR);
      return;
    }
    setNewPhoneError(null);
    setAddingPerson(true);
    try {
      const id = await createIntercomPerson({
        projectId,
        fullName: nameInput,
        department: newDepartment.trim(),
        group: newGroup,
        phone: phone || null,
      });
      // Tên đã có trong dự án: hàm trả id cũ và GIỮ bộ phận, nhóm của người cũ (bỏ qua ô vừa nhập); thẻ người nhận đọc
      // lại từ danh sách nên hiện bộ phận, nhóm thật.
      const existing = board?.people.find((p) => p.id === id) ?? null;
      const fresh = await reload();
      const freshPerson = fresh?.people.find((p) => p.id === id) ?? null;
      // Máy chủ chỉ ghi số khi người chưa có số: người đã có số khác số vừa gõ thì số gõ bị bỏ, phải nói rõ.
      const keptOldPhone = Boolean(phone && freshPerson?.phone && freshPerson.phone !== phone);
      choosePerson(id);
      const known = existing ?? (keptOldPhone ? freshPerson : null);
      if (known) {
        setNotice({
          tone: "success",
          text: keptOldPhone
            ? `Tên đã có, giữ bộ phận ${known.department} (Nhóm ${known.group_no}) và số điện thoại cũ. Muốn đổi số thì sửa ở màn Dự án.`
            : `Tên đã có, giữ bộ phận ${known.department} (Nhóm ${known.group_no}).`,
        });
      }
      setNewDepartment("");
      if (newDepartmentInputRef.current) newDepartmentInputRef.current.value = "";
      if (newPhoneInputRef.current) newPhoneInputRef.current.value = "";
      setNewGroup(1);
    } catch (e) {
      setNotice({
        tone: "error",
        text: e instanceof Error ? e.message : "Chưa thêm được người nhận.",
      });
    } finally {
      setAddingPerson(false);
    }
  }, [board, choosePerson, newDepartment, newGroup, projectId, reload, nameInput]);

  // Bộ phận sẵn có cho người mới (bỏ "Chưa rõ tên"); mặc định chọn bộ phận dùng nhiều nhất của dự án.
  const newPersonDepartments = useMemo(() => departments.filter((d) => d !== UNNAMED_DEPARTMENT), [departments]);
  const topDepartment = useMemo(() => {
    if (!board || newPersonDepartments.length === 0) return "";
    const counts = new Map<string, number>();
    for (const p of board.people) if (p.department) counts.set(p.department, (counts.get(p.department) ?? 0) + 1);
    for (const i of board.issues) if (i.department) counts.set(i.department, (counts.get(i.department) ?? 0) + 1);
    return newPersonDepartments.reduce((best, d) => ((counts.get(d) ?? 0) > (counts.get(best) ?? 0) ? d : best));
  }, [board, newPersonDepartments]);
  const pickNewDepartment = useCallback((department: string) => {
    setNewDepartment(department);
    if (newDepartmentInputRef.current) newDepartmentInputRef.current.value = department;
  }, []);

  const toggleIssues = (ids: string[], on: boolean) =>
    setIssueIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  // Xếp hạng gợi ý (so không dấu, không hoa thường): 0 trùng hẳn, 1 một từ bắt đầu bằng chữ gõ, 2 chứa giữa từ.
  // Trong mỗi nhóm theo hạng cũ, rồi tên A tới Z. Không cắt số dòng: danh sách cuộn bên trong khung.
  const personMatches = useMemo(() => {
    const q = searchable(personQuery.trim().replace(/\s+/g, " "));
    if (!board || !q) return [];
    const heldByPerson = new Map<string, string[]>();
    for (const issue of openIssues) {
      if (!issue.person_id) continue;
      const codes = heldByPerson.get(issue.person_id) ?? [];
      codes.push(issue.unit_code);
      heldByPerson.set(issue.person_id, codes);
    }
    const ranked: { person: (typeof board.people)[number]; rank: number; heldCodes: string[] }[] = [];
    for (const person of board.people) {
      const name = searchable(person.full_name.trim().replace(/\s+/g, " "));
      if (!name.includes(q)) continue;
      const rank = name === q ? 0 : ` ${name}`.includes(` ${q}`) ? 1 : 2;
      ranked.push({ person, rank, heldCodes: heldByPerson.get(person.id) ?? [] });
    }
    const tier = (r: (typeof ranked)[number]) => (r.rank === 0 ? 0 : r.heldCodes.length === 0 ? 1 : 2);
    ranked.sort(
      (a, b) =>
        tier(a) - tier(b) || a.rank - b.rank || a.person.full_name.localeCompare(b.person.full_name, "vi"),
    );
    return ranked.map((r) => ({ ...r.person, heldCodes: r.heldCodes }));
  }, [board, openIssues, personQuery]);

  const collectGroups = useMemo(() => {
    const map = new Map<string, { key: string; label: string; detail: string; issues: IntercomIssue[] }>();
    for (const issue of openIssues) {
      // Chế độ Thu về: chỉ các tai còn ngoài của đúng lượt giao bấm "Thu", không lọc theo ô tìm (ô bị ẩn).
      if (collectHandoverId) {
        if (issue.deliver_handover_id !== collectHandoverId) continue;
      }
      const label = rowLabel(issue);
      const key = issueRowKey(issue);
      let entry = map.get(key);
      if (!entry) {
        entry = {
          key,
          label,
          detail: issue.person_id ? `${issue.department} · Nhóm ${issue.group_no}` : "Giao bộ phận",
          issues: [],
        };
        map.set(key, entry);
      }
      entry.issues.push(issue);
    }
    for (const entry of map.values()) entry.issues.sort((a, b) => compareCodes(a.unit_code, b.unit_code));
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label, "vi"));
  }, [collectHandoverId, openIssues, rowLabel]);

  const hasRecipient =
    tab === "collect" || (byDepartment ? department.trim().length > 0 : unnamed || Boolean(personId));
  // Tai chọn Lỗi phải có lý do; tai bỏ chọn thì không xét.
  const faultsMissingReason = useMemo(
    () =>
      tab === "collect" ? [...issueIds].filter((id) => faultReasons.has(id) && !faultReasons.get(id)?.trim()) : [],
    [faultReasons, issueIds, tab],
  );
  const driveUnready = projectId !== null && driveUnreadyProjectId === projectId;
  const canSave = Boolean(
    board && shot && selectedCodes.length > 0 && hasRecipient && faultsMissingReason.length === 0 && !saving && !driveUnready,
  );
  const collectSummary = useMemo(() => {
    const chosen = openIssues
      .filter((i) => issueIds.has(i.id))
      .sort((a, b) => compareCodes(a.unit_code, b.unit_code));
    if (chosen.length === 0) return "Chưa chọn tai nào. Bấm ‹ Chọn lại.";
    const good = chosen.filter((i) => !faultReasons.has(i.id)).map((i) => i.unit_code);
    const parts = good.length > 0 ? [`${compactCodes(good)} Bình thường`] : [];
    for (const i of chosen) {
      if (faultReasons.has(i.id)) parts.push(`${i.unit_code} Lỗi (${faultReasons.get(i.id)?.trim() ?? ""})`);
    }
    return `Thu ${parts.join(" · ")}`;
  }, [faultReasons, issueIds, openIssues]);

  const setFault = (issueId: string, reason: string | null) =>
    setFaultReasons((prev) => {
      const next = new Map(prev);
      if (reason === null) next.delete(issueId);
      else next.set(issueId, reason);
      return next;
    });

  /** Ghi tai Lỗi lần lượt; trả các tai chưa ghi được để hiện nút ghi lại. */
  const markFaults = useCallback(async (list: PendingFault[]): Promise<PendingFault[]> => {
    const failed: PendingFault[] = [];
    for (const item of list) {
      try {
        await markIntercomIssueFault(item.issueId, item.reason);
      } catch {
        failed.push(item);
      }
    }
    return failed;
  }, []);

  const retryPendingFaults = useCallback(async () => {
    if (pendingFaults.length === 0) return;
    setFaultRetryBusy(true);
    const failed = await markFaults(pendingFaults);
    setPendingFaults(failed);
    setFaultRetryBusy(false);
    setNotice(
      failed.length > 0
        ? {
            tone: "error",
            text: `Chưa ghi được Lỗi cho ${compactCodes(failed.map((f) => f.code))}, bấm ghi lại.`,
          }
        : { tone: "success", text: "Đã ghi tình trạng Lỗi." },
    );
    void reload();
  }, [markFaults, pendingFaults, reload]);

  const save = useCallback(async () => {
    if (!board || !shot || !projectId || savingRef.current || driveUnready) return;
    savingRef.current = true;
    setSaving(true);
    setNotice(null);
    const sentUnitIds = [...unitIds].sort();
    const sentIssueIds = [...issueIds].sort();
    const recipientKey =
      tab === "deliver"
        ? byDepartment
          ? `department:${department.trim()}:${group}`
          : unnamed
            ? `department:${UNNAMED_DEPARTMENT}:1`
            : `person:${personId ?? ""}`
        : "";
    const fingerprint = [
      tab,
      projectId,
      (tab === "deliver" ? sentUnitIds : sentIssueIds).join(","),
      recipientKey,
      shot.key,
      shouldStamp ? "stamp" : "plain",
    ].join("|");
    if (handoverRef.current?.fingerprint !== fingerprint) {
      handoverRef.current = { id: newHandoverId(), fingerprint };
    }
    const handoverId = handoverRef.current.id;
    const sentFaults: PendingFault[] =
      tab === "collect"
        ? openIssues
            .filter((i) => issueIds.has(i.id) && faultReasons.get(i.id)?.trim())
            .map((i) => ({
              issueId: i.id,
              code: i.unit_code,
              reason: (faultReasons.get(i.id) ?? "").trim(),
            }))
        : [];
    setProgress({ label: "Đang nén ảnh...", percent: 3 });
    const limits = currentPhotoLimits();
    try {
      const stampCanvas = drawScaled(shot.canvas, shot.canvas.width, shot.canvas.height, limits.firstLongSide);
      const ctx = stampCanvas?.getContext("2d");
      if (!stampCanvas || !ctx) throw new Error("Chưa in được dấu lên ảnh, thử lại giúp tôi.");
      if (shouldStamp) {
        drawStamp(ctx, {
          ...stampBase(),
          ...shot,
          width: stampCanvas.width,
          height: stampCanvas.height,
        });
        drawStageBadge(ctx, { label: stageBadgeLabel(tab), width: stampCanvas.width, height: stampCanvas.height });
      }
      const compressed = await encodeUnderLimit(stampCanvas, limits.firstMaxBytes, limits.firstFallbackLongSides);
      const thumbCanvas = compressed
        ? drawScaled(compressed.canvas, compressed.canvas.width, compressed.canvas.height, THUMB_LONG_SIDE)
        : null;
      const thumb = thumbCanvas ? await encodeImage(thumbCanvas, THUMB_QUALITY) : null;
      if (!compressed || !thumb) throw new Error("Chưa nén được ảnh, thử lại giúp tôi.");
      setProgress({
        label: "Đang tải ảnh lên...",
        percent: PROGRESS_COMPRESSED,
      });

      const meta: IntercomUploadMeta = {
        handover_id: handoverId,
        project_id: projectId,
        kind: tab,
        source: shot.source,
        taken_at: shot.sentTakenAt,
        work_date: shot.source === "library" ? workDate : null,
        width: compressed.canvas.width,
        height: compressed.canvas.height,
      };
      if (tab === "deliver") {
        meta.unit_ids = sentUnitIds;
        if (byDepartment) {
          meta.department = department.trim();
          meta.group_no = group;
        } else if (unnamed) {
          meta.department = UNNAMED_DEPARTMENT;
          meta.group_no = 1;
        } else {
          meta.person_id = personId;
        }
      } else {
        meta.issue_ids = sentIssueIds;
      }

      let reply;
      // Đang tự gửi lại (lượt 2, 3): thanh tiến độ giữ câu "Đang gửi lại (n/3)...".
      let retryLabel: string | null = null;
      const isDriveProject = projects?.find((p) => p.id === projectId)?.storage_kind === "drive";
      const sendHandover = isDriveProject ? uploadIntercomHandoverDrive : uploadIntercomHandover;
      try {
        reply = await sendHandover(
          { meta, file: compressed.blob, thumb },
          UPLOAD_TIMEOUT_MS,
          (fraction) => {
            if (fraction >= 1) {
              setProgress({ label: "Đang lưu...", percent: PROGRESS_SENT });
              return;
            }
            const percent = Math.round(PROGRESS_COMPRESSED + (PROGRESS_SENT - PROGRESS_COMPRESSED) * fraction);
            setProgress({ label: retryLabel ?? "Đang tải ảnh lên...", percent });
          },
          {
            retryTimeoutMs: UPLOAD_RETRY_TIMEOUT_MS,
            onRetry: (attempt, total) => {
              retryLabel = `Đang gửi lại (${attempt}/${total})...`;
              setProgress({ label: retryLabel, percent: PROGRESS_COMPRESSED });
            },
            shrinkFile: async () => {
              const retryCanvas = drawScaled(
                compressed.canvas,
                compressed.canvas.width,
                compressed.canvas.height,
                limits.retryLongSide,
              );
              const smaller = retryCanvas ? await encodeUnderLimit(retryCanvas, limits.retryMaxBytes) : null;
              if (!smaller || smaller.blob.size >= compressed.blob.size) return null;
              return { file: smaller.blob, width: smaller.canvas.width, height: smaller.canvas.height };
            },
          },
        );
      } catch (e) {
        // Mất mạng, hết hạn: giữ ảnh, lựa chọn và `handover_id`; Thử lại đúng nội dung cũ thì gửi đúng id cũ.
        setCanRetry(true);
        setNotice({
          tone: "error",
          text: "Mạng yếu, chưa lưu được. Ảnh và lựa chọn vẫn còn, bấm Thử lại.",
          code:
            e instanceof IntercomUploadError
              ? `${e.reason} · đã thử ${e.attempts} lần`
              : e instanceof Error
                ? e.name
                : "unknown",
        });
        return;
      }
      if (!reply.ok) {
        // Máy chủ trả lời từ chối (mã đang ở ngoài, đã có người thu, ngày ngoài dự án...): giữ ảnh, lựa chọn để sửa rồi
        // lưu lại. Lỗi nghiệp vụ (< 500) bỏ `handover_id` (lần lưu sau là lượt mới); 5xx giữ id để Thử lại.
        if (reply.status < 500) handoverRef.current = null;
        setCanRetry(reply.status >= 500);
        setNotice({
          tone: "error",
          text: reply.error ?? "Chưa lưu được ảnh, thử lại giúp tôi.",
        });
        void reload();
        return;
      }

      const storedOnR2Text = "storedOnR2" in reply && reply.storedOnR2 ? ` ${INTERCOM_STORED_ON_R2_TEXT}` : "";
      const result = reply.result;
      const codes = result && result.codes.length > 0 ? result.codes : selectedCodes;
      const doneText =
        tab === "deliver"
          ? `Đã giao ${compactCodes(codes)}${recipientLabel ? ` cho ${recipientLabel}` : ""}.`
          : `Đã thu ${compactCodes(codes)}.`;
      const already =
        result && result.already_collected.length > 0
          ? ` Đã có người thu trước: ${compactCodes(result.already_collected)}.`
          : "";
      // Ghi tai Lỗi cho đúng các tai lượt này đã thu (mã người khác thu trước thì bỏ qua).
      const collectedCodes = new Set(codes);
      const faultsToMark = sentFaults.filter((f) => collectedCodes.has(f.code));
      let failedFaults: PendingFault[] = [];
      if (faultsToMark.length > 0) {
        setProgress({ label: "Đang ghi tình trạng Lỗi...", percent: 96 });
        failedFaults = await markFaults(faultsToMark);
      }
      // Gộp với danh sách đang chờ: chỉ thay các tai vừa thử ghi lượt này, tai ghi được thì bỏ khỏi danh sách.
      const triedIssueIds = new Set(faultsToMark.map((f) => f.issueId));
      setPendingFaults((prev) => [
        ...prev.filter((p) => !triedIssueIds.has(p.issueId)),
        ...failedFaults,
      ]);
      const faultText =
        faultsToMark.length === 0
          ? ""
          : failedFaults.length > 0
            ? ` Chưa ghi được Lỗi cho ${compactCodes(failedFaults.map((f) => f.code))}, bấm ghi lại.`
            : ` Đã ghi Lỗi: ${compactCodes(faultsToMark.map((f) => f.code))}.`;
      setNotice({
        tone: failedFaults.length > 0 ? "error" : "success",
        text: `${reply.alreadyDone ? "Lượt này đã lưu trước đó. " : ""}${doneText}${already}${faultText}${storedOnR2Text}`,
      });
      setLastThumbUrl(URL.createObjectURL(thumb));
      handoverRef.current = null;
      setCanRetry(false);
      setUnitIds(new Set());
      setIssueIds(new Set());
      setFaultReasons(new Map());
      setPersonId(null);
      setUnnamed(false);
      discardShot();
      // Chế độ Thu về: lưu xong quay về Dashboard; còn tai Lỗi chưa ghi được thì ở lại để bấm ghi lại.
      if (collectHandoverId && failedFaults.length === 0) {
        router.push(boardHref);
        return;
      }
      // Còn tai Lỗi chưa ghi: về tấm danh sách, câu báo và nút "Ghi lại Lỗi" ở chân.
      if (tab === "collect") setCollectCameraOpen(false);
      void reload();
    } catch (e) {
      setNotice({
        tone: "error",
        text: e instanceof Error ? e.message : "Chưa lưu được ảnh, thử lại giúp tôi.",
      });
    } finally {
      savingRef.current = false;
      setSaving(false);
      setProgress(null);
    }
  }, [
    board,
    boardHref,
    byDepartment,
    collectHandoverId,
    department,
    discardShot,
    driveUnready,
    faultReasons,
    group,
    issueIds,
    markFaults,
    openIssues,
    personId,
    projectId,
    projects,
    recipientLabel,
    reload,
    router,
    selectedCodes,
    shot,
    shouldStamp,
    stampBase,
    tab,
    unitIds,
    unnamed,
    workDate,
  ]);

  // Thanh Lưu dính đáy che các nút gợi ý tên và nút Thêm khi chúng mọc ra dưới ô gõ. Đo chiều cao thanh, rồi mỗi lần
  // khối gợi ý đổi thì cuộn vừa đủ để đáy khối nằm trên thanh (và trên bàn phím iPhone, đọc `visualViewport`).
  const saveBarRef = useRef<HTMLDivElement | null>(null);
  const sheetBodyRef = useRef<HTMLDivElement | null>(null);
  const personBoxRef = useRef<HTMLDivElement | null>(null);
  const showAddPerson = Boolean(nameInput) && !exactMatch;
  useEffect(() => {
    const box = personBoxRef.current;
    if (!box || (personMatches.length === 0 && !showAddPerson)) return;
    const frame = window.requestAnimationFrame(() => {
      const barHeight = saveBarRef.current?.getBoundingClientRect().height ?? 0;
      const viewport = window.visualViewport;
      const viewBottom = viewport
        ? Math.min(window.innerHeight, viewport.offsetTop + viewport.height)
        : window.innerHeight;
      // Không cuộn quá làm ô gõ trôi khỏi đỉnh thân sheet (danh sách gợi ý đã cuộn được bên trong).
      const body = sheetBodyRef.current;
      const inputTop = personInputRef.current?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
      const bodyTop = body ? body.getBoundingClientRect().top : (viewport?.offsetTop ?? 0);
      const barTop = saveBarRef.current?.getBoundingClientRect().top ?? viewBottom - barHeight;
      const overlap = Math.min(
        box.getBoundingClientRect().bottom - (Math.min(viewBottom, barTop) - 8),
        inputTop - bodyTop - 8,
      );
      if (overlap > 0) (body ?? window).scrollBy({ top: overlap, behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [personMatches.length, showAddPerson, newPersonOpen]);

  // Sửa: khung cao vừa khoảng từ đỉnh khung tới vật che gần nhất (đỉnh thanh Lưu nếu thanh ở trên bàn phím, không
  // thì đáy `visualViewport`), đo lại khi trang hoặc bàn phím đổi; tối thiểu PERSON_LIST_MIN_PX để vẫn thấy vài
  // dòng, tối đa như cũ.
  const personListRef = useRef<HTMLUListElement | null>(null);
  const [personListMaxHeight, setPersonListMaxHeight] = useState<number | null>(null);
  const hasPersonMatches = personMatches.length > 0;
  useEffect(() => {
    if (!hasPersonMatches) return;
    let frame = 0;
    const measure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const list = personListRef.current;
        if (!list) return;
        const viewport = window.visualViewport;
        const viewBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
        const barTop = saveBarRef.current?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
        const room = Math.floor(Math.min(viewBottom, barTop) - list.getBoundingClientRect().top - 8);
        const next = Math.max(PERSON_LIST_MIN_PX, Math.min(PERSON_LIST_MAX_PX, room));
        setPersonListMaxHeight((prev) => (prev === next ? prev : next));
      });
    };
    measure();
    const viewport = window.visualViewport;
    const body = sheetBodyRef.current;
    window.addEventListener("scroll", measure, { passive: true });
    body?.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    viewport?.addEventListener("resize", measure);
    viewport?.addEventListener("scroll", measure);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", measure);
      body?.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      viewport?.removeEventListener("resize", measure);
      viewport?.removeEventListener("scroll", measure);
    };
  }, [hasPersonMatches, showAddPerson, newPersonOpen]);

  const currentProject = projects?.find((p) => p.id === projectId) ?? null;

  if (projectError) return <p className="px-4 py-8 text-base text-danger">{projectError}</p>;
  if (!projects) return <p className="px-4 py-8 text-base text-muted">Đang tải...</p>;
  if (projects.length === 0) return <p className="px-4 py-8 text-base text-fg">Bạn chưa là thành viên dự án nào, nhờ quản lý thêm.</p>;

  // Dòng báo, nút ghi lại Lỗi: ở chân sheet khi sheet mở, nổi trên camera khi sheet đóng; Thu bước 1 thì ở chân tấm
  // danh sách tai.
  const noticeView = notice ? (
    <p
      className={cn(
        "text-base font-medium",
        shot || collectListOpen
          ? notice.tone === "success"
            ? "text-success"
            : "text-danger"
          : cn("rounded-control px-3 py-2 text-white", notice.tone === "success" ? "bg-success" : "bg-danger"),
      )}
      role="status"
    >
      {notice.text}
      {notice.code ? (
        <span className={cn("block text-sm font-normal", shot || collectListOpen ? "text-muted" : "text-white/80")}>Mã: {notice.code}</span>
      ) : null}
    </p>
  ) : null;
  const pendingFaultsButton =
    pendingFaults.length > 0 ? (
      <button
        type="button"
        disabled={faultRetryBusy}
        onClick={() => void retryPendingFaults()}
        className={cn(
          "h-12 w-full rounded-control border border-danger text-base font-semibold text-danger disabled:opacity-50",
          shot ? "active:bg-surface-2" : "bg-surface active:bg-surface-2",
        )}
      >
        {faultRetryBusy ? "Đang ghi..." : `Ghi lại Lỗi ${compactCodes(pendingFaults.map((f) => f.code))}`}
      </button>
    ) : null;
  // Lớp dấu xem trước: trên camera khi chưa có ảnh; có ảnh thì trên ảnh phủ phần màn trên sheet, hoặc ảnh phóng to.
  const overlayCanvas = (
    <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 size-full object-contain" />
  );

  return (
    <div className="fixed inset-0 z-[45] overflow-hidden bg-black">
      {/* Camera toàn màn: `contain` để khung xem đúng khung ảnh lưu (ảnh lưu là khung đầy đủ của luồng). `<video>` không bị gỡ, không bị ẩn khi có ảnh: camera sống dưới lớp ảnh phủ và sheet. */}
      <video ref={bindVideo} autoPlay muted playsInline className="absolute inset-0 size-full object-contain" />
      {!shot ? overlayCanvas : null}

      {/* Bấm phóng to toàn màn. */}
      {shot ? (
        <button
          ref={overlayZoom.bindFrame}
          type="button"
          onClick={(e) => {
            if (e.detail === 0) setPreviewExpanded(true);
          }}
          aria-label="Phóng to ảnh"
          tabIndex={previewExpanded ? -1 : undefined}
          className="absolute inset-x-0 top-0 z-[5] block touch-none select-none overflow-hidden bg-black"
          style={{ height: sheetTop ?? 0 }}
        >
          <span ref={overlayZoom.bindContent} className="absolute inset-0 block origin-top-left">
            {/* eslint-disable-next-line @next/next/no-img-element -- ảnh tạm trên máy (blob URL) */}
            <img
              src={shot.previewUrl}
              alt="Ảnh vừa chụp"
              draggable={false}
              className="absolute inset-0 size-full object-contain"
            />
            {!previewExpanded ? overlayCanvas : null}
          </span>
        </button>
      ) : null}

      {/* Đầu màn: nút tròn về Home, chip tên dự án bấm mở danh sách dự án. Thu bước 2, 3: nút Home đổi thành "‹ Chọn lại" về tấm danh sách tai. */}
      <div className="absolute inset-x-0 top-0 z-10 mx-auto flex max-w-xl items-center gap-2 px-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        {tab === "collect" && !collectListOpen ? (
          <button
            type="button"
            disabled={saving}
            onClick={backToCollectList}
            className="flex h-11 shrink-0 items-center gap-1 rounded-full bg-black/50 pl-2 pr-4 text-base font-semibold text-white backdrop-blur active:bg-black/80 disabled:opacity-50"
          >
            <ChevronLeft className="size-6" aria-hidden />
            Chọn lại
          </button>
        ) : (
          <Link
            href={boardHref}
            aria-label="Về Home"
            className="flex size-11 shrink-0 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur active:bg-black/80"
          >
            <Home className="size-6" aria-hidden />
          </Link>
        )}
        <label className="relative flex h-11 min-w-0 items-center gap-1 rounded-full bg-black/50 px-4 text-base font-semibold text-white backdrop-blur active:bg-black/80">
          <span className="truncate">{currentProject?.name ?? "Chọn dự án"}</span>
          <ChevronDown className="size-4 shrink-0" aria-hidden />
          <select
            value={projectId ?? ""}
            disabled={saving}
            onChange={(e) => {
              // Đổi dự án tay thì thoát chế độ Thu về (lượt giao đang thu thuộc dự án cũ).
              if (collectHandoverId) {
                setCollectHandoverId(null);
                setIssueIds(new Set());
                setTab("deliver");
                // Đổi trước khi dữ liệu tải xong thì ref còn lượt Thu, Giao sẽ không tự mở camera: xoá luôn.
                setCollectCameraOpen(false);
                pendingCollectRef.current = null;
              }
              selectProject(e.target.value);
            }}
            className="absolute inset-0 size-full cursor-pointer text-base opacity-0"
            aria-label="Dự án"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {driveUnready ? (
        <div className="absolute inset-0 z-[9] flex items-center justify-center bg-bg px-6 pt-[calc(max(0.75rem,env(safe-area-inset-top))+3.5rem)]">
          <p role="status" className="max-w-xl text-center text-base text-fg">
            Dự án chưa nối xong Google Drive.
          </p>
        </div>
      ) : null}

      {/* Thu bước 1: danh sách tai chiếm màn, camera chưa mở; bấm "Chụp ảnh thu" mới mở camera. Tấm che lên `<video>`, dưới hàng đầu màn. */}
      {collectListOpen ? (
        <div className="absolute inset-0 z-[5] flex flex-col bg-bg pt-[calc(max(0.75rem,env(safe-area-inset-top))+3.5rem)]">
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="mx-auto w-full max-w-xl space-y-3 px-3 pb-3">
              <h2 className="text-block font-semibold text-fg">Thu về</h2>
              {loadError ? <p className="text-base text-danger">{loadError}</p> : null}
              {!board ? (
                <p className="text-base text-muted">Đang tải dữ liệu {currentProject?.name ?? ""}...</p>
              ) : (
                <>
                  {collectGroups.length === 0 ? (
                    <p className="text-base text-muted">{pendingCollectRef.current ? "Đang tải..." : "Lượt giao này không còn tai nào ở ngoài."}</p>
                  ) : (
                    collectGroups.map((g) => {
                      const ids = g.issues.map((i) => i.id);
                      const allOn = ids.every((id) => issueIds.has(id));
                      return (
                        <section key={g.key} className="space-y-2 rounded-card border border-border bg-surface p-3">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-block font-semibold text-fg">{g.label}</div>
                              <div className="text-sm text-muted">{g.detail}</div>
                            </div>
                            <button
                              type="button"
                              onClick={() => toggleIssues(ids, !allOn)}
                              className={cn(
                                "h-11 w-36 shrink-0 rounded-control px-3 text-base font-medium",
                                allOn ? "bg-brand-cta text-white" : "border border-border text-fg active:bg-surface-2",
                              )}
                            >
                              {allOn ? "Bỏ cả nhóm" : "Chọn cả nhóm"}
                            </button>
                          </div>
                          {/* Tình trạng lúc thu: Bình thường mặc định; Lỗi bắt buộc lý do. Tai bỏ chọn vẫn giữ hàng, mờ và khoá, để danh sách đứng yên. Chọn thẳng ở ô mã đầu dòng, không còn lưới mã. */}
                          {g.issues
                            .map((i) => {
                              const on = issueIds.has(i.id);
                              const fromPastDay = i.work_date < board.today;
                              const faulty = faultReasons.has(i.id);
                              const missing = on && faulty && !faultReasons.get(i.id)?.trim();
                              return (
                                <div key={i.id} className="space-y-1.5 border-t border-border pt-2">
                                  <div className="flex items-center gap-2">
                                    <button
                                      type="button"
                                      aria-pressed={on}
                                      onClick={() => toggleIssues([i.id], !on)}
                                      className={cn(
                                        "flex min-h-11 min-w-16 shrink-0 flex-col items-center justify-center rounded-control px-2 text-base font-semibold",
                                        on
                                          ? "bg-brand-cta text-white"
                                          : "border border-border bg-surface text-fg active:bg-surface-2",
                                      )}
                                    >
                                      {i.unit_code}
                                      {fromPastDay ? (
                                        <span className={cn("block text-xs font-normal", on ? "text-white" : "text-warning")}>
                                          từ {shortDate(i.work_date)}
                                        </span>
                                      ) : null}
                                    </button>
                                    <div
                                      className="flex flex-1 gap-1.5"
                                      role="radiogroup"
                                      aria-label={`Tình trạng ${i.unit_code}`}
                                    >
                                      <button
                                        type="button"
                                        role="radio"
                                        aria-checked={on && !faulty}
                                        disabled={!on}
                                        onClick={() => setFault(i.id, null)}
                                        className={cn(
                                          "h-11 min-w-0 flex-1 whitespace-nowrap rounded-control text-base font-medium disabled:opacity-40",
                                          on && !faulty
                                            ? "bg-success text-white"
                                            : cn("border border-border text-fg", on && "active:bg-surface-2"),
                                        )}
                                      >
                                        Bình thường
                                      </button>
                                      <button
                                        type="button"
                                        role="radio"
                                        aria-checked={faulty}
                                        disabled={!on}
                                        onClick={() => {
                                          if (!faulty) setFault(i.id, "");
                                        }}
                                        className={cn(
                                          "h-11 w-14 shrink-0 whitespace-nowrap rounded-control text-base font-medium disabled:opacity-40",
                                          faulty
                                            ? "bg-danger text-white"
                                            : cn("border border-border text-fg", on && "active:bg-surface-2"),
                                        )}
                                      >
                                        Lỗi
                                      </button>
                                    </div>
                                  </div>
                                  {faulty ? (
                                    <input
                                      // Ô không điều khiển (bàn phím tiếng Việt iOS), như các ô gõ chữ khác của màn.
                                      defaultValue={faultReasons.get(i.id) ?? ""}
                                      onChange={(e) => setFault(i.id, e.currentTarget.value)}
                                      maxLength={INTERCOM_FAULT_REASON_MAX}
                                      placeholder={`Lý do lỗi ${i.unit_code} (bắt buộc)`}
                                      aria-label={`Lý do lỗi ${i.unit_code}`}
                                      aria-invalid={missing}
                                      disabled={!on}
                                      className={cn(
                                        "h-12 w-full rounded-control border bg-surface px-3 text-base text-fg disabled:opacity-40",
                                        missing ? "border-danger" : "border-border",
                                      )}
                                    />
                                  ) : null}
                                </div>
                              );
                            })}
                        </section>
                      );
                    })
                  )}
                </>
              )}
            </div>
          </div>
          <div className="shrink-0 space-y-2 border-t border-border bg-surface px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {noticeView}
            {pendingFaultsButton}
            {faultsMissingReason.length > 0 ? (
              <div className="text-sm font-medium text-danger">Nhập lý do cho tai chọn Lỗi.</div>
            ) : (
              <div className="text-sm text-muted">
                {selectedCodes.length > 0 ? `${selectedCodes.length} mã: ${compactCodes(selectedCodes)}` : "Chưa chọn mã nào"}
              </div>
            )}
            {/* Còn tai Lỗi thiếu lý do thì tắt: bước 3 không còn danh sách để gõ lý do. */}
            <button
              type="button"
              disabled={!board || selectedCodes.length === 0 || faultsMissingReason.length > 0}
              onClick={openCollectCamera}
              className="flex h-14 w-full items-center justify-center gap-2 rounded-control bg-brand-cta text-block font-semibold text-white active:bg-brand-cta-hover disabled:opacity-40"
            >
              <Camera className="size-5" aria-hidden />
              {selectedCodes.length > 0 ? `Chụp ảnh thu ${selectedCodes.length} tai` : "Chọn tai để chụp"}
            </button>
          </div>
        </div>
      ) : null}

      {/* Câu báo nổi trên camera khi sheet đóng: lỗi camera, lỗi tải, đã giao, ghi lại Lỗi. */}
      {!shot && !collectListOpen && (cameraError || loadError || notice || pendingFaults.length > 0) ? (
        <div className="absolute inset-x-0 top-[calc(max(0.75rem,env(safe-area-inset-top))+3.5rem)] z-10 mx-auto max-w-xl space-y-2 px-3">
          {cameraError ? (
            <p className="rounded-control bg-black/70 px-3 py-2 text-base text-white">{cameraError}</p>
          ) : null}
          {loadError ? <p className="rounded-control bg-black/70 px-3 py-2 text-base text-white">{loadError}</p> : null}
          {noticeView}
          {pendingFaultsButton}
        </div>
      ) : null}

      {!shot && !stream && !collectListOpen ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <button
            type="button"
            disabled={cameraStarting}
            onClick={openCamera}
            className="flex h-14 items-center gap-2 rounded-full bg-white px-6 text-block font-semibold text-black active:opacity-80 disabled:opacity-60"
          >
            <Camera className="size-5" aria-hidden />
            {cameraStarting ? "Đang mở camera..." : "Mở camera"}
          </button>
        </div>
      ) : null}

      {/* Đáy: ô thư viện góc dưới trái, nút Chụp tròn giữa, góc phải để trống. Thu bước 1 ẩn hàng này (tấm danh sách có nút "Chụp ảnh thu" riêng); có ảnh cũng ẩn; ô chọn tệp vẫn gắn. */}
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 z-10 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]",
          (collectListOpen || shot || driveUnready) && "hidden",
        )}
      >
        <div className="mx-auto grid max-w-xl grid-cols-3 items-center px-6">
          <button
            type="button"
            disabled={saving}
            onClick={() => fileInputRef.current?.click()}
            aria-label="Chọn ảnh từ máy"
            className="flex size-14 items-center justify-center justify-self-start overflow-hidden rounded-xl border-2 border-white/80 bg-black/50 text-white active:opacity-70 disabled:opacity-50"
          >
            {lastThumbUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- ảnh nhỏ lượt vừa lưu (blob URL)
              <img src={lastThumbUrl} alt="" className="size-full object-cover" />
            ) : (
              <Images className="size-7" aria-hidden />
            )}
          </button>
          <button
            type="button"
            disabled={!stream}
            onClick={() => void capture()}
            aria-label="Chụp"
            className="group flex size-[76px] items-center justify-center justify-self-center rounded-full border-4 border-white p-1 disabled:opacity-40"
          >
            <span className="block size-full rounded-full bg-white transition-transform group-active:scale-90" />
          </button>
          <span aria-hidden />
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            void pickLibrary(file);
          }}
        />
      </div>

      {/* Sheet: chỉ hiện khi đã chụp hoặc chọn ảnh. X, vuốt xuống là bỏ ảnh; đang Lưu thì không đóng. */}
      {shot ? (
        <IntercomCaptureSheet
          title={tab === "deliver" ? "Giao" : "Thu về"}
          closeLabel="Bỏ ảnh, chụp lại"
          closeDisabled={saving}
          onClose={discardShot}
          rootRef={sheetRootRef}
          bodyRef={sheetBodyRef}
          footerRef={saveBarRef}
          footer={
            <>
              {noticeView}
              {pendingFaultsButton}
              {progress ? (
                // Tiến độ Lưu: nén ảnh, tải lên (theo byte đã gửi), lưu.
                <div
                  className="space-y-1"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progress.percent}
                >
                  <div className="flex items-center justify-between text-sm text-muted">
                    <span>{progress.label}</span>
                    <span className="font-semibold text-fg">{progress.percent}%</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-surface-2">
                    <div
                      className="h-full rounded-full bg-brand-cta transition-[width]"
                      style={{ width: `${progress.percent}%` }}
                    />
                  </div>
                </div>
              ) : null}
              {/* Một vị trí duy nhất để bật tắt chữ báo không đẩy lệch dãy nút mã. */}
              {faultsMissingReason.length > 0 ? (
                <div className="text-sm font-medium text-danger">Nhập lý do cho tai chọn Lỗi.</div>
              ) : (
                <div className="text-sm text-muted">
                  {selectedCodes.length > 0 ? `${selectedCodes.length} mã: ${compactCodes(selectedCodes)}` : "Chưa chọn mã nào"}
                </div>
              )}
              <button
                type="button"
                disabled={!canSave}
                onClick={() => void save()}
                className="h-14 w-full rounded-control bg-brand-cta text-block font-semibold text-white active:bg-brand-cta-hover disabled:opacity-40"
              >
                {saving ? "Đang lưu..." : canRetry ? "Thử lại" : tab === "deliver" ? "Lưu lượt giao" : "Lưu lượt nhận"}
              </button>
            </>
          }
        >
          <div className="space-y-3 pt-1">
            {shot.source === "library" ? (
              <button
                type="button"
                role="switch"
                aria-checked={libraryStamp}
                disabled={saving}
                onClick={() => setLibraryStamp((on) => !on)}
                className="flex min-h-12 w-full items-center justify-between gap-3 rounded-control border border-border bg-surface px-3 py-2 text-left active:bg-surface-2 disabled:opacity-50"
              >
                <span className="min-w-0">
                  <span className="block text-base font-medium text-fg">Chèn dấu giờ, mã</span>
                  <span className="block text-sm text-muted">
                    {libraryStamp ? "Ảnh lưu kèm dấu như ảnh chụp." : "Tắt: ảnh đã có dấu sẵn thì giữ nguyên."}
                  </span>
                </span>
                <span
                  aria-hidden
                  className={cn(
                    "relative h-7 w-12 shrink-0 rounded-full transition-colors",
                    libraryStamp ? "bg-brand-cta" : "bg-surface-2 ring-1 ring-inset ring-border",
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-0.5 size-6 rounded-full bg-white shadow transition-[left]",
                      libraryStamp ? "left-[1.375rem]" : "left-0.5",
                    )}
                  />
                </span>
              </button>
            ) : null}

            {shot.source === "library" && workDate ? (
              <label className="flex min-h-12 items-center justify-between gap-3 rounded-control border border-border bg-surface px-3 py-1.5">
                <span className="text-base font-medium text-fg">Ngày làm việc</span>
                <select
                  value={workDate}
                  disabled={saving}
                  onChange={(e) => setPickedWorkDate({ shotKey: shot.key, date: e.target.value })}
                  aria-label="Ngày làm việc"
                  className="h-11 min-w-0 rounded-control border border-border bg-surface px-3 text-base font-semibold text-fg disabled:opacity-50"
                >
                  {projectDays.map((d, i) => (
                    <option key={d} value={d}>
                      Ngày {i + 1} · {shortDate(d)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            {loadError ? <p className="text-base text-danger">{loadError}</p> : null}

            {/* Phần chọn. */}
            {!board ? (
              <p className="text-base text-muted">Đang tải dữ liệu {currentProject?.name ?? ""}...</p>
            ) : tab === "deliver" ? (
              <>
                {/* Thứ tự màn Giao: chụp ảnh, chọn mã tai, rồi gõ tên người nhận. */}
                <div className="space-y-2">
                  <div className="flex items-baseline gap-2">
                    <span className="shrink-0 text-sm font-medium text-muted">Mã tai</span>
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate text-base",
                        unitIds.size > 0 ? "font-semibold text-fg" : "text-muted",
                      )}
                    >
                      {selectedCodes.length > 0
                        ? `${selectedCodes.length} mã: ${compactCodes(selectedCodes)}`
                        : "Chưa chọn mã"}
                    </span>
                  </div>
                  <IntercomUnitPicker units={board.units} outUnits={outUnits} selected={unitIds} onChange={setUnitIds} />
                </div>

                <label className="flex min-h-12 items-center justify-between gap-3 rounded-control border border-border bg-surface px-3 py-2">
                  <span className="text-base font-medium text-fg">Giao cho bộ phận</span>
                  <input
                    type="checkbox"
                    checked={byDepartment}
                    onChange={(e) => setByDepartment(e.target.checked)}
                    className="size-6"
                  />
                </label>

                {byDepartment ? (
                  <div className="grid grid-cols-[1fr_auto] gap-2">
                    <input
                      // Ô không điều khiển (bàn phím tiếng Việt iOS); ô bị gỡ khi tắt công tắc nên dựng lại từ state.
                      defaultValue={department}
                      onChange={(e) => setDepartment(e.currentTarget.value)}
                      list="intercom-departments"
                      placeholder="Bộ phận"
                      aria-label="Bộ phận"
                      className="h-12 min-w-0 rounded-control border border-border bg-surface px-3 text-base text-fg"
                    />
                    {groupCount > 1 ? (
                      <select
                        value={group}
                        onChange={(e) => setGroup(Number(e.target.value))}
                        aria-label="Nhóm"
                        className="h-12 rounded-control border border-border bg-surface px-3 text-base text-fg"
                      >
                        {Array.from({ length: groupCount }, (_, i) => i + 1).map((g) => (
                          <option key={g} value={g}>
                            Nhóm {g}
                          </option>
                        ))}
                      </select>
                    ) : null}
                  </div>
                ) : selectedPerson ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-3 rounded-control border border-brand bg-surface px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-block font-semibold text-fg">{selectedPerson.full_name}</div>
                        <div className="text-base text-muted">
                          {selectedPerson.department} · Nhóm {selectedPerson.group_no}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setPersonId(null)}
                        className="flex size-12 shrink-0 items-center justify-center rounded-control border border-border text-fg active:bg-surface-2"
                        aria-label="Đổi người nhận"
                      >
                        <X className="size-5" aria-hidden />
                      </button>
                    </div>
                    {unitIds.size === 0 && yesterdayUnits.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => setUnitIds(new Set(yesterdayUnits.map((i) => i.unit_id)))}
                        className="min-h-12 w-full rounded-control border border-brand px-3 py-2 text-left text-base font-medium text-brand active:bg-surface-2"
                      >
                        Dùng mã hôm qua: {compactCodes(yesterdayUnits.map((i) => i.unit_code))}
                      </button>
                    ) : null}
                  </div>
                ) : unnamed ? (
                  <div className="flex items-center gap-3 rounded-control border border-brand bg-surface px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-block font-semibold text-fg">{UNNAMED_DEPARTMENT}</div>
                      <div className="text-base text-muted">Điền tên sau ở Dashboard</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setUnnamed(false)}
                      className="flex size-12 shrink-0 items-center justify-center rounded-control border border-border text-fg active:bg-surface-2"
                      aria-label="Bỏ chưa có tên, gõ tên người nhận"
                    >
                      <X className="size-5" aria-hidden />
                    </button>
                  </div>
                ) : (
                  <div ref={personBoxRef} className="space-y-1">
                    <div className="flex gap-2">
                      <div className="relative min-w-0 flex-1">
                        <Search
                          className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted"
                          aria-hidden
                        />
                        <input
                          ref={personInputRef}
                          // Ô không điều khiển: bàn phím tiếng Việt iOS bỏ dấu bằng xoá lùi rồi chèn lại, ô `value` sẽ ghi đè giữa chuỗi (gõ
                          // "Nguyễn" ra chữ hỏng). Xoá ô thì ghi thẳng `personInputRef.current.value`.
                          defaultValue={personQuery}
                          onChange={(e) => {
                            setPersonQuery(e.currentTarget.value);
                            setNewPersonOpen(false);
                          }}
                          onFocus={(e) => {
                            // Bàn phím mở thì cuộn ô gõ lên gần đỉnh thân sheet để danh sách gợi ý có chỗ (chờ bàn phím mở xong).
                            const input = e.currentTarget;
                            window.setTimeout(() => {
                              const body = sheetBodyRef.current;
                              const viewTop = body
                                ? body.getBoundingClientRect().top
                                : (window.visualViewport?.offsetTop ?? 0);
                              const delta = input.getBoundingClientRect().top - viewTop - 8;
                              if (delta > 0) (body ?? window).scrollBy({ top: delta, behavior: "smooth" });
                            }, 300);
                          }}
                          placeholder="Gõ tên người nhận"
                          aria-label="Tên người nhận"
                          className="h-12 w-full rounded-control border border-border bg-surface pr-3 pl-10 text-base text-fg"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setUnnamed(true);
                          setNewPersonOpen(false);
                        }}
                        className="h-12 shrink-0 rounded-control border border-border bg-surface px-3 text-base font-medium text-fg active:bg-surface-2"
                      >
                        Chưa có tên
                      </button>
                    </div>
                    {/* Nút Thêm đứng trên danh sách gợi ý (danh sách cuộn bên trong) nên luôn thấy, kể cả khi nhiều tên. */}
                    {showAddPerson ? (
                      newPersonOpen ? (
                        <div className="space-y-2 rounded-control border border-border bg-surface p-3">
                          <div className="text-base font-medium text-fg">Thêm &quot;{nameInput}&quot; vào danh sách</div>
                          {newPersonDepartments.length > 0 ? (
                            <div className="flex flex-wrap gap-2" role="group" aria-label="Bộ phận sẵn có">
                              {newPersonDepartments.map((d) => {
                                const picked = newDepartment.trim() === d;
                                return (
                                  <button
                                    key={d}
                                    type="button"
                                    aria-pressed={picked}
                                    onClick={() => pickNewDepartment(d)}
                                    className={cn(
                                      "min-h-11 rounded-full border px-3 text-base active:opacity-70",
                                      picked
                                        ? "border-brand-cta bg-brand-cta text-white"
                                        : "border-border bg-surface text-fg active:bg-surface-2",
                                    )}
                                  >
                                    {d}
                                  </button>
                                );
                              })}
                            </div>
                          ) : null}
                          <div className="grid grid-cols-[1fr_auto] gap-2">
                            <input
                              ref={newDepartmentInputRef}
                              // Ô không điều khiển (bàn phím tiếng Việt iOS); `addPerson` xoá ô bằng ref.
                              defaultValue={newDepartment}
                              onChange={(e) => setNewDepartment(e.currentTarget.value)}
                              list="intercom-departments"
                              placeholder="Bộ phận"
                              aria-label="Bộ phận của người mới"
                              className="h-12 min-w-0 rounded-control border border-border bg-surface px-3 text-base text-fg"
                            />
                            {groupCount > 1 ? (
                              <select
                                value={newGroup}
                                onChange={(e) => setNewGroup(Number(e.target.value))}
                                aria-label="Nhóm của người mới"
                                className="h-12 rounded-control border border-border bg-surface px-3 text-base text-fg"
                              >
                                {Array.from({ length: groupCount }, (_, i) => i + 1).map((g) => (
                                  <option key={g} value={g}>
                                    Nhóm {g}
                                  </option>
                                ))}
                              </select>
                            ) : null}
                          </div>
                          <div>
                            <input
                              ref={newPhoneInputRef}
                              type="tel"
                              inputMode="tel"
                              autoComplete="off"
                              maxLength={INTERCOM_PHONE_INPUT_MAX}
                              onInput={() => setNewPhoneError(null)}
                              placeholder="Số điện thoại (không bắt buộc)"
                              aria-label="Số điện thoại của người mới"
                              className="h-12 w-full min-w-0 rounded-control border border-border bg-surface px-3 text-base text-fg"
                            />
                            {newPhoneError ? <p className="mt-1 text-sm text-danger">{newPhoneError}</p> : null}
                          </div>
                          <button
                            type="button"
                            disabled={addingPerson || !newDepartment.trim()}
                            onClick={() => void addPerson()}
                            className="h-12 w-full rounded-control bg-brand-cta text-base font-semibold text-white active:bg-brand-cta-hover disabled:opacity-40"
                          >
                            {addingPerson ? "Đang thêm..." : "Thêm và chọn"}
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            if (!newDepartment.trim()) setNewDepartment(topDepartment);
                            setNewPhoneError(null);
                            setNewPersonOpen(true);
                          }}
                          className="min-h-12 w-full rounded-control border border-dashed border-border px-3 py-2 text-left text-base text-fg active:bg-surface-2"
                        >
                          Thêm &quot;{nameInput}&quot; vào danh sách
                        </button>
                      )
                    ) : null}
                    {personMatches.length > 0 ? (
                      <ul
                        ref={personListRef}
                        style={personListMaxHeight !== null ? { maxHeight: personListMaxHeight } : undefined}
                        className="max-h-[17rem] overflow-y-auto overscroll-contain rounded-control border border-border bg-surface"
                      >
                        {personMatches.map((p) => (
                          <li key={p.id}>
                            <button
                              type="button"
                              onClick={() => choosePerson(p.id)}
                              className="flex min-h-12 w-full flex-col justify-center border-b border-border px-3 py-1.5 text-left last:border-b-0 active:bg-surface-2"
                            >
                              <span className="text-base font-medium text-fg">{p.full_name}</span>
                              <span className="text-sm text-muted">
                                {p.department} · Nhóm {p.group_no}
                              </span>
                              {p.heldCodes.length > 0 ? (
                                <span className="text-sm font-medium text-warning">Đang giữ {compactCodes(p.heldCodes)}</span>
                              ) : null}
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                )}
                <datalist id="intercom-departments">
                  {departments.map((d) => (
                    <option key={d} value={d} />
                  ))}
                </datalist>
              </>
            ) : (
              <>
                {/* Thu bước 3: tai đã chọn ở tấm danh sách, chỉ còn dòng tóm tắt; sửa thì "‹ Chọn lại". */}
                <p className="text-base font-medium text-fg">{collectSummary}</p>
              </>
            )}
          </div>
        </IntercomCaptureSheet>
      ) : null}

      {shot && previewExpanded ? (
        <button
          ref={expandedZoom.bindFrame}
          type="button"
          onClick={(e) => {
            if (e.detail === 0) setPreviewExpanded(false);
          }}
          aria-label="Thu nhỏ ảnh"
          className="fixed inset-0 z-40 touch-none select-none overflow-hidden bg-black"
        >
          <span ref={expandedZoom.bindContent} className="absolute inset-0 block origin-top-left">
            {/* eslint-disable-next-line @next/next/no-img-element -- ảnh tạm trên máy (blob URL) */}
            <img
              src={shot.previewUrl}
              alt="Ảnh vừa chụp"
              draggable={false}
              className="absolute inset-0 size-full object-contain"
            />
            {overlayCanvas}
          </span>
        </button>
      ) : null}
    </div>
  );
}

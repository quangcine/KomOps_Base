// Hàm thuần dùng chung cho màn chụp, dashboard và trang khách giao nhận intercom.

import type { IntercomBoard, IntercomIssue, IntercomUnit } from "@/lib/intercom/staffIntercom";

export const INTERCOM_TIME_ZONE = "Asia/Ho_Chi_Minh";

/** Nhớ dự án đã chọn trên máy (màn chụp và dashboard dùng chung). */
export const PROJECT_STORAGE_KEY = "intercom.projectId";

export function readStoredProjectId(): string | null {
  try {
    return window.localStorage.getItem(PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeProjectId(id: string): void {
  try {
    window.localStorage.setItem(PROJECT_STORAGE_KEY, id);
  } catch {
    // Safari chế độ riêng tư, bộ nhớ đầy: bỏ qua, lần sau chọn lại.
  }
}

export function vnDate(at: Date | string): string {
  const date = at instanceof Date ? at : new Date(at);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: INTERCOM_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** `YYYY-MM-DD` cộng `days` ngày (tính theo lịch, không theo múi giờ máy). */
export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` thành `dd/mm`. */
export function shortDate(isoDate: string): string {
  const [, m, d] = isoDate.split("-");
  return `${d}/${m}`;
}

export function dayLabel(startDate: string, date: string): string {
  const dayNumber = Math.round((Date.parse(date) - Date.parse(startDate)) / 86_400_000) + 1;
  return `Ngày ${dayNumber} (${shortDate(date)})`;
}

export function vnTime(at: string): string {
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: INTERCOM_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
  }).format(new Date(at));
}

const CODE_PATTERN = /^([A-Z]+)(\d+)$/;
/**
 * Mã tai chủ `<prefix>M` là `seq = 0`. Mã thường luôn tận cùng bằng số, nên chuỗi chỉ có chữ, tận cùng `M` là
 * tai chủ: `AM` là tai chủ bộ `A`, khác `AM1` (bộ `AM`, số 1).
 */
const MASTER_CODE_PATTERN = /^([A-Z]{1,4})M$/;
const MASTER_SEQ = 0;

function splitCode(code: string): { prefix: string; seq: number } | null {
  const match = CODE_PATTERN.exec(code);
  if (match) return { prefix: match[1] ?? "", seq: Number(match[2]) };
  const master = MASTER_CODE_PATTERN.exec(code);
  return master ? { prefix: master[1] ?? "", seq: MASTER_SEQ } : null;
}

function joinCode(part: { prefix: string; seq: number }): string {
  return part.seq === MASTER_SEQ ? `${part.prefix}M` : `${part.prefix}${part.seq}`;
}

/** So hai mã theo Prefix rồi số; tai chủ `KM` đứng đầu bộ. */
export function compareCodes(a: string, b: string): number {
  const parsedA = splitCode(a);
  const parsedB = splitCode(b);
  if (!parsedA || !parsedB) return a.localeCompare(b);
  return parsedA.prefix === parsedB.prefix ? parsedA.seq - parsedB.seq : parsedA.prefix.localeCompare(parsedB.prefix);
}

/** Tai chủ đứng riêng: `AM, A1-A10`. */
export function compactCodes(codes: readonly string[]): string {
  const sorted = [...new Set(codes)].sort(compareCodes);
  const parts: string[] = [];
  let runStart: { prefix: string; seq: number } | null = null;
  let runEnd: { prefix: string; seq: number } | null = null;
  const flush = () => {
    if (!runStart || !runEnd) return;
    parts.push(runStart.seq === runEnd.seq ? joinCode(runStart) : `${joinCode(runStart)}-${joinCode(runEnd)}`);
  };
  for (const code of sorted) {
    const parsed = splitCode(code);
    if (!parsed) {
      flush();
      runStart = null;
      runEnd = null;
      parts.push(code);
      continue;
    }
    // Tai chủ không mở dải, không nối dải: `AM` đứng riêng trước `A1`.
    if (
      runEnd &&
      runStart &&
      runStart.seq !== MASTER_SEQ &&
      parsed.prefix === runEnd.prefix &&
      parsed.seq === runEnd.seq + 1
    ) {
      runEnd = parsed;
      continue;
    }
    flush();
    runStart = parsed;
    runEnd = parsed;
  }
  flush();
  return parts.join(", ");
}

/** Ô mã trên dấu ảnh: `drawStamp` không cắt vế mã, nên chuỗi quá dài thì giữ phần đầu và ghi tổng số mã. */
const STAMP_CODES_MAX_CHARS = 40;

export function stampCodes(codes: readonly string[]): string {
  const full = compactCodes(codes);
  if (full.length <= STAMP_CODES_MAX_CHARS) return full;
  const parts = full.split(", ");
  let kept = "";
  for (const part of parts) {
    const next = kept ? `${kept}, ${part}` : part;
    if (next.length > STAMP_CODES_MAX_CHARS - 12) break;
    kept = next;
  }
  return `${kept}... (${new Set(codes).size} mã)`;
}

/** Bộ phận chữ cố định cho lượt giao chưa có tên người nhận; điền tên sau ở Dashboard. */
export const UNNAMED_DEPARTMENT = "Chưa rõ tên";

/** Nhãn bộ phận cộng nhóm cho lượt giao bộ phận. */
export function departmentLabel(department: string, group: number): string {
  return `${department} (Nhóm ${group})`;
}

/** Khoá dòng: người (`p:<id>`) hoặc cặp bộ phận, nhóm của lượt giao bộ phận (`d:<bộ phận>|<nhóm>`). */
export function issueRowKey(issue: Pick<IntercomIssue, "person_id" | "department" | "group_no">): string {
  return issue.person_id ? `p:${issue.person_id}` : `d:${issue.department}|${issue.group_no}`;
}

/** Mã đang ở ngoài (chưa thu) của bảng. */
export function openUnitIds(board: IntercomBoard): Set<string> {
  return new Set(board.issues.filter((i) => !i.collect_handover_id).map((i) => i.unit_id));
}

/**
 * Nhóm mã theo Prefix để vẽ lưới (giữ thứ tự `units` máy chủ trả: prefix rồi `seq`, nên tai chủ `seq = 0` đứng
 * đầu bộ).
 */
export function unitsByPrefix(units: readonly IntercomUnit[]): { prefix: string; units: IntercomUnit[] }[] {
  const groups: { prefix: string; units: IntercomUnit[] }[] = [];
  for (const unit of units) {
    const last = groups[groups.length - 1];
    if (last && last.prefix === unit.prefix) last.units.push(unit);
    else groups.push({ prefix: unit.prefix, units: [unit] });
  }
  return groups;
}

/** Bộ phận đã biết của dự án (từ người nhận và từ các lượt giao bộ phận). */
export function knownDepartments(board: IntercomBoard): string[] {
  const names = new Set<string>();
  for (const p of board.people) if (p.department) names.add(p.department);
  for (const i of board.issues) if (i.department) names.add(i.department);
  return [...names].sort((a, b) => a.localeCompare(b, "vi"));
}

/** Giờ VN `HH:mm, dd/mm` cho chế độ Danh sách. */
export function vnClock(at: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: INTERCOM_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("hour")}:${get("minute")}, ${get("day")}/${get("month")}`;
}

export function vnHourMinute(at: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: INTERCOM_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(at));
}

/** Tên bộ phận để đếm và gán màu: bỏ khoảng trắng hai đầu, rỗng thì về bộ phận chữ cố định. */
export function normalizedDepartment(department: string): string {
  return department.trim() || UNNAMED_DEPARTMENT;
}

export const INTERCOM_WORKDAY_START_HOUR = 5;

export function vnWorkday(at: Date | string): string {
  const time = (at instanceof Date ? at : new Date(at)).getTime();
  return vnDate(new Date(time - INTERCOM_WORKDAY_START_HOUR * 60 * 60 * 1000));
}

const WORKDAY_MS = 24 * 60 * 60 * 1000;

export type IntercomDayPeak = { counts: Map<string, number>; at: number; atDayStart: boolean };

/** Số tai theo bộ phận tại thời điểm nhiều tai ở ngoài nhất của ngày đã qua `date`. */
export function peakUnitsByDepartment(board: IntercomBoard, date: string): IntercomDayPeak {
  const startHour = String(INTERCOM_WORKDAY_START_HOUR).padStart(2, "0");
  const start = Date.parse(`${date}T${startHour}:00:00+07:00`);
  const end = start + WORKDAY_MS;

  const deliverTimes = new Map(board.handovers.map((h) => [h.id, Date.parse(h.taken_at)]));
  const trips = board.issues.flatMap((issue) => {
    const takenAt = deliverTimes.get(issue.deliver_handover_id);
    if (takenAt === undefined) return [];
    return [
      {
        unitId: issue.unit_id,
        department: issue.department,
        takenAt,
        collectedAt: issue.collected_at ? Date.parse(issue.collected_at) : null,
      },
    ];
  });

  const moments = new Set([start]);
  for (const trip of trips) if (trip.takenAt >= start && trip.takenAt < end) moments.add(trip.takenAt);

  type Trip = (typeof trips)[number];
  let peakAt = start;
  let peakUnits = new Map<string, Trip>();
  // Xét theo giờ tăng dần, chỉ thay khi cao hơn hẳn: hoà thì giữ thời điểm sớm nhất.
  for (const moment of [...moments].sort((a, b) => a - b)) {
    const units = new Map<string, Trip>();
    for (const trip of trips) {
      if (trip.takenAt > moment) continue;
      if (trip.collectedAt !== null && trip.collectedAt <= moment) continue;
      const seen = units.get(trip.unitId);
      if (!seen || trip.takenAt > seen.takenAt) units.set(trip.unitId, trip);
    }
    if (units.size > peakUnits.size) {
      peakUnits = units;
      peakAt = moment;
    }
  }

  const counts = new Map<string, number>();
  for (const trip of peakUnits.values()) {
    const name = normalizedDepartment(trip.department);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return { counts, at: peakAt, atDayStart: peakAt === start };
}

/** Bỏ dấu tiếng Việt, chữ thường, gộp khoảng trắng: tìm "nguyen" ra "Nguyễn". */
export function foldText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Khoá localStorage nhớ chế độ xem dashboard, trang khách: `table` hoặc `list`. */
const VIEW_STORAGE_KEY = "intercom.view";

export type IntercomBoardView = "table" | "list";

/** Chế độ đã nhớ; chưa nhớ thì điện thoại (dưới 768px) mặc định Danh sách, máy lớn mặc định Bảng. */
export function readStoredView(fallback?: IntercomBoardView): IntercomBoardView {
  try {
    const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
    if (stored === "table" || stored === "list") return stored;
  } catch {
    // Safari chế độ riêng tư: bỏ qua, theo khổ màn.
  }
  if (fallback) return fallback;
  return window.matchMedia("(max-width: 767px)").matches ? "list" : "table";
}

export function storeView(view: IntercomBoardView): void {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // Bộ nhớ đầy, chế độ riêng tư: lần sau theo khổ màn.
  }
}

/**
 * Ô tìm của dashboard, trang khách: `query` đã qua `foldText`. Khớp khi tên người hoặc bộ phận CHỨA chuỗi gõ
 * (không dấu, không phân biệt hoa thường: "nguyen" ra "Nguyễn"), hoặc một mã tai TRÙNG chuỗi gõ. Chuỗi
 * rỗng là khớp hết.
 */
export function matchesBoardSearch(query: string, texts: readonly string[], codes: readonly string[]): boolean {
  if (!query) return true;
  if (texts.some((t) => foldText(t).includes(query))) return true;
  const code = query.replace(/\s+/g, "");
  return codes.some((c) => foldText(c) === code);
}

// Phân tích danh sách người đọc từ Google Sheet, chạy ở máy.
// Đọc theo VỊ TRÍ cột: cột 1 Tên, 2 Bộ phận, 3 Nhóm, 4 Số điện thoại; tiêu
// đề chỉ so lỏng để cảnh báo. Máy chủ kiểm lại mọi luật khi Ghi.

import type { IntercomPerson } from "./staffIntercom";
import {
  INTERCOM_BULK_PEOPLE_MAX,
  INTERCOM_NAME_MAX,
  intercomNameKey,
  normalizeIntercomPhone,
  type IntercomSheetApplyRow,
} from "./staffIntercomProject";

/** Hàng tiêu đề của Sheet mẫu, đúng thứ tự cột. */
export const INTERCOM_SHEET_HEADER = ["Tên", "Bộ phận", "Nhóm", "Số điện thoại"] as const;

/** Một ô khác giữa Sheet và app. */
export type IntercomSheetDiff = { label: string; before: string; after: string };

export type IntercomSheetPreview = {
  /** Hàng tiêu đề khác mẫu (so lỏng): cảnh báo khách đổi thứ tự cột, thêm cột. */
  headerMismatch: boolean;
  adds: { line: number; row: IntercomSheetApplyRow }[];
  /** Người đã có trên app mà Sheet khác: chỉ đè khi người dùng tick. */
  changes: { line: number; row: IntercomSheetApplyRow; person: IntercomPerson; diffs: IntercomSheetDiff[] }[];
  invalid: { line: number; reason: string }[];
  /** Quá trần một lượt Ghi. */
  tooMany: boolean;
};

/** Bỏ dấu, chữ thường, bỏ khoảng trắng: so tiêu đề kiểu lỏng. */
function looseKey(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/\s+/g, "");
}

/** Hàng tiêu đề khớp mẫu không (bốn ô đầu, so lỏng; cột thừa phía sau không tính). */
export function intercomSheetHeaderMatches(header: readonly string[]): boolean {
  return INTERCOM_SHEET_HEADER.every((label, i) => looseKey(header[i] ?? "") === looseKey(label));
}

/** Cột Nhóm: nhận "2" hoặc "Nhóm 2". */
function parseGroup(text: string): number | null {
  const match = /^(?:nh[oó]m\s*)?(\d{1,2})$/i.exec(text.trim());
  return match ? Number(match[1]) : null;
}

function clean(cell: string | undefined): string {
  return (cell ?? "").trim().replace(/\s+/g, " ");
}

/**
 * Chia các dòng dữ liệu (không gồm tiêu đề) thành Thêm mới, Khác với app, Lỗi. Người trên app không có trong
 * Sheet: không liệt kê. Ô số trống không tính là khác. Tên trùng một dòng trước trong Sheet là lỗi dòng (máy chủ
 * sẽ bỏ qua dòng đó).
 */
export function parseIntercomSheetRows(
  rows: readonly (readonly string[])[],
  groupCount: number,
  people: readonly IntercomPerson[],
): Omit<IntercomSheetPreview, "headerMismatch"> {
  const known = new Map(people.map((p) => [intercomNameKey(p.full_name), p] as const));
  const seen = new Map<string, number>();
  const adds: IntercomSheetPreview["adds"] = [];
  const changes: IntercomSheetPreview["changes"] = [];
  const invalid: IntercomSheetPreview["invalid"] = [];

  rows.forEach((cells, index) => {
    const line = index + 2;
    if (cells.every((cell) => clean(cell) === "")) return;
    const name = clean(cells[0]);
    const department = clean(cells[1]);
    const groupText = clean(cells[2]);
    const phoneText = clean(cells[3]);
    if (name === "") return invalid.push({ line, reason: "Thiếu tên" });
    if (name.length > INTERCOM_NAME_MAX) return invalid.push({ line, reason: `Tên dài quá ${INTERCOM_NAME_MAX} ký tự` });
    if (department === "") return invalid.push({ line, reason: "Thiếu bộ phận" });
    const group = parseGroup(groupText);
    if (group === null || group < 1 || group > groupCount) return invalid.push({ line, reason: `Nhóm phải từ 1 tới ${groupCount}` });
    const phone = normalizeIntercomPhone(phoneText);
    if (phone === null) return invalid.push({ line, reason: "Số điện thoại sai khuôn" });

    const key = intercomNameKey(name);
    const firstLine = seen.get(key);
    if (firstLine !== undefined) return invalid.push({ line, reason: `Trùng tên với dòng ${firstLine}` });
    seen.set(key, line);

    const row: IntercomSheetApplyRow = { full_name: name, department, group_no: String(group), phone };
    const person = known.get(key);
    if (!person) return adds.push({ line, row });

    const diffs: IntercomSheetDiff[] = [];
    if (person.department !== department) diffs.push({ label: "Bộ phận", before: person.department, after: department });
    if (Number(person.group_no) !== group) diffs.push({ label: "Nhóm", before: String(person.group_no), after: String(group) });
    if (phone !== "" && (person.phone ?? "") !== phone) diffs.push({ label: "Số điện thoại", before: person.phone ?? "", after: phone });
    if (diffs.length > 0) changes.push({ line, row, person, diffs });
  });

  return { adds, changes, invalid, tooMany: adds.length + changes.length > INTERCOM_BULK_PEOPLE_MAX };
}

/** Gộp: tiêu đề cộng các dòng. */
export function buildIntercomSheetPreview(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  groupCount: number,
  people: readonly IntercomPerson[],
): IntercomSheetPreview {
  return { headerMismatch: !intercomSheetHeaderMatches(header), ...parseIntercomSheetRows(rows, groupCount, people) };
}

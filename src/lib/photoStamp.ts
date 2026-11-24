// Một tệp cho ba việc, mọi màn dùng chung:
// - `drawStamp`: vẽ dải dấu kín bề ngang, sát đáy khung. Khung dọc, vuông: hai hàng (giờ + chặng | mã đơn; người
// chụp | toạ độ). Khung ngang: một hàng (giờ · chặng · mã đơn · người chụp · toạ độ).
// - `readLibraryPhotoMeta`: đọc EXIF ảnh chọn từ thư viện TRƯỚC khi vẽ lại (vẽ lại là mất EXIF). Vì sao `exifr`
// nạp bằng `import()` động trong hàm: nhập tĩnh là mọi màn dùng tệp này kéo
// theo thư viện đọc EXIF.

/** Nguồn tệp: chụp, quay ngay trong web hay chọn từ thư viện máy. Khớp `SOURCES` của route ảnh. */
export type StampSource = "camera" | "library";
/** Nguồn giờ, nguồn vị trí: EXIF của ảnh hay giờ, vị trí của máy lúc tải. Khớp route. */
export type StampOrigin = "exif" | "device";
export type StampStage = "delivery" | "return";

export const STAMP_STAGE_LABELS: Record<StampStage, string> = {
  delivery: "LÚC GIAO",
  return: "LÚC NHẬN",
};

export const STAMP_TIME_ZONE = "Asia/Ho_Chi_Minh";

/** Chữ cái đầu của tên. Tên rỗng thì trả dấu hỏi chứ không trả ô trắng. */
export function initial(name: string | null | undefined): string {
  const text = (name ?? "").trim();
  if (text === "") return "?";
  return text.slice(0, 1).toUpperCase();
}

export type StampInput = {
  /** Cỡ khung vẽ (điểm ảnh thật của ảnh, khung video). */
  width: number;
  height: number;
  takenAt: Date | string | number;
  source: StampSource;
  timeSource: StampOrigin;
  /** "LÚC GIAO" hoặc "LÚC NHẬN", lấy từ `STAMP_STAGE_LABELS`. */
  stageLabel: string;
  /** Mã in trên dấu. */
  orderCode: string;
  staffName: string | null | undefined;
  /** Ảnh đại diện đã nạp sẵn (`loadStampAvatar`); null thì vẽ vòng tròn chữ cái đầu. */
  avatar: CanvasImageSource | null;
  latitude: number | null | undefined;
  longitude: number | null | undefined;
  locationSource: StampOrigin | null | undefined;
};

// Mọi avatar cùng một màu, không băm màu theo tên.
const AVATAR_FILL = "#5b6470";
const TEXT_FILL = "#ffffff";
const BOX_FILL = "rgba(0, 0, 0, 0.55)";
const FONT_FAMILY = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif";

let stampTimeFormat: Intl.DateTimeFormat | null = null;

export function formatStampTime(takenAt: Date | string | number): string {
  const date = takenAt instanceof Date ? takenAt : new Date(takenAt);
  if (Number.isNaN(date.getTime())) return "";
  stampTimeFormat ??= new Intl.DateTimeFormat("en-GB", {
    timeZone: STAMP_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts: Record<string, string> = {};
  for (const part of stampTimeFormat.formatToParts(date)) parts[part.type] = part.value;
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
}

function hasPosition(latitude: number | null | undefined, longitude: number | null | undefined): boolean {
  return (
    typeof latitude === "number" &&
    typeof longitude === "number" &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude)
  );
}

/** Ô vuông lớn nhất giữa ảnh nguồn; nguồn không đọc được cỡ (hoặc cỡ 0) thì null, vẽ cả ảnh như cũ. */
function squareCrop(source: CanvasImageSource): { x: number; y: number; side: number } | null {
  const sized = source as { width?: unknown; height?: unknown; videoWidth?: unknown; videoHeight?: unknown };
  const rawWidth = typeof sized.videoWidth === "number" && sized.videoWidth > 0 ? sized.videoWidth : sized.width;
  const rawHeight = typeof sized.videoHeight === "number" && sized.videoHeight > 0 ? sized.videoHeight : sized.height;
  if (typeof rawWidth !== "number" || typeof rawHeight !== "number") return null;
  if (!(rawWidth > 0) || !(rawHeight > 0)) return null;
  const side = Math.min(rawWidth, rawHeight);
  return { x: (rawWidth - side) / 2, y: (rawHeight - side) / 2, side };
}

/** Các mẩu chữ của dấu, chưa xếp hàng. Tách riêng để đo được mà không cần khung vẽ. */
export type StampTexts = {
  timeStage: string;
  orderCode: string;
  /** Tên người chụp; tên rỗng ra "?". Mẩu duy nhất được cắt "…" khi thiếu chỗ. */
  staffName: string;
  /** "10.000000, 106.000000 (vị trí tải)"; chuỗi rỗng khi không có toạ độ. */
  position: string;
};

/**
 * Khung dọc, vuông xếp hai hàng: hàng 1 `timeStage` trái, `orderCode` phải; hàng 2 `staffName` trái, `position`
 * phải (rỗng thì vế phải bỏ trống). Khung ngang xếp một hàng `timeStage · orderCode
 * · staffName · position`.
 */
export function stampLines(input: StampInput): StampTexts {
  const fromLibrary = input.source === "library";
  const timeNote = fromLibrary && input.timeSource === "device" ? " (giờ tải)" : "";
  let position = "";
  if (hasPosition(input.latitude, input.longitude)) {
    const placeNote = fromLibrary && input.locationSource === "device" ? " (vị trí tải)" : "";
    position = `${(input.latitude as number).toFixed(6)}, ${(input.longitude as number).toFixed(6)}${placeNote}`;
  }
  return {
    timeStage: `${formatStampTime(input.takenAt)}${timeNote} · ${input.stageLabel}`,
    orderCode: input.orderCode,
    // NFC một lần: tên lưu dạng tổ hợp (NFD) cắt, đếm theo code point sẽ rơi dấu; sau NFC mỗi chữ Việt là một code
    // point.
    staffName: ((input.staffName ?? "").trim() || "?").normalize("NFC"),
    position,
  };
}

const SEPARATOR = " · ";
const ELLIPSIS = "…";
/** Khung ngang: tên cắt còn ít hơn số ký tự này trước "…" thì chuyển hai hàng. */
const MIN_KEPT_NAME_CHARS = 8;

/**
 * Một hàng của dải: vế trái sát avatar, vế phải canh mép phải (rỗng thì bỏ). Bề ngang đo sẵn để khỏi đo mỗi
 * khung.
 */
type StampRow = { left: string; leftWidth: number; right: string; rightWidth: number };

type StampLayout = { rows: StampRow[] };

// `drawStamp` chạy mỗi khung video (30 khung mỗi giây): nhớ bố cục đã đo (gồm tên đã cắt) theo chữ, cỡ chữ, cỡ
// khung để không gọi `measureText` lại mỗi khung. Giờ đổi mỗi phút nên số khoá ít; quá ngưỡng thì xoá sạch.
const LAYOUT_CACHE_LIMIT = 32;
const layoutCache = new Map<string, StampLayout>();

/**
 * Cắt `name` cho vừa `maxWidth` (đã đặt `ctx.font`), thêm "…" khi cắt. Vừa nguyên thì trả nguyên. Không còn chỗ
 * cho một ký tự nào thì trả "…" (người gọi tự xét "…" có tràn không).
 */
function fitName(ctx: CanvasRenderingContext2D, name: string, maxWidth: number): string {
  if (ctx.measureText(name).width <= maxWidth) return name;
  const chars = Array.from(name);
  let low = 0;
  let high = chars.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = `${chars.slice(0, mid).join("").trimEnd()}${ELLIPSIS}`;
    if (ctx.measureText(candidate).width <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return `${chars.slice(0, low).join("").trimEnd()}${ELLIPSIS}`;
}

/** Hai hàng: chỉ tên (hàng 2) được cắt; hàng 1 tràn thì vế phải tự đẩy ra quá mép phải. */
function twoRowLayout(ctx: CanvasRenderingContext2D, texts: StampTexts, available: number, gap: number): StampLayout {
  const positionWidth = texts.position ? ctx.measureText(texts.position).width : 0;
  const nameMax = texts.position ? available - gap - positionWidth : available;
  const name = fitName(ctx, texts.staffName, nameMax);
  return {
    rows: [
      {
        left: texts.timeStage,
        leftWidth: ctx.measureText(texts.timeStage).width,
        right: texts.orderCode,
        rightWidth: ctx.measureText(texts.orderCode).width,
      },
      { left: name, leftWidth: ctx.measureText(name).width, right: texts.position, rightWidth: positionWidth },
    ],
  };
}

/**
 * Một hàng; null khi phải cắt tên mà giữ được dưới `MIN_KEPT_NAME_CHARS` ký tự trước "…" (kể cả chỉ còn "…"),
 * hoặc vẫn tràn, lúc đó khung ngang chuyển hai hàng.
 */
function oneRowLayout(ctx: CanvasRenderingContext2D, texts: StampTexts, available: number): StampLayout | null {
  const head = `${texts.timeStage}${SEPARATOR}${texts.orderCode}${SEPARATOR}`;
  const tail = texts.position ? `${SEPARATOR}${texts.position}` : "";
  const nameMax = available - ctx.measureText(head).width - ctx.measureText(tail).width;
  const name = fitName(ctx, texts.staffName, nameMax);
  if (ctx.measureText(name).width > nameMax) return null;
  if (name !== texts.staffName && Array.from(name).length - ELLIPSIS.length < MIN_KEPT_NAME_CHARS) return null;
  const line = `${head}${name}${tail}`;
  return { rows: [{ left: line, leftWidth: ctx.measureText(line).width, right: "", rightWidth: 0 }] };
}

/**
 * Vẽ dấu lên khung vẽ đã có ảnh, khung video. Gọi mỗi khung hình được (không nạp gì, không chờ gì). Dải nền kín
 * bề ngang, sát đáy; cỡ chữ khoảng 2,2% cạnh ngắn, tối thiểu 14px. Khung ngang (`width > height`) một hàng,
 * avatar cao một hàng; khung dọc, vuông hai hàng, avatar cao hai hàng. Thiếu chỗ thì chỉ cắt tên bằng "…"; khung
 * ngang cắt hết tên vẫn tràn thì dùng hai hàng; hai hàng vẫn tràn (ảnh rất nhỏ) thì để tràn mép phải.
 */
export function drawStamp(ctx: CanvasRenderingContext2D, input: StampInput): void {
  const texts = stampLines(input);
  const fontSize = Math.max(14, Math.round(Math.min(input.width, input.height) * 0.022));
  const lineHeight = Math.round(fontSize * 1.3);
  const padding = Math.round(fontSize * 0.6);
  const gap = Math.round(fontSize * 0.5);
  const landscape = input.width > input.height;
  const font = `600 ${fontSize}px ${FONT_FAMILY}`;

  ctx.save();
  ctx.font = font;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";

  // Bề ngang chữ tính theo avatar của bố cục được chọn: khung ngang thử một hàng (avatar một hàng) trước.
  const oneRowAvatar = lineHeight;
  const twoRowAvatar = lineHeight * 2 - Math.round(fontSize * 0.3);
  const cacheKey = [font, input.width, input.height, texts.timeStage, texts.orderCode, texts.staffName, texts.position].join("\n");
  let layout = layoutCache.get(cacheKey);
  if (!layout) {
    const textRight = input.width - padding;
    const oneRow = landscape ? oneRowLayout(ctx, texts, textRight - (padding + oneRowAvatar + gap)) : null;
    layout = oneRow ?? twoRowLayout(ctx, texts, textRight - (padding + twoRowAvatar + gap), gap);
    if (layoutCache.size >= LAYOUT_CACHE_LIMIT) layoutCache.clear();
    layoutCache.set(cacheKey, layout);
  }

  const rowCount = layout.rows.length;
  const avatarSize = rowCount === 1 ? oneRowAvatar : twoRowAvatar;
  const bandHeight = padding * 2 + lineHeight * rowCount;
  const bandY = input.height - bandHeight;

  ctx.fillStyle = BOX_FILL;
  ctx.fillRect(0, bandY, input.width, bandHeight);

  // Avatar bên trái, giữa chiều cao các hàng chữ.
  const avatarX = padding;
  const avatarY = bandY + padding + Math.round((lineHeight * rowCount - avatarSize) / 2);
  const radius = avatarSize / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(avatarX + radius, avatarY + radius, radius, 0, Math.PI * 2);
  ctx.closePath();
  if (input.avatar) {
    ctx.clip();
    // Cắt hình vuông giữa ảnh như `object-cover`: ảnh không vuông không bị kéo méo.
    const crop = squareCrop(input.avatar);
    if (crop) {
      ctx.drawImage(input.avatar, crop.x, crop.y, crop.side, crop.side, avatarX, avatarY, avatarSize, avatarSize);
    } else {
      ctx.drawImage(input.avatar, avatarX, avatarY, avatarSize, avatarSize);
    }
  } else {
    ctx.fillStyle = AVATAR_FILL;
    ctx.fill();
    ctx.fillStyle = TEXT_FILL;
    ctx.font = `600 ${Math.round(avatarSize * 0.5)}px ${FONT_FAMILY}`;
    ctx.textAlign = "center";
    ctx.fillText(initial(texts.staffName), avatarX + radius, avatarY + radius);
  }
  ctx.restore();

  ctx.fillStyle = TEXT_FILL;
  const textX = avatarX + avatarSize + gap;
  const textRight = input.width - padding;
  layout.rows.forEach((row, index) => {
    const y = bandY + padding + lineHeight * index + lineHeight / 2;
    ctx.fillText(row.left, textX, y);
    if (row.right) {
      ctx.fillText(row.right, Math.max(textRight - row.rightWidth, textX + row.leftWidth + gap), y);
    }
  });
  ctx.restore();
}

/**
 * Nạp ảnh đại diện thành `ImageBitmap` để vẽ. Lỗi gì cũng trả null (vẽ vòng tròn chữ). Nạp qua `fetch` rồi
 * `createImageBitmap(blob)`: ảnh `http` không cho CORS thì `fetch` hỏng, rơi về vòng tròn chữ, khung vẽ không
 * bao giờ bị khoá xuất. `data:` URL đi cùng lối.
 */
export async function loadStampAvatar(url: string | null | undefined): Promise<ImageBitmap | null> {
  if (!url) return null;
  try {
    const response = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!response.ok) return null;
    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) return null;
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

/** Giải mã ảnh thư viện, xoay theo thẻ hướng của ảnh (`imageOrientation: 'from-image'`). */
export function decodeUprightImage(file: Blob): Promise<ImageBitmap> {
  return createImageBitmap(file, { imageOrientation: "from-image" });
}

export type LibraryPhotoMeta = {
  /** Giờ chụp gốc (`DateTimeOriginal`); null thì dùng giờ tải, `timeSource='device'`. */
  takenAt: Date | null;
  latitude: number | null;
  longitude: number | null;
};

// Khoá có nháy: đây là tên tuỳ chọn của exifr, không phải tên mình đặt.
type PhotoTagOptions = { tiff: boolean; "exif": boolean; gps: boolean; "xmp": boolean; reviveValues: boolean };
type PhotoTagReader = {
  parse: (data: Blob, options: PhotoTagOptions) => Promise<Record<string, unknown> | undefined>;
};

const CAPTURE_TIME_RE = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;
const ZONE_OFFSET_RE = /^[+-]\d{2}:\d{2}$/;

function parseCaptureTime(raw: unknown, offset: unknown): Date | null {
  if (typeof raw !== "string") return null;
  const match = CAPTURE_TIME_RE.exec(raw.trim());
  if (!match) return null;
  const zone = typeof offset === "string" && ZONE_OFFSET_RE.test(offset.trim()) ? offset.trim() : "+07:00";
  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${zone}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Đọc giờ chụp gốc và toạ độ từ EXIF ảnh thư viện. Ảnh không có EXIF (ảnh chụp màn hình) thì ra toàn null. */
export async function readLibraryPhotoMeta(file: Blob): Promise<LibraryPhotoMeta> {
  const empty: LibraryPhotoMeta = { takenAt: null, latitude: null, longitude: null };
  let reader: PhotoTagReader;
  try {
    // Bản `lite` (JPEG, HEIC; TIFF/EXIF, GPS) ghim 7.1.3. Gói không có tệp kiểu cho đường `dist/`,
    // nên ép về kiểu tối thiểu `PhotoTagReader` khai ở trên.
    // @ts-ignore: exifr/dist/lite.esm.mjs không có tệp .d.ts riêng
    reader = (await import("exifr/dist/lite.esm.mjs")) as unknown as PhotoTagReader;
  } catch {
    return empty;
  }
  // Một lượt đọc cho cả giờ lẫn toạ độ. `latitude`, `longitude` là số thập phân exifr tự đổi từ `GPSLatitude` +
  // `GPSLatitudeRef` (kể cả khi `reviveValues: false`).
  let tags: Record<string, unknown> | undefined;
  try {
    tags = await reader.parse(file, { tiff: true, "exif": true, gps: true, "xmp": false, reviveValues: false });
  } catch {
    return empty;
  }
  const takenAt = parseCaptureTime(tags?.DateTimeOriginal, tags?.OffsetTimeOriginal);
  const latitude = tags?.latitude;
  const longitude = tags?.longitude;
  if (typeof latitude !== "number" || typeof longitude !== "number" || !hasPosition(latitude, longitude)) {
    return { takenAt, latitude: null, longitude: null };
  }
  return { takenAt, latitude, longitude };
}

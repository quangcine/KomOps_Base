// Cài đặt chụp của màn Giao intercom. Mọi lượt đọc ghi bọc `try/catch` (Safari riêng tư, chặn lưu trữ): đọc hỏng
// trả mặc định, ghi hỏng thì bỏ qua. Không có "Mở camera sẵn": bấm Giao luôn mở camera. Màn Giao đọc
// `readIntercomCaptureSettings()` và `intercomPhotoLimits()`; màn Tôi ghi.

export type IntercomPhotoQuality = "saver" | "standard" | "high";

export type IntercomCaptureSettings = {
  /** Mặc định công tắc "Chèn dấu giờ, mã" cho ảnh chọn từ máy (ảnh chụp trong app luôn in dấu). */
  stampLibraryByDefault: boolean;
  /** Mức chất lượng ảnh gửi lần đầu. */
  photoQuality: IntercomPhotoQuality;
};

export const DEFAULT_INTERCOM_CAPTURE_SETTINGS: IntercomCaptureSettings = {
  stampLibraryByDefault: false,
  photoQuality: "standard",
};

const STORAGE_KEY = "intercom.capture.v1";

const PHOTO_QUALITIES: readonly IntercomPhotoQuality[] = ["saver", "standard", "high"];

function isPhotoQuality(value: unknown): value is IntercomPhotoQuality {
  return typeof value === "string" && (PHOTO_QUALITIES as readonly string[]).includes(value);
}

/** Đọc cài đặt trên máy; thiếu khoá, hỏng JSON, sai kiểu thì lấy mặc định cho từng trường. */
export function readIntercomCaptureSettings(): IntercomCaptureSettings {
  try {
    if (typeof window === "undefined") return { ...DEFAULT_INTERCOM_CAPTURE_SETTINGS };
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_INTERCOM_CAPTURE_SETTINGS };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_INTERCOM_CAPTURE_SETTINGS };
    const stored = parsed as Record<string, unknown>;
    return {
      stampLibraryByDefault:
        typeof stored.stampLibraryByDefault === "boolean"
          ? stored.stampLibraryByDefault
          : DEFAULT_INTERCOM_CAPTURE_SETTINGS.stampLibraryByDefault,
      photoQuality: isPhotoQuality(stored.photoQuality)
        ? stored.photoQuality
        : DEFAULT_INTERCOM_CAPTURE_SETTINGS.photoQuality,
    };
  } catch {
    return { ...DEFAULT_INTERCOM_CAPTURE_SETTINGS };
  }
}

/** Ghi một phần cài đặt (gộp với giá trị đang lưu); ghi hỏng thì bỏ qua. */
export function saveIntercomCaptureSettings(patch: Partial<IntercomCaptureSettings>): void {
  try {
    if (typeof window === "undefined") return;
    const next: IntercomCaptureSettings = { ...readIntercomCaptureSettings(), ...patch };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Bộ nhớ trình duyệt bị chặn hay đầy: giữ cài đặt cũ, màn vẫn chạy với mặc định.
  }
}

const KB = 1024;

/**
 * Trần nén ảnh theo mức. Lần đầu: trần dung lượng, cạnh dài, dãy cạnh co dần khi chất lượng sàn vẫn quá trần.
 * Lần thử lại sau lần gửi hỏng: cả ba mức đều 350 KB cạnh 1280. Trần route tải là 2 MB
 * (`api/intercom/upload/_shared.ts` `MAX_BYTES`) nên mức Cao 1 MB lọt.
 */
export function intercomPhotoLimits(q: IntercomPhotoQuality): {
  firstMaxBytes: number;
  firstLongSide: number;
  firstFallbackLongSides: number[];
  retryMaxBytes: number;
  retryLongSide: number;
} {
  const retry = { retryMaxBytes: 350 * KB, retryLongSide: 1280 };
  switch (q) {
    case "saver":
      return { firstMaxBytes: 350 * KB, firstLongSide: 1280, firstFallbackLongSides: [1024], ...retry };
    case "high":
      return { firstMaxBytes: 1024 * KB, firstLongSide: 1920, firstFallbackLongSides: [1600, 1280], ...retry };
    case "standard":
    default:
      return { firstMaxBytes: 500 * KB, firstLongSide: 1920, firstFallbackLongSides: [1600, 1280], ...retry };
  }
}

// ĐIỂM ĐẤU "TÊN, TÊN MIỀN": đổi tên hiển thị và gốc tên miền bằng biến môi trường, không sửa mã.

export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || "Intercom";

/** Gốc tên miền, không dấu gạch chéo cuối. Dùng cho link khách và địa chỉ quay về của Google. */
export const APP_ORIGIN = (process.env.NEXT_PUBLIC_APP_ORIGIN || "http://localhost:3000").replace(/\/+$/, "");
export const APP_HOST = new URL(APP_ORIGIN).host;

export const APP_IDENTITY = { fullName: APP_NAME, accentColor: "#c04a1a" } as const;

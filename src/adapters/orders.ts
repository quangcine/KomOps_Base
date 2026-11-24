// ĐIỂM ĐẤU "ĐƠN HÀNG" (giao diện): link mở một đơn ở hệ thống của bạn.
// Phần dữ liệu đơn nằm ở SQL: `_intercom_order_candidates_json`, `_intercom_order_prefill_json`
// (supabase/migrations/20260101000001_host_adapters.sql). Để nguyên thì màn chọn đơn hiện danh sách trống.
const ORDER_URL_TEMPLATE = process.env.NEXT_PUBLIC_ORDER_URL_TEMPLATE || "";

/** Mẫu dạng `https://example.com/orders/{id}`; chưa khai thì `null` và nút mở đơn bị ẩn. */
export function orderUrl(orderId: string): string | null {
  return ORDER_URL_TEMPLATE ? ORDER_URL_TEMPLATE.replace("{id}", encodeURIComponent(orderId)) : null;
}

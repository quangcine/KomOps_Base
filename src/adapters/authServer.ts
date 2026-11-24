// ĐIỂM ĐẤU "ĐĂNG NHẬP" (máy chủ): đọc phiên từ cookie. Route luôn gọi `auth.getUser()` để máy chủ kiểm lại token.
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

export type StaffCookieStore = {
  getAll: () => { name: string; value: string }[];
  set?: (options: { name: string; value: string } & Record<string, unknown>) => void;
};

export function staffServerClient(cookieStore: StaffCookieStore): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error("Thiếu NEXT_PUBLIC_SUPABASE_URL hoặc NEXT_PUBLIC_SUPABASE_ANON_KEY (xem .env.example)");
  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set?.({ name, value, ...options });
        } catch {
          // Cookie chỉ đọc ở Server Component: bỏ qua, trình duyệt tự làm mới phiên.
        }
      },
    },
  });
}

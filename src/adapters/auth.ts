// ĐIỂM ĐẤU "ĐĂNG NHẬP" (trình duyệt). Bản mẫu dùng Supabase Auth, email và mật khẩu.
// Đổi nhà cung cấp: giữ nguyên tên, kiểu của các hàm dưới đây. Mọi RPC đọc người gọi bằng `auth.uid()`,
// nên phiên mới vẫn phải sinh JWT mà Supabase nhận.
import { createBrowserClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function readSupabaseEnv(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error("Thiếu NEXT_PUBLIC_SUPABASE_URL hoặc NEXT_PUBLIC_SUPABASE_ANON_KEY (xem .env.example)");
  return { url, anonKey };
}

let browserClient: SupabaseClient | null = null;

/** Client mang phiên nhân viên. Phiên nằm ở cookie của đúng tên miền này, không chia cho tên miền con khác. */
export function staffClient(): SupabaseClient {
  if (browserClient) return browserClient;
  const { url, anonKey } = readSupabaseEnv();
  browserClient = createBrowserClient(url, anonKey, {
    cookieOptions: {
      path: "/",
      sameSite: "lax",
      secure: typeof window !== "undefined" && window.location.protocol === "https:",
    },
  });
  return browserClient;
}

/** Client không phiên: trang khách theo link, và việc nền của máy chủ. */
export function createWebClient(): SupabaseClient {
  const { url, anonKey } = readSupabaseEnv();
  return createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

export type StaffProfile = {
  id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  avatar_url: string | null;
  role_name: string | null;
  is_staff: boolean;
  is_admin: boolean;
};

/** Hồ sơ của chính người đăng nhập (RLS chỉ cho đọc dòng của mình). Chưa có dòng thì `null`. */
export async function getMyProfile(userId: string): Promise<StaffProfile | null> {
  const { data, error } = await staffClient()
    .from("profiles")
    .select("id, full_name, email, phone, avatar_url, role_name, is_staff, is_admin")
    .eq("id", userId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error("Chưa đọc được hồ sơ, thử lại giúp tôi.");
  return (data as StaffProfile | null) ?? null;
}

/** Sai email hoặc mật khẩu trả `false`; lỗi khác thì ném. */
export async function signIn(email: string, password: string): Promise<boolean> {
  const { data, error } = await staffClient().auth.signInWithPassword({ email, password });
  if (error) {
    if (error.code === "invalid_credentials") return false;
    throw new Error("Chưa đăng nhập được, thử lại giúp tôi.");
  }
  return data.session !== null;
}

/** Thoát trên mọi máy. */
export async function signOut(): Promise<void> {
  await staffClient().auth.signOut();
}

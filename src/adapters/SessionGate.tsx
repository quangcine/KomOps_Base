"use client";

// ĐIỂM ĐẤU "ĐĂNG NHẬP, QUYỀN" (giao diện). Cửa này chỉ để hiện đúng màn: quyền thật nằm ở RLS và các hàm SQL.
// Vào được khi hồ sơ chưa bị xoá và: là nhân viên (`profiles.is_staff`), hoặc là quản lý, thành viên của ít nhất một dự án.
import { createContext, useCallback, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { getIntercomAccess } from "@/lib/intercom/staffIntercom";
import { getMyProfile, signIn, signOut as signOutSession, staffClient, type StaffProfile } from "./auth";
import { APP_NAME } from "./brand";

export type WorkCtx = {
  userId: string;
  profile: StaffProfile | null;
  perms: { roleName: string | null; isStaff: boolean; isAdmin: boolean };
  signOut: () => Promise<void>;
};

const Ctx = createContext<WorkCtx | null>(null);

export function useWork(): WorkCtx {
  const value = useContext(Ctx);
  if (!value) throw new Error("useWork() phải nằm trong <SessionGate>");
  return value;
}

type Status =
  | { kind: "checking" }
  | { kind: "signed-out" }
  | { kind: "denied" }
  | { kind: "error" }
  | { kind: "granted"; userId: string; profile: StaffProfile | null };

export function SessionGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>({ kind: "checking" });

  const check = useCallback(async () => {
    try {
      const { data } = await staffClient().auth.getUser();
      const userId = data.user?.id;
      if (!userId) return setStatus({ kind: "signed-out" });
      const profile = await getMyProfile(userId);
      let allowed = profile?.is_staff === true || profile?.is_admin === true;
      // Không có hồ sơ, hoặc hồ sơ đã xoá (`deleted_at`): không cho vào, kể cả khi còn tên trong dự án.
      if (!allowed && profile !== null) {
        const access = await getIntercomAccess();
        allowed = access.is_manager || access.project_count > 0;
      }
      setStatus(allowed ? { kind: "granted", userId, profile } : { kind: "denied" });
    } catch {
      setStatus({ kind: "error" });
    }
  }, []);

  useEffect(() => {
    void check();
    const { data } = staffClient().auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") setStatus({ kind: "signed-out" });
    });
    return () => data.subscription.unsubscribe();
  }, [check]);

  const signOut = useCallback(async () => {
    await signOutSession();
    setStatus({ kind: "signed-out" });
  }, []);

  if (status.kind === "checking") return <p className="p-4 text-base text-muted">Đang tải...</p>;
  if (status.kind === "signed-out") return <SignInForm onDone={check} />;
  if (status.kind === "error") {
    return (
      <div className="p-4">
        <p className="text-base text-fg">Chưa kiểm tra được phiên đăng nhập.</p>
        <button type="button" className="mt-3 h-11 rounded-control border border-border px-4 text-base" onClick={() => void check()}>
          Thử lại
        </button>
      </div>
    );
  }
  if (status.kind === "denied") {
    return (
      <div className="p-4">
        <p className="text-base text-fg">Tài khoản này chưa được mở quyền.</p>
        <button type="button" className="mt-3 h-11 rounded-control border border-border px-4 text-base" onClick={() => void signOut()}>
          Đăng xuất
        </button>
      </div>
    );
  }
  const { userId, profile } = status;
  const perms = {
    roleName: profile?.role_name ?? null,
    isStaff: profile?.is_staff === true,
    isAdmin: profile?.is_admin === true,
  };
  return <Ctx.Provider value={{ userId, profile, perms, signOut }}>{children}</Ctx.Provider>;
}

function SignInForm({ onDone }: { onDone: () => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (await signIn(email.trim(), password)) await onDone();
      else setError("Sai email hoặc mật khẩu.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chưa đăng nhập được, thử lại giúp tôi.");
    } finally {
      setBusy(false);
    }
  }

  const inputClass = "h-11 w-full rounded-control border border-border bg-surface px-3 text-base text-fg";
  return (
    <form onSubmit={(event) => void submit(event)} className="mx-auto mt-16 flex w-full max-w-sm flex-col gap-3 p-4">
      <h1 className="text-title font-semibold text-fg">{APP_NAME}</h1>
      <input className={inputClass} type="email" autoComplete="username" placeholder="Email" aria-label="Email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      <input className={inputClass} type="password" autoComplete="current-password" placeholder="Mật khẩu" aria-label="Mật khẩu" required value={password} onChange={(e) => setPassword(e.target.value)} />
      {error && <p className="text-sm text-danger">{error}</p>}
      <button type="submit" disabled={busy} className="h-11 rounded-control bg-brand-cta text-base font-semibold text-white disabled:opacity-50">
        {busy ? "Đang đăng nhập..." : "Đăng nhập"}
      </button>
    </form>
  );
}

import { NextResponse } from "next/server";
import { UUID_RE } from "@/adapters/storage";
import { requireStaff } from "../../upload/_shared";
import {
  DRIVE_CONNECT_HOST,
  DRIVE_CONNECT_ORIGIN,
  DRIVE_FILE_SCOPE,
  DRIVE_REDIRECT_URI,
  DRIVE_STATE_COOKIE,
  DRIVE_STATE_COOKIE_PATH,
  readDriveSecret,
} from "../_shared";

/**
 * `attach=1`: ghi vào cookie `state.projectId.attach`, `callback` nối xong tự gắn vào dự án. Không dùng
 * `signInWithOAuth`: nó thay phiên nhân viên.
 */
export const dynamic = "force-dynamic";

const STATE_MAX_AGE_SECONDS = 600;

function backToProject(projectId: string, notice: string): NextResponse {
  return NextResponse.redirect(
    new URL(`/intercom/projects/${projectId}?drive_notice=${notice}`, DRIVE_CONNECT_ORIGIN),
    { status: 302, headers: { "cache-control": "no-store" } },
  );
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const projectId = (url.searchParams.get("project") ?? "").toLowerCase();
  if (!UUID_RE.test(projectId)) return Response.json({ error: "Tham số không hợp lệ" }, { status: 400 });
  const attach = url.searchParams.get("attach") === "1";

  // Cookie theo tên miền, URI cố định: tên miền khác thì chuyển về đúng chỗ rồi mới đặt cookie.
  if ((req.headers.get("host") ?? "").toLowerCase() !== DRIVE_CONNECT_HOST) {
    return NextResponse.redirect(
      new URL(`/api/intercom/drive/connect?project=${projectId}${attach ? "&attach=1" : ""}`, DRIVE_CONNECT_ORIGIN),
      { status: 302, headers: { "cache-control": "no-store" } },
    );
  }

  const staff = await requireStaff();
  if (staff instanceof Response) return backToProject(projectId, "forbidden");
  const manager = await staff.supa.rpc("intercom_is_manager");
  if (manager.error || manager.data !== true) return backToProject(projectId, "forbidden");

  let clientId: string;
  try {
    clientId = readDriveSecret("GOOGLE_DRIVE_CLIENT_ID");
  } catch {
    return backToProject(projectId, "config");
  }

  const state = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
  const authorize = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", DRIVE_REDIRECT_URI);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", `${DRIVE_FILE_SCOPE} openid email`);
  // Thiếu `access_type=offline` thì không có chìa dài hạn; thiếu `consent` thì lần nối lại không được gửi lại chìa;
  // thiếu `select_account` thì trình duyệt sẵn một tài khoản Google sẽ dùng luôn tài khoản đó, không hỏi.
  authorize.searchParams.set("access_type", "offline");
  authorize.searchParams.set("prompt", "consent select_account");
  authorize.searchParams.set("state", state);

  const res = NextResponse.redirect(authorize, { status: 302, headers: { "cache-control": "no-store" } });
  res.cookies.set(DRIVE_STATE_COOKIE, `${state}.${projectId}.${attach ? "1" : "0"}`, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: DRIVE_STATE_COOKIE_PATH,
    maxAge: STATE_MAX_AGE_SECONDS,
  });
  return res;
}

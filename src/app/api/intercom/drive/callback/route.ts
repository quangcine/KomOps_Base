import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { UUID_RE } from "@/adapters/storage";
import { requireStaff } from "../../upload/_shared";
import {
  DRIVE_CONNECT_ORIGIN,
  DRIVE_FILE_SCOPE,
  DRIVE_STATE_COOKIE,
  DRIVE_STATE_COOKIE_PATH,
  DriveError,
  attachDriveToProject,
  type DriveProjectStorage,
  encryptRefreshToken,
  exchangeGoogleCode,
  forgetDriveAccessToken,
  readDriveSecret,
  readIdTokenClaims,
} from "../_shared";

/**
 * Không log token, mã, `id_token`. Cờ `attach` trong cookie: dự án chưa có thư mục Drive, chưa có lượt thì gắn
 * tài khoản vừa nối, tạo thư mục (`attachDriveToProject`, một luồng với `drive/folder`). Lỗi thì
 * `drive_notice=attach_failed`, dự án giữ trạng thái chưa nối.
 */
export const dynamic = "force-dynamic";

const LOG_TAG = "[intercom/drive/callback]";

/** Cookie `state` dùng một lần: mọi nhánh đều xoá. */
function finish(projectId: string | null, notice: string): NextResponse {
  const path = projectId ? `/intercom/projects/${projectId}?drive_notice=${notice}` : "/intercom/projects";
  const res = NextResponse.redirect(new URL(path, DRIVE_CONNECT_ORIGIN), {
    status: 302,
    headers: { "cache-control": "no-store" },
  });
  res.cookies.set(DRIVE_STATE_COOKIE, "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: DRIVE_STATE_COOKIE_PATH,
    maxAge: 0,
  });
  return res;
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const store = await cookies();
  const [expectedState, cookieProject, cookieAttach] = (store.get(DRIVE_STATE_COOKIE)?.value ?? "").split(".");
  const projectId = cookieProject && UUID_RE.test(cookieProject) ? cookieProject.toLowerCase() : null;

  const state = url.searchParams.get("state");
  if (!projectId || !expectedState || state !== expectedState) return finish(projectId, "state");
  if (url.searchParams.get("error")) return finish(projectId, "cancelled");
  const code = url.searchParams.get("code");
  if (!code) return finish(projectId, "cancelled");

  const staff = await requireStaff();
  if (staff instanceof Response) return finish(projectId, "forbidden");
  const { supa } = staff;
  const manager = await supa.rpc("intercom_is_manager");
  if (manager.error || manager.data !== true) return finish(projectId, "forbidden");

  try {
    const { status, body } = await exchangeGoogleCode(code);
    if (status !== 200) {
      console.error(LOG_TAG, "code exchange failed", status);
      return finish(projectId, "exchange");
    }
    // Bỏ tick quyền Drive ở màn đồng ý thì không lưu `active`.
    const scopes = typeof body.scope === "string" ? body.scope.split(/\s+/) : [];
    if (!scopes.includes(DRIVE_FILE_SCOPE)) return finish(projectId, "scope");
    if (typeof body.refresh_token !== "string" || body.refresh_token === "") return finish(projectId, "no_refresh");

    const claims = readIdTokenClaims(body.id_token);
    if (
      claims?.aud !== readDriveSecret("GOOGLE_DRIVE_CLIENT_ID") ||
      typeof claims.sub !== "string" ||
      typeof claims.email !== "string"
    ) {
      return finish(projectId, "identity");
    }

    const saved = await supa.rpc("intercom_drive_account_save", {
      p_gate: readDriveSecret("INTERCOM_DRIVE_GATE"),
      p_sub: claims.sub,
      p_email: claims.email,
      p_cipher: await encryptRefreshToken(body.refresh_token),
    });
    if (saved.error) console.error(LOG_TAG, "account_save failed", saved.error.code);
    const accountId = (saved.data as { id?: unknown }[] | null)?.[0]?.id;
    if (typeof accountId !== "string") return finish(projectId, "save");
    forgetDriveAccessToken(accountId);
    if (cookieAttach !== "1") return finish(projectId, "connected");

    const read = await supa.rpc("intercom_project_storage", { p_project: projectId });
    const storage = ((read.data ?? []) as (DriveProjectStorage & { has_handover?: boolean })[])[0];
    if (read.error || !storage) {
      if (read.error) console.error(LOG_TAG, "read storage failed", read.error.code);
      return finish(projectId, "attach_failed");
    }
    // Đã có thư mục (người khác vừa gắn) hoặc đã có lượt: tài khoản vẫn nối xong, không gắn đè.
    if (storage.folder_id || storage.has_handover) return finish(projectId, "connected");
    const attached = await attachDriveToProject(supa, projectId, accountId, LOG_TAG);
    return finish(projectId, attached instanceof Response ? "attach_failed" : "connected");
  } catch (error) {
    if (!(error instanceof DriveError)) {
      console.error(LOG_TAG, "unexpected failure");
      return finish(projectId, "save");
    }
    return finish(projectId, error.code === "drive_config" ? "config" : "exchange");
  }
}

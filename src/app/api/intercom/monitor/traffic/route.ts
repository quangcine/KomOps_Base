import { getCloudflareContext } from "@opennextjs/cloudflare";
import { cookies } from "next/headers";
import { APP_HOST } from "@/adapters/brand";
import { staffServerClient } from "@/adapters/authServer";
import { NO_STORE_HEADERS, isSameOriginGet } from "../_shared";

/**
 * GraphQL `https://api.cloudflare.com/client/v4/graphql`, tập `httpRequestsAdaptiveGroups` dưới
 * `viewer.zones(filter: { zoneTag })`, lọc `clientRequestHTTPHost`. Byte vào: dò bằng introspection trường tổng
 * có chữ "request" và "bytes"; không có thì trả `bytes_in: null` (màn ghi "Cloudflare không cấp byte vào"),
 * không bịa số. Biến: `CF_ANALYTICS_TOKEN`, `CF_ZONE_ID` (xem `.dev.vars.example`).
 * Chưa có token: trả `{ configured: false }` (200). Token hỏng: `{ configured: true, error }`.
 */
export const dynamic = "force-dynamic";

const LOG_TAG = "[intercom/monitor/traffic]";
const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const UPLOAD_PATH_PATTERN = "/api/intercom/upload/%";
const DAY_MS = 24 * 60 * 60 * 1000;
/** Biên trên lùi chừng này so với bây giờ (Cloudflare gom số trễ vài giây). */
const UNTIL_LAG_MS = 60 * 1000;
/** Mỗi khoảng ngắn hơn 1 ngày một giây để không chạm trần của tập adaptive. */
const WINDOW_MS = DAY_MS - 1000;
const ZONE_TAG_PATTERN = /^[0-9a-f]{32}$/;

type Range = "24h" | "7d";

type GraphqlReply = { data?: unknown; errors?: { message?: string }[] };

function readEnv(name: string): string {
  try {
    const { env } = getCloudflareContext();
    const value = (env as unknown as Record<string, unknown>)[name];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  } catch {
    // Ngoài worker (vd `next dev`): đọc `process.env` ở dưới.
  }
  const fallback = process.env[name];
  return typeof fallback === "string" ? fallback.trim() : "";
}

async function graphql(token: string, query: string, variables: Record<string, unknown>): Promise<GraphqlReply> {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok && res.status !== 400) throw new Error(`Cloudflare GraphQL HTTP ${res.status}`);
  return (await res.json()) as GraphqlReply;
}

function graphqlError(reply: GraphqlReply): string | null {
  return Array.isArray(reply.errors) && reply.errors.length > 0
    ? (reply.errors[0]?.message ?? "Cloudflare GraphQL báo lỗi")
    : null;
}

/** Đệm theo isolate: tên trường byte vào của tập adaptive (`""` là đã dò mà không có). */
let requestBytesField: string | null = null;

/** Dò bằng introspection: kiểu tổng của `httpRequestsAdaptiveGroups` có trường byte yêu cầu không. */
async function findRequestBytesField(token: string): Promise<string> {
  if (requestBytesField !== null) return requestBytesField;
  const names = await graphql(token, "{ __schema { types { name } } }", {});
  const types = ((names.data as { __schema?: { types?: { name?: string }[] } } | undefined)?.__schema?.types ?? [])
    .map((t) => t.name ?? "")
    .filter((name) => /httpRequestsAdaptiveGroupsSum$/i.test(name));
  let found = "";
  for (const typeName of types) {
    const reply = await graphql(token, "query($name: String!) { __type(name: $name) { fields { name } } }", { name: typeName });
    const fields = ((reply.data as { __type?: { fields?: { name?: string }[] } } | undefined)?.__type?.fields ?? [])
      .map((f) => f.name ?? "");
    found = fields.find((name) => /request/i.test(name) && /bytes/i.test(name)) ?? "";
    if (found) break;
  }
  // Chỉ đệm khi dò được kiểu: lỗi tạm thời thì lần sau dò lại.
  if (types.length > 0) requestBytesField = found;
  return found;
}

/** Hạn giữ dữ liệu của tập adaptive (giây); `null` khi không đọc được. */
async function readRetentionSeconds(token: string, zone: string): Promise<number | null> {
  try {
    const reply = await graphql(
      token,
      `query($zone: String!) { viewer { zones(filter: { zoneTag: $zone }) { settings { httpRequestsAdaptiveGroups { notOlderThan } } } } }`,
      { zone },
    );
    const value = (
      reply.data as
        | { viewer?: { zones?: { settings?: { httpRequestsAdaptiveGroups?: { notOlderThan?: unknown } } }[] } }
        | undefined
    )?.viewer?.zones?.[0]?.settings?.httpRequestsAdaptiveGroups?.notOlderThan;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

type WindowTotals = {
  requests: number;
  bytesOut: number;
  bytesIn: number;
  clientErrors: number;
  serverErrors: number;
  status499: number;
  uploads: Map<string, number>;
};

async function queryWindow(
  token: string,
  zone: string,
  since: Date,
  until: Date,
  bytesInField: string,
): Promise<WindowTotals> {
  const sumFields = bytesInField ? `edgeResponseBytes ${bytesInField}` : "edgeResponseBytes";
  const query = `query($zone: String!, $since: Time!, $until: Time!, $host: String!, $uploadPath: String!) {
    viewer { zones(filter: { zoneTag: $zone }) {
      total: httpRequestsAdaptiveGroups(limit: 1, filter: { datetime_geq: $since, datetime_leq: $until, clientRequestHTTPHost: $host }) {
        count
        sum { ${sumFields} }
      }
      errors: httpRequestsAdaptiveGroups(limit: 1000, filter: { datetime_geq: $since, datetime_leq: $until, clientRequestHTTPHost: $host, edgeResponseStatus_geq: 400 }) {
        count
        dimensions { edgeResponseStatus }
      }
      uploads: httpRequestsAdaptiveGroups(limit: 50, filter: { datetime_geq: $since, datetime_leq: $until, clientRequestHTTPHost: $host, clientRequestPath_like: $uploadPath }) {
        count
        dimensions { clientRequestPath }
      }
    } }
  }`;
  const reply = await graphql(token, query, {
    zone,
    since: since.toISOString(),
    until: until.toISOString(),
    host: APP_HOST,
    uploadPath: UPLOAD_PATH_PATTERN,
  });
  const message = graphqlError(reply);
  if (message) throw new Error(message);
  type Group = { count?: unknown; sum?: Record<string, unknown>; dimensions?: Record<string, unknown> };
  const zoneData = (
    reply.data as { viewer?: { zones?: { total?: Group[]; errors?: Group[]; uploads?: Group[] }[] } } | undefined
  )?.viewer?.zones?.[0];
  const total = zoneData?.total?.[0];
  const out: WindowTotals = {
    requests: Number(total?.count) || 0,
    bytesOut: Number(total?.sum?.edgeResponseBytes) || 0,
    bytesIn: bytesInField ? Number(total?.sum?.[bytesInField]) || 0 : 0,
    clientErrors: 0,
    serverErrors: 0,
    status499: 0,
    uploads: new Map(),
  };
  for (const group of zoneData?.errors ?? []) {
    const status = Number(group.dimensions?.edgeResponseStatus);
    const count = Number(group.count) || 0;
    if (status === 499) out.status499 += count;
    else if (status >= 500) out.serverErrors += count;
    else if (status >= 400) out.clientErrors += count;
  }
  for (const group of zoneData?.uploads ?? []) {
    const path = String(group.dimensions?.clientRequestPath ?? "");
    if (path) out.uploads.set(path, (out.uploads.get(path) ?? 0) + (Number(group.count) || 0));
  }
  return out;
}

export async function GET(req: Request): Promise<Response> {
  if (!isSameOriginGet(req)) {
    return Response.json({ error: "Chỉ mở từ màn intercom." }, { status: 403, headers: NO_STORE_HEADERS });
  }
  const rangeParam = new URL(req.url).searchParams.get("range") ?? "24h";
  if (rangeParam !== "24h" && rangeParam !== "7d") {
    return Response.json({ error: "Khoảng không hợp lệ" }, { status: 400, headers: NO_STORE_HEADERS });
  }
  const range: Range = rangeParam;

  const supa = staffServerClient(await cookies());
  const { data: auth } = await supa.auth.getUser();
  if (!auth?.user?.id) return Response.json({ error: "Chưa đăng nhập" }, { status: 401, headers: NO_STORE_HEADERS });
  const { data: canUse, error: gateError } = await supa.rpc("intercom_can_use", { p_project: null });
  if (gateError || canUse !== true) {
    return Response.json({ error: "Chỉ nhân viên được xem", reason: "permission" }, { status: 403, headers: NO_STORE_HEADERS });
  }

  const token = readEnv("CF_ANALYTICS_TOKEN");
  if (!token) return Response.json({ configured: false }, { headers: NO_STORE_HEADERS });
  const zone = readEnv("CF_ZONE_ID");
  if (!ZONE_TAG_PATTERN.test(zone)) {
    return Response.json({ configured: true, error: "Thiếu mã vùng Cloudflare trong cấu hình" }, { headers: NO_STORE_HEADERS });
  }

  try {
    const [bytesInField, retentionSeconds] = await Promise.all([
      findRequestBytesField(token).catch(() => ""),
      readRetentionSeconds(token, zone),
    ]);
    const now = Date.now();
    const end = now - UNTIL_LAG_MS;
    const retentionStart = retentionSeconds !== null ? now - retentionSeconds * 1000 : null;
    const windowCount = range === "24h" ? 1 : 7;
    const windows: { since: Date; until: Date }[] = [];
    for (let i = 0; i < windowCount; i += 1) {
      const until = end - i * DAY_MS;
      const since = until - WINDOW_MS;
      if (retentionStart !== null && since < retentionStart) break;
      windows.push({ since: new Date(since), until: new Date(until) });
    }
    const results = await Promise.all(windows.map((w) => queryWindow(token, zone, w.since, w.until, bytesInField)));
    const uploads = new Map<string, number>();
    let requests = 0;
    let bytesOut = 0;
    let bytesIn = 0;
    let clientErrors = 0;
    let serverErrors = 0;
    let status499 = 0;
    for (const r of results) {
      requests += r.requests;
      bytesOut += r.bytesOut;
      bytesIn += r.bytesIn;
      clientErrors += r.clientErrors;
      serverErrors += r.serverErrors;
      status499 += r.status499;
      for (const [path, count] of r.uploads) uploads.set(path, (uploads.get(path) ?? 0) + count);
    }
    return Response.json(
      {
        configured: true,
        range,
        retention_days: retentionSeconds !== null ? Math.floor(retentionSeconds / 86400) : null,
        days_covered: windows.length,
        requests,
        bytes_out: bytesOut,
        bytes_in: bytesInField ? bytesIn : null,
        client_errors: clientErrors,
        server_errors: serverErrors,
        status_499: status499,
        upload_paths: [...uploads.entries()]
          .map(([path, count]) => ({ path, requests: count }))
          .sort((a, b) => b.requests - a.requests),
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(LOG_TAG, "Cloudflare GraphQL failed", message);
    return Response.json({ configured: true, error: "Cloudflare chưa trả số liệu, thử lại sau." }, { headers: NO_STORE_HEADERS });
  }
}

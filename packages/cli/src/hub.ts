import { createHash, createHmac, randomBytes } from "node:crypto";

/** The hub's endpoints for the CLI (docs/44 in the Sitecommand repo). */

export type DeviceStart = { device_code: string; user_code: string; verification_uri: string; verification_uri_complete: string; expires_in: number; interval: number; hub_url: string };
export type DevicePoll = { status: "pending" | "denied" | "expired" | "unknown" | "slow_down" } | { status: "approved"; site_secret: string; site_id: string; base_path: string; site_url: string };
export type VerifyStep = { id: string; ok: boolean; label: string; detail: string; fix?: string };
export type VerifyReport = { ok: boolean; checked_at: string; steps: VerifyStep[] };

async function postJson<T>(url: string, body: unknown): Promise<{ status: number; data: T | null }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "user-agent": "sitecommand-cli" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  let data: T | null = null;
  try {
    data = (await res.json()) as T;
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

export async function startDevice(hub: string, input: { site_url: string; framework: string; app_name: string | null; base_path: string }): Promise<DeviceStart> {
  const { status, data } = await postJson<DeviceStart & { message?: string }>(`${hub}/api/connect/device`, input);
  if (status !== 200 || !data?.device_code) throw new Error((data as { message?: string } | null)?.message ?? `The hub answered ${status}.`);
  return data;
}

export async function pollDevice(hub: string, deviceCode: string): Promise<DevicePoll> {
  const { data } = await postJson<DevicePoll>(`${hub}/api/connect/device/poll`, { device_code: deviceCode });
  return data ?? { status: "unknown" };
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Ask the hub to run Verify against the deployed app; proves this machine holds the site's secret. */
export async function remoteVerify(hub: string, siteId: string, secret: string): Promise<{ status: number; report: VerifyReport | null }> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const proof = createHmac("sha256", secret).update(`verify\n${siteId}\n${timestamp}\n${sha256("")}`).digest("hex");
  const { status, data } = await postJson<VerifyReport>(`${hub}/api/node/verify`, { site_id: siteId, timestamp, proof });
  return { status, report: data && "steps" in data ? data : null };
}

/** Call the connector directly (for a local dev server): same signature the hub uses. */
export async function localInfo(baseUrl: string, secret: string): Promise<{ status: number; ok: boolean; body: string }> {
  const nonce = randomBytes(12).toString("hex");
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/info`);
  url.searchParams.set("sc_nonce", nonce);
  const ts = String(Math.floor(Date.now() / 1000));
  const toSign = [ts, "GET", `${url.pathname}${url.search}`, sha256("")].join("\n");
  const signature = createHmac("sha256", secret).update(toSign).digest("hex");
  try {
    const res = await fetch(url, { headers: { "x-sitecommand-timestamp": ts, "x-sitecommand-signature": signature }, signal: AbortSignal.timeout(10_000) });
    const body = await res.text();
    const expected = createHmac("sha256", secret).update(`${nonce}\n${sha256(body)}`).digest("hex");
    return { status: res.status, ok: res.ok && res.headers.get("x-sitecommand-response-signature") === expected, body };
  } catch (e) {
    return { status: 0, ok: false, body: e instanceof Error ? e.message : String(e) };
  }
}

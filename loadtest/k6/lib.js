// Shared helpers for the k6 tests. *.localhost hosts don't resolve under glibc (WSL), so
// requests go to 127.0.0.1 with the real Host header (presigned URLs sign the host).
import http from "k6/http";

export const BASE = __ENV.BASE_URL || "http://streamforge.localhost";
const EMAIL = __ENV.SEED_USER_EMAIL || "demo@streamforge.local";
const PASSWORD = __ENV.SEED_USER_PASSWORD || "demo-password";

/** Rewrites http://x.localhost/... to 127.0.0.1 and returns [url, hostHeader]. */
export function local(url) {
  const m = url.match(/^http:\/\/([^/]+\.localhost)(:\d+)?(\/.*)?$/);
  return m ? [`http://127.0.0.1${m[2] || ""}${m[3] || "/"}`, m[1]] : [url, null];
}

export function req(method, url, body, params = {}) {
  const [u, host] = local(url);
  const headers = Object.assign({}, params.headers, host ? { Host: host } : {});
  return http.request(method, u, body, Object.assign({}, params, { headers }));
}

/** Logs in once (setup) and returns the session cookie header value. */
export function login() {
  const res = req("POST", `${BASE}/api/auth/login`, JSON.stringify({ email: EMAIL, password: PASSWORD }), {
    headers: { "Content-Type": "application/json" },
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${res.body}`);
  const c = res.cookies.sf_session;
  if (!c || !c.length) throw new Error("no session cookie");
  return `sf_session=${c[0].value}`;
}

export const api = (method, path, cookie, body, tags) =>
  req(method, `${BASE}/api${path}`, body ? JSON.stringify(body) : null, {
    headers: Object.assign({ Cookie: cookie }, body ? { "Content-Type": "application/json" } : {}),
    tags,
  });

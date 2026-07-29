// --- AUTH HELPERS -------------------------------------------------------
// Same PBKDF2/HMAC approach as the browser's Web Crypto API (crypto.subtle) —
// Workers run the identical API, verified against this exact logic in-browser
// before it ever touched this file.

function b64(bytes) { return btoa(String.fromCharCode(...bytes)); }
function b64ToBytes(str) { return Uint8Array.from(atob(str), c => c.charCodeAt(0)); }
function b64url(bytes) { return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64urlToBytes(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return b64ToBytes(str);
}

const PBKDF2_ITERATIONS = 100000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

async function hashPassword(password, saltB64) {
  const enc = new TextEncoder();
  const salt = saltB64 ? b64ToBytes(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial, 256
  );
  return { salt: b64(salt), hash: b64(new Uint8Array(bits)) };
}
async function verifyPassword(password, saltB64, hashB64) {
  const check = await hashPassword(password, saltB64);
  return check.hash === hashB64;
}
async function signToken(payloadObj, secret) {
  const enc = new TextEncoder();
  const payload = b64url(enc.encode(JSON.stringify(payloadObj)));
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return `${payload}.${b64url(new Uint8Array(sig))}`;
}
async function verifyToken(token, secret) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  let valid;
  try { valid = await crypto.subtle.verify('HMAC', key, b64urlToBytes(sig), enc.encode(payload)); }
  catch { return null; }
  if (!valid) return null;
  let obj;
  try { obj = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload))); }
  catch { return null; }
  if (obj.exp && Date.now() > obj.exp) return null;
  return obj;
}

function json(obj, status, corsHeaders) {
  return new Response(JSON.stringify(obj), { status, headers: corsHeaders });
}

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Worker-Key, Authorization',
      'Content-Type': 'application/json',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // --- AUTH: one-time bootstrap ------------------------------------
    // Only ever succeeds once — refuses if either password already exists in KV.
    // No key/token needed to CALL it, but it can't do anything once configured,
    // so it's safe to leave deployed rather than needing to be removed after use.
    if (path === '/setup' && request.method === 'POST') {
      const existingAdmin = await env.AUTH_KV.get('pw:admin');
      const existingCompany = await env.AUTH_KV.get('pw:company');
      if (existingAdmin || existingCompany) {
        return json({ ok: false, msg: 'Already configured — use /change-password instead' }, 403, corsHeaders);
      }
      let body;
      try { body = await request.json(); }
      catch { return json({ ok: false, msg: 'Invalid JSON' }, 400, corsHeaders); }
      const { adminPassword, companyPassword } = body;
      if (!adminPassword || adminPassword.length < 4 || !companyPassword || companyPassword.length < 4) {
        return json({ ok: false, msg: 'Both passwords must be at least 4 characters' }, 400, corsHeaders);
      }
      const adminHash = await hashPassword(adminPassword);
      const companyHash = await hashPassword(companyPassword);
      await env.AUTH_KV.put('pw:admin', JSON.stringify(adminHash));
      await env.AUTH_KV.put('pw:company', JSON.stringify(companyHash));
      return json({ ok: true }, 200, corsHeaders);
    }

    // --- AUTH: login ----------------------------------------------------
    if (path === '/login' && request.method === 'POST') {
      let body;
      try { body = await request.json(); }
      catch { return json({ ok: false, msg: 'Invalid JSON' }, 400, corsHeaders); }
      const { role, password } = body;
      if (role !== 'admin' && role !== 'company') {
        return json({ ok: false, msg: 'Invalid role' }, 400, corsHeaders);
      }
      const stored = await env.AUTH_KV.get(`pw:${role}`);
      if (!stored) return json({ ok: false, msg: 'Not configured yet' }, 400, corsHeaders);
      const { salt, hash } = JSON.parse(stored);
      const valid = password && (await verifyPassword(password, salt, hash));
      if (!valid) return json({ ok: false, msg: 'Incorrect password' }, 401, corsHeaders);
      const token = await signToken({ role, exp: Date.now() + SESSION_TTL_MS }, env.SESSION_SECRET);
      return json({ ok: true, token, role }, 200, corsHeaders);
    }

    // --- AUTH: self-service change password ------------------------------
    // Whoever holds a valid token for a role can change that role's own password.
    if (path === '/change-password' && request.method === 'POST') {
      let body;
      try { body = await request.json(); }
      catch { return json({ ok: false, msg: 'Invalid JSON' }, 400, corsHeaders); }
      const { token, newPassword } = body;
      const claims = await verifyToken(token, env.SESSION_SECRET);
      if (!claims) return json({ ok: false, msg: 'Session expired — please log in again' }, 401, corsHeaders);
      if (!newPassword || newPassword.length < 4) {
        return json({ ok: false, msg: 'Password must be at least 4 characters' }, 400, corsHeaders);
      }
      const hashed = await hashPassword(newPassword);
      await env.AUTH_KV.put(`pw:${claims.role}`, JSON.stringify(hashed));
      return json({ ok: true }, 200, corsHeaders);
    }

    // --- AUTH: admin resets the company password --------------------------
    if (path === '/admin/reset-company-password' && request.method === 'POST') {
      let body;
      try { body = await request.json(); }
      catch { return json({ ok: false, msg: 'Invalid JSON' }, 400, corsHeaders); }
      const { token, newPassword } = body;
      const claims = await verifyToken(token, env.SESSION_SECRET);
      if (!claims || claims.role !== 'admin') return json({ ok: false, msg: 'Admin session required' }, 401, corsHeaders);
      if (!newPassword || newPassword.length < 4) {
        return json({ ok: false, msg: 'Password must be at least 4 characters' }, 400, corsHeaders);
      }
      const hashed = await hashPassword(newPassword);
      await env.AUTH_KV.put('pw:company', JSON.stringify(hashed));
      return json({ ok: true }, 200, corsHeaders);
    }

    // --- EXISTING JOB SYNC (unchanged) ------------------------------------
    const REPO  = 'heathchartier/lbi-calculator';
    const FILE  = 'jobs.json';
    const API   = `https://api.github.com/repos/${REPO}/contents/${FILE}`;
    const RAW   = `https://raw.githubusercontent.com/${REPO}/main/${FILE}`;
    const GH_HEADERS = {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'lbi-calculator-worker',
    };

    // GET — public, no auth needed
    if (request.method === 'GET') {
      const resp = await fetch(`${RAW}?_=${Date.now()}`, { cache: 'no-store' });
      if (!resp.ok) return new Response('[]', { headers: corsHeaders });
      const text = await resp.text();
      return new Response(text, { headers: corsHeaders });
    }

    // PUT — requires worker key
    if (request.method === 'PUT') {
      const key = request.headers.get('X-Worker-Key');
      if (!key || key !== env.WORKER_KEY) {
        return new Response(JSON.stringify({ ok: false, msg: 'Unauthorized' }), {
          status: 401, headers: corsHeaders,
        });
      }

      let jobs;
      try { jobs = await request.json(); }
      catch { return new Response(JSON.stringify({ ok: false, msg: 'Invalid JSON' }), { status: 400, headers: corsHeaders }); }

      const content = btoa(unescape(encodeURIComponent(JSON.stringify(jobs, null, 2))));

      async function tryPush(retries) {
        let sha;
        const getResp = await fetch(API, { headers: GH_HEADERS });
        if (getResp.ok) sha = (await getResp.json()).sha;
        else if (getResp.status === 401) return { ok: false, msg: 'GitHub token invalid' };
        else if (getResp.status !== 404) return { ok: false, msg: 'GitHub error ' + getResp.status };

        const body = { message: 'Update jobs', content };
        if (sha) body.sha = sha;

        const putResp = await fetch(API, { method: 'PUT', headers: GH_HEADERS, body: JSON.stringify(body) });
        if (putResp.ok) return { ok: true };
        if (putResp.status === 409 && retries > 0) return tryPush(retries - 1);
        if (putResp.status === 401) return { ok: false, msg: 'GitHub token invalid' };
        return { ok: false, msg: 'Push failed ' + putResp.status };
      }

      try {
        const result = await tryPush(1);
        return new Response(JSON.stringify(result), {
          status: result.ok ? 200 : 500, headers: corsHeaders,
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, msg: e.message }), { status: 500, headers: corsHeaders });
      }
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  },
};

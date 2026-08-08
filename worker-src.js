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

// --- PRICING STORAGE ------------------------------------------------------
// Real pricing (cost basis + margins) lives in PRICING_KV once seeded — nobody outside
// this Worker can read it. Falls back to the current public pricing.json if KV hasn't been
// seeded yet, so none of this breaks anything while it's still being tested: an unbound or
// empty PRICING_KV means "behave exactly like before," not "fail."
const PRICING_RAW_URL = 'https://raw.githubusercontent.com/heathchartier/lbi-calculator/main/pricing.json';
async function getPricing(env) {
  const stored = env.PRICING_KV && (await env.PRICING_KV.get('pricing'));
  if (stored) {
    try { return JSON.parse(stored); } catch { /* fall through to public file */ }
  }
  const resp = await fetch(`${PRICING_RAW_URL}?_=${Date.now()}`, { cache: 'no-store' });
  if (!resp.ok) return null;
  try { return await resp.json(); } catch { return null; }
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
    // Employee accounts are a third path alongside the shared admin/company logins: a
    // username identifies WHICH employee, looked up as its own KV entry (pw:employee:<username>)
    // rather than sharing a single company-wide password. Token claims carry `username` (and
    // `displayName`, purely for greeting text) only when role is 'employee'.
    if (path === '/login' && request.method === 'POST') {
      let body;
      try { body = await request.json(); }
      catch { return json({ ok: false, msg: 'Invalid JSON' }, 400, corsHeaders); }
      const { role, password } = body;

      if (role === 'employee') {
        const username = (body.username || '').trim().toLowerCase();
        if (!username) return json({ ok: false, msg: 'Username required' }, 400, corsHeaders);
        const stored = await env.AUTH_KV.get(`pw:employee:${username}`);
        if (!stored) return json({ ok: false, msg: 'Incorrect username or password' }, 401, corsHeaders);
        const { salt, hash, displayName } = JSON.parse(stored);
        const valid = password && (await verifyPassword(password, salt, hash));
        if (!valid) return json({ ok: false, msg: 'Incorrect username or password' }, 401, corsHeaders);
        const token = await signToken({ role: 'employee', username, displayName, exp: Date.now() + SESSION_TTL_MS }, env.SESSION_SECRET);
        return json({ ok: true, token, role: 'employee', displayName }, 200, corsHeaders);
      }

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
    // Whoever holds a valid token for a role can change that role's own password. Employee
    // tokens carry a username, so their KV key is pw:employee:<username>, not pw:employee.
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
      const kvKey = claims.role === 'employee' ? `pw:employee:${claims.username}` : `pw:${claims.role}`;
      const existing = claims.role === 'employee' ? JSON.parse(await env.AUTH_KV.get(kvKey) || '{}') : null;
      const displayName = existing?.displayName;
      await env.AUTH_KV.put(kvKey, JSON.stringify({ ...hashed, ...(displayName ? { displayName } : {}) }),
        claims.role === 'employee' ? { metadata: { displayName } } : undefined);
      return json({ ok: true }, 200, corsHeaders);
    }

    // --- ADMIN: employee account management --------------------------------
    // Employee usernames/display names are non-sensitive (visible to admin only anyway) —
    // password hashes never leave the Worker. KV `list()` returns each key's metadata without
    // a separate GET per employee, so the listing endpoint stays cheap regardless of headcount.
    if (path === '/admin/employees' && request.method === 'GET') {
      const authHeader = request.headers.get('Authorization') || '';
      const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
      const claims = await verifyToken(bearerToken, env.SESSION_SECRET);
      if (!claims || claims.role !== 'admin') return json({ ok: false, msg: 'Admin session required' }, 401, corsHeaders);
      const list = await env.AUTH_KV.list({ prefix: 'pw:employee:' });
      const employees = list.keys.map(k => ({
        username: k.name.slice('pw:employee:'.length),
        displayName: k.metadata?.displayName || '',
      }));
      return json({ ok: true, employees }, 200, corsHeaders);
    }
    if (path === '/admin/employees' && request.method === 'POST') {
      let body;
      try { body = await request.json(); }
      catch { return json({ ok: false, msg: 'Invalid JSON' }, 400, corsHeaders); }
      const claims = await verifyToken(body.token, env.SESSION_SECRET);
      if (!claims || claims.role !== 'admin') return json({ ok: false, msg: 'Admin session required' }, 401, corsHeaders);
      const username = (body.username || '').trim().toLowerCase();
      const displayName = (body.displayName || '').trim() || username;
      const password = body.password || '';
      if (!/^[a-z0-9._-]{2,32}$/.test(username)) {
        return json({ ok: false, msg: 'Username must be 2-32 characters: letters, numbers, dot, dash, underscore' }, 400, corsHeaders);
      }
      if (password.length < 4) return json({ ok: false, msg: 'Password must be at least 4 characters' }, 400, corsHeaders);
      const kvKey = `pw:employee:${username}`;
      if (await env.AUTH_KV.get(kvKey)) return json({ ok: false, msg: 'That username already exists' }, 409, corsHeaders);
      const hashed = await hashPassword(password);
      await env.AUTH_KV.put(kvKey, JSON.stringify({ ...hashed, displayName }), { metadata: { displayName } });
      return json({ ok: true }, 200, corsHeaders);
    }
    if (path === '/admin/employees/remove' && request.method === 'POST') {
      let body;
      try { body = await request.json(); }
      catch { return json({ ok: false, msg: 'Invalid JSON' }, 400, corsHeaders); }
      const claims = await verifyToken(body.token, env.SESSION_SECRET);
      if (!claims || claims.role !== 'admin') return json({ ok: false, msg: 'Admin session required' }, 401, corsHeaders);
      const username = (body.username || '').trim().toLowerCase();
      if (!username) return json({ ok: false, msg: 'Username required' }, 400, corsHeaders);
      await env.AUTH_KV.delete(`pw:employee:${username}`);
      return json({ ok: true }, 200, corsHeaders);
    }
    if (path === '/admin/employees/reset-password' && request.method === 'POST') {
      let body;
      try { body = await request.json(); }
      catch { return json({ ok: false, msg: 'Invalid JSON' }, 400, corsHeaders); }
      const claims = await verifyToken(body.token, env.SESSION_SECRET);
      if (!claims || claims.role !== 'admin') return json({ ok: false, msg: 'Admin session required' }, 401, corsHeaders);
      const username = (body.username || '').trim().toLowerCase();
      const newPassword = body.newPassword || '';
      if (!username) return json({ ok: false, msg: 'Username required' }, 400, corsHeaders);
      if (newPassword.length < 4) return json({ ok: false, msg: 'Password must be at least 4 characters' }, 400, corsHeaders);
      const kvKey = `pw:employee:${username}`;
      const existing = JSON.parse(await env.AUTH_KV.get(kvKey) || 'null');
      if (!existing) return json({ ok: false, msg: 'No such employee' }, 404, corsHeaders);
      const hashed = await hashPassword(newPassword);
      await env.AUTH_KV.put(kvKey, JSON.stringify({ ...hashed, displayName: existing.displayName }), { metadata: { displayName: existing.displayName } });
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

    // --- PRICING: server-side job total, for the company role -------------
    // The browser sends job configuration (species, dimensions, quantities) — never
    // pricing data — and gets back only computed dollar totals/labels. Real pricing
    // (cost basis + margins) is fetched and held here, never sent to the client. Requires
    // ANY valid session (admin or company); admin doesn't normally call this (it computes
    // locally so it can edit pricing), but there's no extra exposure in allowing it.
    if (path === '/pricing/calculate' && request.method === 'POST') {
      let body;
      try { body = await request.json(); }
      catch { return json({ ok: false, msg: 'Invalid JSON' }, 400, corsHeaders); }

      // Two ways in: a browser session (admin/company login), or a partner API key for a
      // machine caller like APS's system — a static secret, not a KV-stored hashed password,
      // since there's no human typing it in. Either is sufficient; neither is required beyond
      // the other. env.PARTNER_API_KEY unset means the partner path is simply never available.
      const partnerKey = request.headers.get('X-Partner-Key');
      const isPartner = !!(partnerKey && env.PARTNER_API_KEY && partnerKey === env.PARTNER_API_KEY);
      if (!isPartner) {
        const claims = await verifyToken(body.token, env.SESSION_SECRET);
        if (!claims) return json({ ok: false, msg: 'Session expired — please log in again' }, 401, corsHeaders);
      }

      const pricing = await getPricing(env);
      if (!pricing) return json({ ok: false, msg: 'Could not load pricing' }, 500, corsHeaders);

      const engine = createCalcEngine(pricing);
      const data = engine.computeJobTotals({
        veneerConfigs: Array.isArray(body.veneerConfigs) ? body.veneerConfigs : [],
        lumberConfigs: Array.isArray(body.lumberConfigs) ? body.lumberConfigs : [],
        laminationConfigs: Array.isArray(body.laminationConfigs) ? body.laminationConfigs : [],
        productCart: (body.productCart && typeof body.productCart === 'object') ? body.productCart : {},
      });
      return json({ ok: true, data }, 200, corsHeaders);
    }

    // --- PRICING: cost-free option lists (species/size/etc names) ---------
    // Public, no auth — deliberately contains no dollar amounts of any kind, so there's
    // nothing here for a login gate to protect. Lets a UI (yours or a partner's) build
    // species/thickness/size dropdowns without ever touching real pricing data.
    if (path === '/pricing/options' && request.method === 'GET') {
      const pricing = await getPricing(env);
      if (!pricing) return json({ ok: false, msg: 'Could not load options' }, 500, corsHeaders);

      // Everything here is either a name/label, a structural flag (resaw, netSize — needed for
      // correct UI behavior, not a dollar figure), or a deliberately-computed sell price
      // (standardProducts) — never a raw cost or margin.
      const options = {
        veneerSpecies: Object.keys(pricing.veneerSpecies || {}),
        lumberSpecies: Object.entries(pricing.lumberSpecies || {}).map(([name, p]) => ({ name, resaw: !!p.resaw })),
        veneerCores: (pricing.veneerCores || []).map(c => ({ key: c.key, label: c.label })),
        laminationFaces: Object.keys(pricing.laminationFaces || {}),
        laminationCores: Object.entries(pricing.laminationCores || {}).map(([name, c]) => ({ name, netSize: !!c.netSize })),
        thicknessOptions: ['1/4"', '1/2"', '3/4"', '1"'],
        standardProducts: (pricing.standardProducts || []).map(p => ({
          id: p.id, name: p.name, type: p.type, category: p.category,
          sellPrice: (p.markup||0) >= 100 ? (p.cost||0) : (p.cost||0) / (1 - (p.markup||0)/100),
        })),
        productCategories: (pricing.productCategories || []).map(c => ({ id: c.id, name: c.name })),
      };
      return json({ ok: true, options }, 200, corsHeaders);
    }

    // --- PRICING: admin read/write of the real pricing data ---------------
    // The new home for what fetchCloudPricing()/pushCloudPricing() in app.js currently do
    // via the public pricing.json file and a GitHub token sitting in the admin's browser.
    // Both require an admin session. GET returns the full real pricing object — same shape
    // as pricing.json today — falling back to the public file until PRICING_KV is seeded
    // (first successful PUT seeds it). PUT is the ONLY way real pricing data changes from
    // here on; nothing here touches the public pricing.json file or the GitHub repo at all.
    if (path === '/admin/pricing' && request.method === 'GET') {
      const authHeader = request.headers.get('Authorization') || '';
      const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
      const claims = await verifyToken(bearerToken, env.SESSION_SECRET);
      if (!claims || claims.role !== 'admin') return json({ ok: false, msg: 'Admin session required' }, 401, corsHeaders);
      const pricing = await getPricing(env);
      if (!pricing) return json({ ok: false, msg: 'Could not load pricing' }, 500, corsHeaders);
      return json({ ok: true, pricing }, 200, corsHeaders);
    }
    if (path === '/admin/pricing' && request.method === 'PUT') {
      let body;
      try { body = await request.json(); }
      catch { return json({ ok: false, msg: 'Invalid JSON' }, 400, corsHeaders); }
      const claims = await verifyToken(body.token, env.SESSION_SECRET);
      if (!claims || claims.role !== 'admin') return json({ ok: false, msg: 'Admin session required' }, 401, corsHeaders);
      const pricingData = body.pricing;
      if (!pricingData || typeof pricingData !== 'object' || !pricingData.veneerSpecies || !pricingData.services) {
        return json({ ok: false, msg: 'Pricing data missing required fields' }, 400, corsHeaders);
      }
      if (!env.PRICING_KV) return json({ ok: false, msg: 'PRICING_KV not bound on this Worker yet' }, 500, corsHeaders);
      await env.PRICING_KV.put('pricing', JSON.stringify(pricingData));
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

    // --- PARTNER: job upsert (APS quote sync) ------------------------------
    // Adds or updates exactly ONE job, matched by sourceId — never touches any other job,
    // never replaces the whole list. This is the safety property Ryan's write-up promised
    // ("fetch-modify-write, never truncate") — enforced here server-side, on its own scoped
    // key, rather than relied on as a promise about his client code. customer/date/notes are
    // set here, never trusted from the caller, so this can only ever create a properly-tagged
    // LBI-sourced job entry, nothing else.
    if (path === '/jobs/upsert' && request.method === 'POST') {
      const partnerKey = request.headers.get('X-Partner-Key');
      if (!partnerKey || !env.PARTNER_JOBS_KEY || partnerKey !== env.PARTNER_JOBS_KEY) {
        return json({ ok: false, msg: 'Unauthorized' }, 401, corsHeaders);
      }
      let body;
      try { body = await request.json(); }
      catch { return json({ ok: false, msg: 'Invalid JSON' }, 400, corsHeaders); }

      const sourceId = (body.sourceId || '').toString().trim();
      if (!sourceId) return json({ ok: false, msg: 'sourceId is required' }, 400, corsHeaders);

      const newEntry = {
        sourceId,
        name: (body.name || 'APS Quote').toString(),
        customer: 'LBI', // always — never trusts the caller for this field
        po: (body.po || '').toString(),
        date: new Date().toISOString().split('T')[0],
        notes: 'Synced from APS quoting tool' + (body.notes ? ` — ${body.notes}` : ''),
        veneerConfigs: Array.isArray(body.veneerConfigs) ? body.veneerConfigs : [],
        lumberConfigs: Array.isArray(body.lumberConfigs) ? body.lumberConfigs : [],
        laminationConfigs: Array.isArray(body.laminationConfigs) ? body.laminationConfigs : [],
        productCart: (body.productCart && typeof body.productCart === 'object') ? body.productCart : {},
        savedAt: new Date().toISOString(),
      };

      async function upsertJob(retries) {
        // Read the CURRENT job list from the same GitHub Contents API call that gives us the
        // sha, not from raw.githubusercontent.com — that raw endpoint sits behind its own CDN
        // cache with an unpredictable TTL, independent of what's actually committed. Reading
        // jobs from there for a merge is a real bug: a write immediately followed by another
        // write can read stale (pre-write) data for the merge, silently lose the first write
        // when the second is pushed. The Contents API always reflects the actual latest commit.
        let jobs = [], sha;
        const getResp = await fetch(API, { headers: GH_HEADERS });
        if (getResp.ok) {
          const d = await getResp.json();
          sha = d.sha;
          try { jobs = JSON.parse(decodeURIComponent(escape(atob(d.content.replace(/\s/g, ''))))); }
          catch { jobs = []; }
        } else if (getResp.status === 401) {
          return { ok: false, msg: 'GitHub token invalid' };
        } else if (getResp.status !== 404) {
          return { ok: false, msg: 'GitHub error ' + getResp.status };
        }
        if (!Array.isArray(jobs)) jobs = [];

        const idx = jobs.findIndex(j => j.sourceId === sourceId);
        if (idx >= 0) {
          newEntry.id = jobs[idx].id; // preserve identity across updates
          jobs[idx] = newEntry;
        } else {
          newEntry.id = Date.now();
          jobs.push(newEntry);
        }

        const content = btoa(unescape(encodeURIComponent(JSON.stringify(jobs, null, 2))));
        const putBody = { message: 'Upsert job from APS', content };
        if (sha) putBody.sha = sha;

        const putResp = await fetch(API, { method: 'PUT', headers: GH_HEADERS, body: JSON.stringify(putBody) });
        if (putResp.ok) return { ok: true, id: newEntry.id };
        if (putResp.status === 409 && retries > 0) return upsertJob(retries - 1);
        if (putResp.status === 401) return { ok: false, msg: 'GitHub token invalid' };
        return { ok: false, msg: 'Push failed ' + putResp.status };
      }

      try {
        const result = await upsertJob(2);
        return json(result, result.ok ? 200 : 500, corsHeaders);
      } catch (e) {
        return json({ ok: false, msg: e.message }, 500, corsHeaders);
      }
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  },
};

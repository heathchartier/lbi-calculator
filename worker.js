export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Worker-Key',
      'Content-Type': 'application/json',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

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

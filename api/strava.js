// Singles Planner — Strava connection (Vercel serverless function).
//
// The Strava API app's Client ID and Client Secret live in Vercel environment
// variables (STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET) so the secret never ships
// to the browser. This function only:
//   • starts the Strava login           GET  /api/strava?action=connect
//   • finishes it (code → tokens)       GET  /api/strava?action=callback
//   • refreshes an expired token        POST /api/strava?action=refresh   { refresh_token }
//   • reads activities (read-only)      GET  /api/strava?action=activities&after=&page=  (Bearer token)
//   • disconnects                       POST /api/strava?action=deauthorize (Bearer token)
//   • reports whether keys are set      GET  /api/strava?action=status
// Tokens are kept by the app in the user's own browser storage; nothing is stored here.

import crypto from 'node:crypto';

const CID = (process.env.STRAVA_CLIENT_ID || '').trim();
const CSEC = (process.env.STRAVA_CLIENT_SECRET || '').trim();
const STORAGE_KEY = 'ns-planner:stravaAuth'; // must match src/storage.js PREFIX + 'stravaAuth'

function origin(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `${proto}://${host}`;
}

function sendJSON(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function redirect(res, location) {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

// Stateless anti-forgery "state": timestamp signed with the client secret.
// (A cookie wouldn't work: on iPhone, the home-screen app and the browser that
// shows Strava's login page don't share cookies.)
function signState(ts) {
  return crypto.createHmac('sha256', CSEC).update(`singles:${ts}`).digest('hex').slice(0, 32);
}
function makeState() {
  const ts = Date.now().toString(36);
  return `${ts}.${signState(ts)}`;
}
function stateIsValid(state) {
  const [ts, sig] = String(state || '').split('.');
  if (!ts || !sig) return false;
  const expected = signState(ts);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  const age = Date.now() - parseInt(ts, 36);
  return age >= 0 && age < 60 * 60 * 1000; // 1 hour
}

async function tokenRequest(params) {
  const r = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CID, client_secret: CSEC, ...params }).toString(),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data.message || `Strava token error ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return data;
}

async function readJSONBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

function bearer(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+([A-Za-z0-9._-]+)$/);
  return m ? m[1] : null;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Page shown after Strava sends the user back. It saves the connection for this
// browser and also shows a one-time "connection code" for the home-screen app,
// which on iPhone keeps its own separate storage.
function callbackPage({ ok, title, message, auth }) {
  const payload = auth
    ? Buffer.from(JSON.stringify(auth)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Strava · Singles Planner</title>
<style>
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f8fafc;color:#0f172a}
  .card{max-width:440px;margin:40px auto;background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:22px}
  h1{font-size:18px;margin:0 0 6px} p{font-size:14px;line-height:1.5;color:#334155;margin:8px 0}
  .ok{color:#047857} .bad{color:#b91c1c}
  textarea{width:100%;box-sizing:border-box;font:12px ui-monospace,Menlo,monospace;height:84px;border:1px solid #cbd5e1;border-radius:8px;padding:8px;color:#334155}
  button,a.btn{display:block;width:100%;box-sizing:border-box;text-align:center;margin-top:10px;padding:11px;border-radius:9px;font-size:14px;font-weight:600;border:0;text-decoration:none;cursor:pointer}
  .primary{background:#0f172a;color:#fff} .secondary{background:#f1f5f9;color:#0f172a}
  .hint{font-size:12px;color:#64748b}
</style></head><body><div class="card">
<h1 class="${ok ? 'ok' : 'bad'}">${escapeHTML(title)}</h1>
<p>${escapeHTML(message)}</p>
${auth ? `
<p><strong>Using Singles Planner from your iPhone home screen?</strong> It keeps separate storage from this browser, so copy this code, then open the app and paste it in <em>Setup → Strava → Paste connection code</em>.</p>
<textarea id="code" readonly>${payload}</textarea>
<button class="primary" id="copy">Copy connection code</button>
<a class="btn secondary" href="/">Open Singles Planner</a>
<p class="hint">The code lets the app read your Strava activities. Keep it to yourself.</p>
<script>
  try { localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.stringify(${JSON.stringify(auth).replace(/</g, '\\u003c')})); } catch (e) {}
  document.getElementById('copy').onclick = async function () {
    var t = document.getElementById('code');
    try { await navigator.clipboard.writeText(t.value); this.textContent = 'Copied ✓'; }
    catch (e) { t.select(); document.execCommand('copy'); this.textContent = 'Copied ✓'; }
  };
</script>` : `<a class="btn secondary" href="/">Back to Singles Planner</a>`}
</div></body></html>`;
}

export default async function handler(req, res) {
  const url = new URL(req.url, origin(req));
  const action = url.searchParams.get('action') || 'status';

  try {
    if (action === 'status') {
      return sendJSON(res, 200, { configured: !!(CID && CSEC), clientId: CID || null, callbackDomain: url.hostname });
    }

    if (!CID || !CSEC) {
      if (action === 'callback' || action === 'connect') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end(callbackPage({ ok: false, title: 'Strava keys not set yet', message: 'Add STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET to this Vercel project, redeploy, and try again.' }));
      }
      return sendJSON(res, 503, { error: 'Strava keys are not configured on the server.' });
    }

    if (action === 'connect') {
      const q = new URLSearchParams({
        client_id: CID,
        redirect_uri: `${origin(req)}/api/strava?action=callback`,
        response_type: 'code',
        approval_prompt: 'auto',
        scope: 'read,activity:read_all',
        state: makeState(),
      });
      return redirect(res, `https://www.strava.com/oauth/authorize?${q}`);
    }

    if (action === 'callback') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      const err = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (err || !code) {
        return res.end(callbackPage({ ok: false, title: 'Strava not connected', message: 'You cancelled on Strava, so nothing was connected. You can try again from Setup.' }));
      }
      if (!stateIsValid(url.searchParams.get('state'))) {
        return res.end(callbackPage({ ok: false, title: 'Link expired', message: 'That sign-in link expired or was not started from Singles Planner. Start again from Setup → Strava.' }));
      }
      const scope = url.searchParams.get('scope') || '';
      if (!/activity:read/.test(scope)) {
        return res.end(callbackPage({ ok: false, title: 'Permission needed', message: 'Strava was connected without permission to view activities. Try again and leave "View data about your activities" checked.' }));
      }
      const d = await tokenRequest({ code, grant_type: 'authorization_code' });
      const a = d.athlete || {};
      const auth = {
        accessToken: d.access_token,
        refreshToken: d.refresh_token,
        expiresAt: d.expires_at,
        athlete: { id: a.id, firstname: a.firstname || '', lastname: a.lastname || '' },
        connectedAt: new Date().toISOString(),
      };
      const name = [a.firstname, a.lastname].filter(Boolean).join(' ') || 'your account';
      return res.end(callbackPage({ ok: true, title: 'Strava connected ✓', message: `Connected as ${name}. Your runs will now import into Singles Planner automatically.`, auth }));
    }

    if (action === 'refresh') {
      if (req.method !== 'POST') return sendJSON(res, 405, { error: 'POST only' });
      const b = await readJSONBody(req);
      const rt = String(b.refresh_token || '');
      if (!/^[A-Za-z0-9]+$/.test(rt)) return sendJSON(res, 400, { error: 'Missing refresh token' });
      const d = await tokenRequest({ refresh_token: rt, grant_type: 'refresh_token' });
      return sendJSON(res, 200, { accessToken: d.access_token, refreshToken: d.refresh_token, expiresAt: d.expires_at });
    }

    if (action === 'activities') {
      const token = bearer(req);
      if (!token) return sendJSON(res, 401, { error: 'Not connected' });
      const q = new URLSearchParams({ per_page: '100', page: String(Math.max(1, Math.min(20, parseInt(url.searchParams.get('page') || '1', 10) || 1))) });
      const after = parseInt(url.searchParams.get('after') || '', 10);
      if (after > 0) q.set('after', String(after));
      const r = await fetch(`https://www.strava.com/api/v3/athlete/activities?${q}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return sendJSON(res, r.status, { error: data.message || `Strava error ${r.status}` });
      // Return only the fields the app uses.
      const slim = (Array.isArray(data) ? data : []).map(x => ({
        id: x.id,
        name: x.name,
        sport_type: x.sport_type || x.type,
        start_date: x.start_date,
        start_date_local: x.start_date_local,
        distance: x.distance,
        moving_time: x.moving_time,
        elapsed_time: x.elapsed_time,
        average_heartrate: x.average_heartrate ?? null,
        trainer: !!x.trainer,
      }));
      return sendJSON(res, 200, slim);
    }

    if (action === 'deauthorize') {
      if (req.method !== 'POST') return sendJSON(res, 405, { error: 'POST only' });
      const token = bearer(req);
      if (token) {
        await fetch('https://www.strava.com/oauth/deauthorize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ access_token: token }).toString(),
        }).catch(() => {});
      }
      return sendJSON(res, 200, { ok: true });
    }

    return sendJSON(res, 400, { error: 'Unknown action' });
  } catch (e) {
    if (action === 'callback') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(callbackPage({ ok: false, title: 'Could not connect', message: `Strava said: ${e.message}. Try again from Setup → Strava.` }));
    }
    return sendJSON(res, e.status && e.status < 500 ? e.status : 502, { error: e.message || 'Strava request failed' });
  }
}

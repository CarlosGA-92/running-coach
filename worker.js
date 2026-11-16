/**
 * Puente mínimo entre tu web y Strava (Cloudflare Worker, plan gratuito).
 * Existe solo porque la «clave secreta» de Strava no puede ir en la web.
 *
 * Variables que debes crear en el Worker (Settings → Variables):
 *   STRAVA_CLIENT_ID      (texto)   ID de tu aplicación de Strava
 *   STRAVA_CLIENT_SECRET  (secreto) Client Secret de tu aplicación de Strava
 *   APP_ORIGIN            (texto)   Origen de tu web, p. ej. https://tunombre.github.io  (sin barra final ni ruta)
 *
 * Rutas:
 *   GET  /auth?return=URL   → lleva a Strava para autorizar (solo lectura de actividades). return=manual → muestra un código para pegar
 *   GET  /callback          → Strava vuelve aquí; se canjea el código y se devuelve a tu web con los tokens en la parte #
 *   POST /refresh           → renueva el token {refresh_token}
 *   GET  /api/...           → reenvía a https://www.strava.com/api/v3/... con tu token (solo rutas de lectura)
 * No guarda nada. Solo responde a tu web (CORS restringido a APP_ORIGIN).
 */
const b64url = s => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = {
      'Access-Control-Allow-Origin': env.APP_ORIGIN,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Vary': 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (url.pathname === '/auth') {
      const ret = url.searchParams.get('return') || '';
      if (ret !== 'manual') {   // «manual» = mostrar un código para pegar en la app
        let origin; try { origin = new URL(ret).origin; } catch (e) { return new Response('return no válido', { status: 400 }); }
        if (origin !== env.APP_ORIGIN) return new Response('Origen no permitido', { status: 403 });
      }
      const q = new URLSearchParams({
        client_id: env.STRAVA_CLIENT_ID, response_type: 'code', approval_prompt: 'auto',
        scope: 'read,activity:read_all', redirect_uri: url.origin + '/callback', state: ret,
      });
      return Response.redirect('https://www.strava.com/oauth/authorize?' + q, 302);
    }

    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code'), ret = url.searchParams.get('state') || '';
      const manual = ret === 'manual';
      if (!manual) {
        let origin; try { origin = new URL(ret).origin; } catch (e) { return new Response('state no válido', { status: 400 }); }
        if (origin !== env.APP_ORIGIN) return new Response('Origen no permitido', { status: 403 });
      }
      if (!code) return manual ? new Response('Autorización cancelada. Puedes cerrar esta pestaña.', { status: 200 }) : Response.redirect(ret, 302);   // el usuario canceló
      const r = await fetch('https://www.strava.com/oauth/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: env.STRAVA_CLIENT_ID, client_secret: env.STRAVA_CLIENT_SECRET, code, grant_type: 'authorization_code' }),
      });
      if (!r.ok) return new Response('Strava rechazó el código (' + r.status + ')', { status: 502 });
      const t = await r.json();
      const pack = b64url(JSON.stringify({ access_token: t.access_token, refresh_token: t.refresh_token, expires_at: t.expires_at }));
      if (manual) {
        const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Código de Strava</title>
<body style="font:16px -apple-system,sans-serif;padding:20px;max-width:560px;margin:auto">
<h2>Strava autorizado ✔</h2><p>Copia este código, vuelve a la app y pégalo en Ajustes → Strava. Es privado: no lo compartas.</p>
<textarea id="c" readonly style="width:100%;height:150px;font-size:14px">${pack}</textarea>
<p><button style="font-size:18px;padding:10px 18px" onclick="c.select();c.setSelectionRange(0,99999);navigator.clipboard&&navigator.clipboard.writeText(c.value);this.textContent='Copiado ✔'">Copiar código</button></p></body>`;
        return new Response(page, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
      }
      return Response.redirect(ret + '#strava=' + pack, 302);
    }

    if (url.pathname === '/refresh' && req.method === 'POST') {
      let body; try { body = await req.json(); } catch (e) { return json({ error: 'json' }, 400); }
      const r = await fetch('https://www.strava.com/oauth/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: env.STRAVA_CLIENT_ID, client_secret: env.STRAVA_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: String(body.refresh_token || '') }),
      });
      if (!r.ok) return json({ error: 'refresh' }, r.status);
      const t = await r.json();
      return json({ access_token: t.access_token, refresh_token: t.refresh_token, expires_at: t.expires_at });
    }

    if (url.pathname.startsWith('/api/') && req.method === 'GET') {
      const path = url.pathname.slice(4);
      if (!/^\/(athlete\/activities|activities\/\d+)$/.test(path)) return json({ error: 'ruta no permitida' }, 403);
      const r = await fetch('https://www.strava.com/api/v3' + path + url.search, { headers: { Authorization: req.headers.get('Authorization') || '' } });
      return new Response(r.body, { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    return new Response('Running Coach AI · puente de Strava. Nada que ver aquí.', { status: 200 });
  },
};

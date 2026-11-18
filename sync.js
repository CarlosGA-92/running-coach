/* Running Coach V8.1: optional shared profile/calendar in Cloudflare D1.
   Strava access/refresh tokens and conversations NEVER leave this device.
   No silent first migration; Cloud revisions protect against stale writes. */
(function () {
  'use strict';
  const app = window.__rca;
  if (!app) return;
  const META_KEY = 'rca_cloud_v81';
  const sharedKeys = ['v','profile','goal','goals','weights','workouts','extras','unavailable','runs','notes','weeklyDecisions','intervals'];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const clone = o => JSON.parse(JSON.stringify(o));
  const get = () => app.getSharedState();
  const hash = () => JSON.stringify(get());
  let meta;
  try { meta = JSON.parse(localStorage.getItem(META_KEY)) || {}; } catch (_) { meta={}; }
  meta = {linked:false,revision:0,ack:'',...meta};
  let status = meta.linked ? 'loading' : 'checking', message = '';
  let remote = null, importing = null, busy = false, silent = false, timer = null;
  let conflictBackups = { local:false, cloud:false, cloudRevision:0 };
  function persist() { try { localStorage.setItem(META_KEY,JSON.stringify(meta)); } catch (_) {} }
  function refresh() { app.render(); }
  const isDirty = () => !!meta.linked && meta.ack !== hash();
  function toShared(s) {
    if (!s || s.v !== 1 || !s.profile || !s.goal ||
        !Array.isArray(s.runs) || !Array.isArray(s.workouts)) throw new Error('Esta copia no tiene el formato de Running Coach.');
    const o={};
    for (const k of sharedKeys) {
      if (k==='v') o[k]=1;
      else if (s[k] != null) o[k]=clone(s[k]);
    }
    o.goals=Array.isArray(o.goals)?o.goals:[clone(o.goal)];
    o.weights=Array.isArray(o.weights)?o.weights:[];
    o.extras=Array.isArray(o.extras)?o.extras:[];
    o.unavailable=Array.isArray(o.unavailable)?o.unavailable:[];
    o.notes=Array.isArray(o.notes)?o.notes:[];
    o.weeklyDecisions=o.weeklyDecisions||{};
    o.intervals=o.intervals||{sent:{}};
    o.intervals.sent=o.intervals.sent||{};
    return o;
  }
  function merge(aRaw,bRaw) {
    // a is the user's selected source of truth for future plans/profile.
    const a=toShared(aRaw), b=toShared(bRaw), out=clone(a);
    const report={runsAdded:0, runsCombined:0, completedAdded:0, manualAdded:0,
      weightsAdded:0, weightsConflicted:0, otherActivitiesAdded:0, plansIgnored:0};
    const idMap=new Map();
    const matchedRun=r=>out.runs.find(x=>
      (r.stravaId && x.stravaId && String(r.stravaId)===String(x.stravaId)) ||
      (r.id && x.id===r.id) ||
      (r.start && x.start && Math.abs(Date.parse(r.start)-Date.parse(x.start))<120000 &&
        r.distanceM>0 && Math.abs((x.distanceM||0)-r.distanceM)/r.distanceM<0.05));
    for (const r of b.runs) {
      const found=matchedRun(r);
      if (found) {
        if (r.id) idMap.set(r.id,found.id);
        if (!found.feeling && r.feeling) found.feeling=clone(r.feeling);
        if (!found.evaluation && r.evaluation) found.evaluation=clone(r.evaluation);
        if ((!found.splits || found.splits.length < (r.splits||[]).length) && r.splits) found.splits=clone(r.splits);
        report.runsCombined++;
      } else {
        out.runs.push(clone(r));
        if (r.id) idMap.set(r.id,r.id);
        report.runsAdded++;
      }
    }
    const keyOfRun = r => r.stravaId ? 'strava:'+String(r.stravaId) : 'manual:'+String(r.id);
    // Keep primary's complete and planned calendar; only bring non-duplicate
    // historical completions and user-created future sessions from secondary.
    for (const w of b.workouts) {
      if (out.workouts.some(x=>x.id===w.id)) continue;
      const copy=clone(w);
      if (copy.runId) copy.runId=idMap.get(copy.runId)||copy.runId;
      if (w.status==='completed') {
        if (out.workouts.some(x=>x.status==='completed' &&
            ((x.runId && copy.runId && x.runId===copy.runId) ||
            (x.date===w.date && x.kind===w.kind && x.title===w.title)))) continue;
        // A real run replaces planned entries on the same date, not the other way around.
        out.workouts=out.workouts.filter(x=>!(x.status==='planned' && x.date===w.date && x.kind!=='carreraObjetivo'));
        out.workouts.push(copy); report.completedAdded++;
      } else if (w.status==='planned' && w.manual &&
          !out.workouts.some(x=>x.date===w.date && x.status==='planned')) {
        out.workouts.push(copy); report.manualAdded++;
      } else if (w.status==='planned') report.plansIgnored++;
    }
    // If the secondary source contains a run on a day where the primary still
    // shows a pending session, remove the stale pending item. Never touch race goal.
    const completedDates=new Set(out.workouts.filter(w=>w.status==='completed').map(w=>w.date));
    out.workouts=out.workouts.filter(w=>!(w.status==='planned' && w.kind!=='carreraObjetivo' && completedDates.has(w.date)));
    for (const w of b.weights) {
      const old=out.weights.find(x=>x.date===w.date);
      if (!old) {out.weights.push(clone(w));report.weightsAdded++;}
      else if (old.kg!==w.kg) report.weightsConflicted++;
    }
    for (const e of b.extras) {
      const exists=out.extras.some(x=>(e.stravaId && x.stravaId && String(x.stravaId)===String(e.stravaId)) ||
        (e.id && e.id===x.id) || (x.date===e.date && x.title===e.title && x.auto===e.auto));
      if (!exists && (!e.auto || !out.extras.some(x=>x.auto && x.date===e.date && x.title===e.title))) {
        out.extras.push(clone(e));report.otherActivitiesAdded++;
      }
    }
    out.unavailable=[...new Set([...(a.unavailable||[]),...(b.unavailable||[])])].sort();
    const ids=new Set(out.goals.map(g=>g.id));
    for (const g of b.goals) {
      if (!ids.has(g.id) && g.status!=='active') {out.goals.push(clone(g));ids.add(g.id);}
    }
    out.weeklyDecisions={...b.weeklyDecisions,...a.weeklyDecisions};
    out.intervals={sent:{...(b.intervals?.sent||{}),...(a.intervals?.sent||{})}};
    out.goal=clone(a.goal);
    const foundGoal=out.goals.find(g=>g.id===out.goal.id);
    if (foundGoal) Object.assign(foundGoal,out.goal);
    else out.goals.push(clone(out.goal));
    // Also keep run-to-workout references when the secondary entry was used.
    const wkIds=new Set(out.workouts.map(w=>w.id));
    out.runs.forEach(r=>{if (r.workoutId && !wkIds.has(r.workoutId)) r.workoutId=null;});
    return {state:out,report};
  }
  async function request(method,body) {
    if (!app.S.strava.worker || !app.S.strava.tokens)
      throw new Error('Conecta Strava en este dispositivo antes de usar la nube.');
    const token=await app.ensureStravaToken();
    const r=await fetch(app.workerBase()+'/state',{
      method,cache:'no-store',
      headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},
      ...(body?{body:JSON.stringify(body)}:{})
    });
    let data={};
    try {data=await r.json();}catch(_){}
    if (!r.ok) {const e=new Error(data.error||('HTTP '+r.status));e.code=r.status;throw e;}
    return data;
  }
  async function pull() {
    if (busy) return;
    if (!app.S.strava.worker || !app.S.strava.tokens) {status='auth';message='Conecta Strava aqui para autenticar la sincronizacion.';refresh();return;}
    busy=true;status='checking';refresh();
    try {
      const data=await request('GET'); remote=data;
      if (!meta.linked) {status=data.exists?'available':'empty';message='';}
      else if (!data.exists) {status='error';message='La nube no tiene un perfil compartido. No se han enviado datos.';}
      else if (data.revision===meta.revision) {
        status=isDirty()?'pending':'ok';message='';
      } else if (isDirty()) {
        status='conflict';conflictBackups={local:false,cloud:false,cloudRevision:0};message='Hay cambios locales y cambios en la nube. Revisa ambas copias antes de unirlas.';
      } else {
        silent=true;
        try {app.installSharedState(data.state);}finally{silent=false;}
        meta.revision=data.revision;meta.ack=hash();persist();
        status='ok';message='Perfil y calendario actualizados desde otro dispositivo.';
      }
    } catch(e) {status='error';message=e.message;}
    finally {busy=false;refresh();}
    if (status==='pending') schedule();
  }
  async function push() {
    if (busy || !meta.linked || status==='conflict') return;
    if (!isDirty()) {status='ok';refresh();return;}
    busy=true;status='uploading';refresh();
    const snapshot=get(),snapshotHash=JSON.stringify(snapshot),expected=meta.revision;
    try {
      const res=await request('PUT',{expectedRevision:expected,state:snapshot});
      meta.revision=res.revision;meta.ack=snapshotHash;persist();
      status=isDirty()?'pending':'ok';message='Cambios guardados en la nube.';
    } catch(e) {
      status=e.code===409?'conflict':'error';if (status==='conflict') conflictBackups={local:false,cloud:false,cloudRevision:0};message=e.message;
    } finally {busy=false;refresh();}
    if (status==='pending') schedule();
  }
  function schedule() {
    if (timer) clearTimeout(timer);
    if (!meta.linked || busy || status==='conflict') return;
    timer=setTimeout(()=>{timer=null;push();},1400);
  }
  function onLocalSave() {
    if (silent || !meta.linked || !meta.ack) return;
    if (isDirty() && status!=='conflict') {status='pending';schedule();}
  }
  function download(data,name) {
    const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;
    a.click();setTimeout(()=>URL.revokeObjectURL(a.href),5000);
  }
  async function previewFiles() {
    const a=document.getElementById('cloudFileA')?.files?.[0];
    const b=document.getElementById('cloudFileB')?.files?.[0];
    if (!a || !b) throw new Error('Necesitas las dos copias: iPhone y ordenador.');
    if (a.size>2000000 || b.size>2000000) throw new Error('Copia demasiado grande para esta primera migracion.');
    const first=JSON.parse(await a.text()),second=JSON.parse(await b.text());
    const primary=document.getElementById('cloudPrimary')?.value||'a';
    const merged=primary==='a'?merge(first,second):merge(second,first);
    importing={...merged,sourceA:a.name,sourceB:b.name,primary};
    message='Fusion preparada. Revisa el resumen y confirma solo cuando hayas guardado las dos copias originales.';
    status='empty';refresh();
  }
  async function seed() {
    if (!importing || busy) return;
    if (!confirm('Se va a crear el perfil compartido a partir de AMBAS copias. Asegurate de conservar los JSON originales. Continuar?')) return;
    busy=true;status='uploading';refresh();
    try {
      const res=await request('POST',{expectedRevision:0,state:importing.state});
      silent=true;
      try {app.installSharedState(importing.state);}finally{silent=false;}
      meta.linked=true;meta.revision=res.revision;meta.ack=hash();persist();
      importing=null;status='ok';message='Perfil comun creado. Abre Ajustes en el segundo dispositivo y vincula la nube.';
    }catch(e){status=e.code===409?'available':'error';message=e.message;}
    finally{busy=false;refresh();}
  }
  async function linkExisting() {
    if (!remote?.exists) {message='Primero comprueba la conexion.';refresh();return;}
    if (!confirm('Vas a sustituir el plan y perfil de ESTE dispositivo por el perfil compartido. Conserva una exportacion local. Los tokens Strava y el chat se mantienen. Continuar?')) return;
    silent=true;
    try {app.installSharedState(remote.state);}finally{silent=false;}
    meta.linked=true;meta.revision=remote.revision;meta.ack=hash();persist();
    status='ok';message='Dispositivo conectado al perfil compartido.';refresh();
  }
  async function resolveConflict(prefer) {
    if (!meta.linked || busy) return;
    if (!conflictBackups.local || !conflictBackups.cloud) {
      message='Descarga ambas copias antes de resolver el conflicto.'; refresh(); return;
    }
    try {
      const fresh=await request('GET');
      if (!fresh.exists) throw new Error('No hay perfil compartido.');
      if (fresh.revision!==conflictBackups.cloudRevision) {
        remote=fresh; conflictBackups.cloud=false;
        status='conflict';message='La nube ha cambiado otra vez. Descarga su nueva copia antes de fusionar.'; refresh(); return;
      }
      const local=get();
      // User already downloaded both snapshots before accepting a merge.
      const merged=prefer==='local'?merge(local,fresh.state):merge(fresh.state,local);
      const text=`Se uniran los historiales de ambos dispositivos. El calendario y preferencias en conflicto los decide ${prefer==='local'?'ESTE dispositivo':'LA NUBE'}. Las sesiones planificadas alternativas y datos en conflicto siguen en las copias exportadas. Confirmar?`;
      if (!confirm(text)) {status='conflict';refresh();return;}
      busy=true;status='uploading';refresh();
      const res=await request('PUT',{expectedRevision:fresh.revision,state:merged.state});
      silent=true;
      try {app.installSharedState(merged.state);}finally{silent=false;}
      meta.linked=true;meta.revision=res.revision;meta.ack=hash();persist();
      status='ok';message='Conflicto resuelto y datos unificados.';
    }catch(e){status=e.code===409?'conflict':'error';message=e.message;}
    finally{busy=false;refresh();}
  }
  const statusText={checking:'Comprobando',loading:'Cargando',auth:'Falta autorizacion Strava',empty:'Nube sin inicializar',available:'Nube con perfil existente',uploading:'Guardando cambios',pending:'Cambios locales pendientes',ok:'Sincronizado',conflict:'Conflicto sin resolver',error:'Sin conexion o error'};
  function summarize(s) {
    if (!s) return '';
    return `${(s.runs||[]).length} carreras, ${(s.workouts||[]).length} sesiones y ${(s.weights||[]).length} pesajes.`;
  }
  function renderPanel() {
    const el=document.getElementById('cloud-panel'); if (!el) return;
    const disabled=busy?'disabled':'';
    let content=`<div class="card"><h2>Sincronizacion ordenador e iPhone</h2>
      <div class="sub">Estado: <b>${esc(statusText[status]||status)}</b> ${meta.linked?'\u00b7 revision '+meta.revision:''}</div>
      ${message?`<div class="note ${status==='error'||status==='conflict'?'warn':''}">${esc(message)}</div>`:''}
      <div class="sub small">Comparte perfil, calendario, carreras y sensaciones. Los tokens de Strava y el chat se quedan en cada dispositivo.</div>`;
    if (meta.linked) {
      content+=`<div class="btns"><button data-cloud-action="pull" ${disabled}>Sincronizar ahora</button><button data-cloud-action="download-local">Exportar copia local</button><button data-cloud-action="unlink">Desvincular solo este dispositivo</button></div>`;
      if (status==='conflict') content+=`<div class="note warn">Descarga las DOS versiones antes de fusionar. Elige cual prevalece en los cambios incompatibles; las carreras no duplicadas se conservaran.</div>
        <div class="btns"><button data-cloud-action="backup-local" ${disabled}>Descargar copia local ${conflictBackups.local?'(hecho)':''}</button><button data-cloud-action="backup-cloud" ${disabled}>Descargar copia nube ${conflictBackups.cloud?'(hecho)':''}</button></div>
        <div class="btns"><button data-cloud-action="resolve-cloud" ${disabled||(!conflictBackups.local||!conflictBackups.cloud?'disabled':'')}>Preferir calendario de nube</button><button data-cloud-action="resolve-local" ${disabled||(!conflictBackups.local||!conflictBackups.cloud?'disabled':'')}>Preferir calendario de este dispositivo</button></div>`;
    } else if (status==='available') {
      content+=`<div class="note">Ya existe un perfil compartido (${esc(summarize(remote?.state))}). Si tus dos copias anteriores ya se unieron, vincula este dispositivo.</div>
        <div class="btns"><button data-cloud-action="download-local">Exportar este dispositivo antes</button><button class="primary" data-cloud-action="link" ${disabled}>Usar perfil compartido aqui</button></div>`;
    } else if (status==='empty' || status==='checking' || status==='auth' || status==='error') {
      content+=`<div class="note">Primera configuracion: exporta una copia en el iPhone y otra en Windows. Carga los DOS archivos aqui antes de crear el estado comun. Ninguno se sobrescribira automaticamente.</div>
        <label>Copia 1</label><input id="cloudFileA" type="file" accept=".json,application/json" ${disabled}>
        <label>Copia 2</label><input id="cloudFileB" type="file" accept=".json,application/json" ${disabled}>
        <label>En caso de diferencias, usar como referencia:</label>
        <select id="cloudPrimary"><option value="a">Copia 1 (perfil y plan)</option><option value="b">Copia 2 (perfil y plan)</option></select>
        <div class="btns"><button data-cloud-action="preview" ${disabled}>Comparar y preparar fusion</button><button data-cloud-action="pull" ${disabled}>Comprobar nube</button></div>`;
      if (importing) {
        const p=importing.report;
        content+=`<div class="note"><b>Fusion lista (todavia no publicada)</b><div class="sub small">${esc(importing.sourceA)} + ${esc(importing.sourceB)}<br>Resultado: ${esc(summarize(importing.state))}</div>
          <div class="sub small">Carreras añadidas: ${p.runsAdded}; carreras conciliadas: ${p.runsCombined}; sesiones completadas recuperadas: ${p.completedAdded}; sesiones manuales recuperadas: ${p.manualAdded}; pesajes añadidos: ${p.weightsAdded}.</div>
          <div class="sub small">Discrepancias de peso (prevalece copia elegida): ${p.weightsConflicted}. Otras planificaciones descartadas para evitar duplicados: ${p.plansIgnored}. Conserva ambas copias originales.</div></div>
          <button class="primary" data-cloud-action="seed" ${disabled}>Crear perfil compartido</button>`;
      }
    }
    content+='</div>';
    el.innerHTML=content;
  }
  document.addEventListener('click',async e=>{
    const el=e.target.closest('[data-cloud-action]'); if (!el) return;
    e.preventDefault(); const act=el.dataset.cloudAction;
    try {
      if (act==='pull') await pull();
      else if (act==='preview') await previewFiles();
      else if (act==='seed') await seed();
      else if (act==='link') await linkExisting();
      else if (act==='download-local') download(app.S,'running-coach-copia-local.json');
      else if (act==='backup-local') {download(app.S,'running-coach-local-conflicto.json');conflictBackups.local=true;refresh();}
      else if (act==='backup-cloud') {
        if (!remote?.exists) throw new Error('Pulsa Sincronizar ahora para preparar una copia reciente de la nube.');
        download(remote.state,'running-coach-nube-conflicto.json');
        conflictBackups.cloud=true;conflictBackups.cloudRevision=remote.revision;refresh();
      }
      else if (act==='unlink') {
        if (confirm('Se desvincula SOLO este dispositivo. El perfil en D1 no se borra. Continuar?')) {
          meta={linked:false,revision:0,ack:''};persist();status='available';refresh();
        }
      } else if (act==='resolve-local') await resolveConflict('local');
      else if (act==='resolve-cloud') await resolveConflict('cloud');
    } catch(ex) {status='error';message=ex.message;refresh();}
  });
  window.addEventListener('online',()=>pull());
  // Re-check when browser tab becomes active, including after wake from sleep.
  // The app's own foreground handler also calls this method; busy prevents overlap.
  const api={ready:null,pull,onLocalSave,renderPanel,isLinked:()=>!!meta.linked,
    mergeStates:merge, getMeta:()=>clone(meta), getStatus:()=>status};
  window.RCACloud=api;
  api.ready=pull().catch(e=>{status='error';message=e.message;refresh();});
})();

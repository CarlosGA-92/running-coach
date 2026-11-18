/* Running Coach AI (web) — interfaz. Todo se guarda en localStorage de tu iPhone. */
(function () {
  'use strict';
  const R = window.RCA;
  const KEY = 'rca_state_v1';
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtMin = n => (Math.round(n * 10) / 10).toString().replace('.', ',');
  const nowObj = () => ({ date: R.today(), hour: new Date().getHours() });
  const byDate = (a, b) => a.date.localeCompare(b.date);

  /* ---------------- Estado ---------------- */
  function freshState() {
    const s = { v: 1, profile: R.defaultProfile(), goal: R.defaultGoal(), goals: [], weights: [], workouts: [], extras: [], unavailable: [], runs: [], chat: [], notes: [],
      strava: { worker: '', tokens: null, lastSync: null, lastAutoAttempt: null }, weeklyDecisions: {}, intervals: { sent: {} }, savedAt: null };
    s.goals = [s.goal];
    const plan = R.generatePlan(s.profile, s.goal, new Set(), nowObj());
    s.workouts = plan.workouts; s.extras = plan.extras; s.notes = plan.notes;
    return s;
  }
  /** Copias antiguas (sin objetivos múltiples ni peso) se completan sin perder nada. S.goal siempre apunta al objeto dentro de S.goals. */
  function ensureShape(s) {
    s.goals = Array.isArray(s.goals) ? s.goals : [];
    s.weights = Array.isArray(s.weights) ? s.weights : [];
    s.weeklyDecisions = s.weeklyDecisions && typeof s.weeklyDecisions === 'object' ? s.weeklyDecisions : {};
    s.intervals = s.intervals && typeof s.intervals === 'object' ? s.intervals : { sent: {} };
    s.intervals.sent = s.intervals.sent && typeof s.intervals.sent === 'object' ? s.intervals.sent : {};
    s.strava = Object.assign({ worker: '', tokens: null, lastSync: null, lastAutoAttempt: null }, s.strava || {});
    s.profile.lastReplan = s.profile.lastReplan || null;
    s.profile.fitnessSource = s.profile.fitnessSource || null;
    const base = { id: 'g1', kind: 'finish', status: 'active', targetTimeSec: null, resultSec: null, achievedRunId: null };
    const cur = Object.assign({}, base, s.goal || R.defaultGoal());
    const inList = s.goals.find(g => g.id === cur.id);
    if (inList) Object.assign(inList, base, inList); else s.goals.push(cur);
    s.goal = s.goals.find(g => g.id === cur.id);
    if (s.goal.status !== 'active') { const a = s.goals.find(g => g.status === 'active'); if (a) s.goal = a; }
    return s;
  }
  function load() {
    try { const raw = localStorage.getItem(KEY); if (raw) { const s = JSON.parse(raw); if (s && s.v === 1) return ensureShape(s); } } catch (e) { /* sin almacenamiento */ }
    return freshState();
  }
  let S = load();
  let storageOk = true;
  function save() {
    S.savedAt = new Date().toISOString();
    try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { storageOk = false; }
  }
  const snap = () => ({ workouts: S.workouts, extras: S.extras, unavailable: S.unavailable, profile: S.profile, goal: S.goal, runs: S.runs });

  const ui = { tab: 'home', calMode: 'week', calAnchor: R.today(), calSel: R.today(), period: 30, filter: 'all', modal: null,
    create: { text: '', kind: 'rodajeSuave', date: R.today(), preview: null }, busy: false, aiBusy: false, intervalsBusy: false, stravaMsg: '', pseg: 'runs', cmpA: '', cmpB: '' };

  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), 3200); }

  /* ---------------- Operaciones sobre el plan ---------------- */
  function regenerate() {
    const t = R.today();
    S.workouts = S.workouts.filter(w => !(w.status === 'planned' && w.date >= t && !w.manual));   // las que creaste tú se conservan
    S.extras = S.extras.filter(e => !(e.auto && e.date >= t));
    const plan = R.generatePlan(S.profile, S.goal, new Set(S.unavailable), nowObj());
    const taken = new Set(S.workouts.filter(w => w.status === 'completed' || (w.status === 'planned' && w.manual)).map(w => w.date));
    S.workouts.push(...plan.workouts.filter(w => !taken.has(w.date) || w.kind === 'carreraObjetivo'));
    S.extras.push(...plan.extras); S.notes = plan.notes; save();
    return plan.notes;
  }
  /* El PERFIL se actualiza automaticamente con los ultimos 42 dias.
     La IA lo interpreta, pero el calculo numerico depende de datos medidos,
     no de un texto inventado por el modelo. El plan se cambia por separado. */
  const fitNow = () => R.estimateFitness(S.runs, S.profile);
  function applyFitness() {
    const f = fitNow(), p = S.profile;
    const source = { fromData: f.fromData, runs: f.runsConsidered,
      windowDays: 42, confidence: f.confidence, latestRunDate: f.latestRunDate || null,
      longestMovingMin: Math.round(f.longestMovingMin || 0),
      estimatedContinuous: true };
    if (f.fromData) {
      p.easyPace = Math.round(f.easyPace);
      p.continuousMin = f.baseMin; // proxy para plan; NO una continuidad demostrada
    }
    p.fitnessSource = source;
    save();
    return f;
  }
  /* ---- Ciclo de vida de objetivos ---- */
  function maintainGoal() { return { id: R.uid(), title: 'Mantener y mejorar la forma', kind: 'maintain', distanceKm: 0, date: R.MAINTAIN_DATE, targetTimeSec: null, status: 'active', resultSec: null, achievedRunId: null }; }
  function activateGoal(g) {
    S.goals.forEach(x => { if (x.status === 'active') x.status = 'replaced'; });
    g.id = R.uid(); g.status = 'active'; g.resultSec = null; g.achievedRunId = null;
    S.goals.push(g); S.goal = g;
    return regenerate();
  }
  /** Al abrir: cierra el objetivo si ya pasó (conseguido/no), crea el modo mantenimiento y renueva su plan cuando se acaba. */
  function lifecycle() {
    const t = R.today(); let ch = false;
    const ev = R.evaluateGoal(S.goal, S.runs, t);
    if (ev) {
      Object.assign(S.goal, { status: ev.status, resultSec: ev.resultSec, achievedRunId: ev.run ? ev.run.id : null, noRun: ev.noRun, seen: false });
      S.workouts.forEach(w => { if (w.kind === 'carreraObjetivo' && w.status === 'planned' && w.date < t) w.status = 'skipped'; });
      ch = true;
    }
    if (S.goal.status !== 'active') {
      const m = maintainGoal(); S.goals.push(m); S.goal = m; regenerate(); ch = true;
    } else if (S.goal.kind === 'maintain' && !S.workouts.some(w => w.status === 'planned' && w.date >= t && w.date < R.addDays(t, 7))) {
      regenerate(); ch = true;
    }
    if (ch) save();
  }
  function handleMissed() {
    const t = R.today(); let changed = false;
    S.workouts.filter(w => w.status === 'planned' && w.date < t && w.kind !== 'carreraObjetivo').sort(byDate).forEach(w => {
      const slot = R.diffDays(w.date, t) <= 2 ? R.nextSlot(snap(), w, R.addDays(t, -1)) : null;
      if (slot) { w.date = slot; w.explanation = 'No pudiste hacerla en su día; la recupero en un hueco cercano que no junta sesiones intensas.'; }
      else { w.status = 'skipped'; w.explanation = 'No se hizo y ya no conviene recuperarla: acumular sesiones atrasadas subiría la carga de golpe.'; }
      changed = true;
    });
    if (changed) save();
  }
  function setUnavailable(date, on) {
    const msgs = [];
    if (!on) S.unavailable = S.unavailable.filter(d => d !== date);
    else if (!S.unavailable.includes(date)) {
      S.unavailable.push(date);
      S.workouts.filter(w => w.date === date && w.status === 'planned' && w.kind !== 'carreraObjetivo').forEach(w => {
        const r = R.reschedule(snap(), w, date);
        if (r.moved) { w.date = r.moved; w.explanation = 'Reprogramada: ' + r.why; } else { w.status = 'discarded'; w.explanation = 'Descartada: ' + r.why; }
        msgs.push(`«${w.title}»: ${r.why}`);
      });
    }
    save(); return msgs;
  }
  function applyAdvice(w, factor, rec, expl) {
    if (Math.abs(factor - 1) > 0.001) R.scale(w, factor, expl); else w.explanation = 'Sin cambios: ' + expl;
    if (rec > 0) {
      const slot = R.nextSlot(snap(), w, w.date, 2);
      if (slot) { w.date = slot; w.explanation = (w.explanation || '') + ' Se retrasa un día para dar más recuperación.'; }
    }
    save();
  }
  const nextPlannedAfter = date => S.workouts.filter(w => w.status === 'planned' && w.date > date && w.kind !== 'carreraObjetivo').sort(byDate)[0];
  /* La carrera REAL es la referencia. La sesión planeada se conserva solo como
     comparación, pero no vuelve a mostrarse como pendiente/completada en el calendario. */
  /* V7.3: expectativa de la sesion. RPE es un RANGO ORIENTATIVO por tipo de
     actividad, no una prediccion individual ni una constatacion de capacidad. */
  function expectedEffort(kind) {
    return ({recuperacion:[2,4],rodajeSuave:[3,5],carreraContinua:[4,6],
      intervalos:[5,7],prueba:[7,8],carreraObjetivo:[5,8]})[kind] || [3,6];
  }
  function sessionExpectation(w) {
    if (!w) return null;
    const minutes = Number.isFinite(w.durationS) ? w.durationS / 60 : R.totalMin(w.items || []);
    const km = Number.isFinite(w.distanceM) ? w.distanceM / 1000 : R.distKm(w.items || []);
    const [rpeMin, rpeMax] = expectedEffort(w.kind);
    const purpose = ({
      recuperacion:'Recuperar sin anadir fatiga.',
      rodajeSuave:'Sostener una intensidad conversacional y terminar con margen.',
      carreraContinua:'Mantener un esfuerzo estable y controlado.',
      intervalos:'Completar los bloques intensos sin perder el control de las recuperaciones.',
      prueba:'Medir una referencia exigente pero controlada.',
      carreraObjetivo:'Completar el objetivo con una salida controlada.'
    })[w.kind] || 'Acumular entrenamiento sin sobrecarga.';
    return { minutes:Math.round(minutes*10)/10, km:Math.round(km*100)/100,
      rpeMin, rpeMax, purpose, kind:w.kind||'carreraContinua' };
  }
  function expectationNote(w) {
    const e=sessionExpectation(w), t=R.today();
    const recent=S.runs.filter(r=>r.date>=R.addDays(t,-41) && r.date<=t &&
      Number.isFinite(r.durationS) && r.durationS>0);
    if (!recent.length) return 'Sin salidas recientes comparables: valoraremos el resultado segun tus sensaciones.';
    const longest=Math.max(...recent.map(r=>r.durationS/60));
    const hard=recent.slice().sort((a,b)=>b.date.localeCompare(a.date))[0];
    if (e.minutes>longest*1.15)
      return `La duracion prevista supera tus ${Math.round(longest)} min maximos recientes en movimiento. Revisa sensaciones y reduce si hace falta.`;
    if (hard && hard.feeling && (hard.feeling.pain || hard.feeling.rpe>=8))
      return 'Tu ultima salida incluyo molestias o esfuerzo alto: si no has recuperado, valora suavizar o posponer la sesion.';
    return 'Contrasta al acabar la duracion prevista y el esfuerzo percibido; no es necesario batir tu ritmo anterior.';
  }
  function sessionExpectationHtml(w) {
    if (!w || w.status!=='planned') return '';
    const e=sessionExpectation(w);
    return `<div class="card"><h2>Antes de salir · que esperamos</h2>
      <div class="row between"><span>Duracion orientativa</span><b>${fmtMin(e.minutes)} min</b></div>
      <div class="row between"><span>Esfuerzo orientativo</span><b>RPE ${e.rpeMin}–${e.rpeMax}/10</b></div>
      <div class="sub" style="margin-top:8px">${esc(e.purpose)}</div>
      <div class="sub small" style="margin-top:6px">${esc(expectationNote(w))}</div>
      <div class="sub small" style="margin-top:6px">RPE = esfuerzo que percibes de 1 a 10. No es una prediccion exacta ni una exigencia de ritmo.</div></div>`;
  }
  /* La comparacion utiliza el plan realmente vinculado, no un valor inventado
     por la IA. Para carreras anteriores a esta version reconstruye el criterio
     orientativo desde el tipo de sesion, y lo indica como retrospectivo. */
  function sessionOutcome(run) {
    if (!run.planned) return {label:'Salida libre',detail:'No hay una sesion planificada con la que comparar.',next:'Registra sensaciones para valorar la carga.',e:null};
    const e=run.sessionExpectation || sessionExpectation(run.planned);
    const dur=run.durationS / 60;
    const ratio=e.minutes>0?dur/e.minutes:1;
    const f=run.feeling;
    let label, detail, next;
    if (!f) {
      label='Resultado provisional';
      detail='La duracion ya se puede comparar; faltan sensaciones para evaluar la exigencia.';
      next='Registra RPE, respiracion y fatiga antes de decidir si conviene progresar.';
    } else if ((f.pain||'').trim()) {
      label='Molestias registradas';
      detail='Has indicado molestias: la duracion o la velocidad no compensan esa senal.';
      next='Prioriza recuperacion y revisa el siguiente entrenamiento; consulta si persisten o empeoran.';
    } else if (f.rpe>e.rpeMax+1 || f.breathing>=4 || f.fatigue>=4) {
      label='Mas exigente de lo esperado';
      detail='Tu esfuerzo o fatiga declarados superan el margen de control de esta sesion.';
      next='Valora suavizar o mover la siguiente sesion. La app no aplicara cambios importantes sin tu aceptacion.';
    } else if (ratio>=.85 && ratio<=1.25 && f.rpe<=e.rpeMax && f.breathing<=3 && f.fatigue<=3) {
      label='En linea con lo esperado';
      detail='Has acumulado un tiempo parecido al objetivo y tu esfuerzo se ha mantenido controlado.';
      next='Mantendria de momento la siguiente sesion; la progresion exige constancia en varias salidas, no una sola.';
    } else if (ratio>1.25) {
      label='Mas duracion de la prevista';
      detail='Has realizado bastante mas tiempo del plan. Eso suma carga aunque te hayas sentido comodo.';
      next='No aumentaria mas la carga inmediatamente; revisaria la recuperacion antes de la proxima salida.';
    } else if (ratio<.85) {
      label='Menos duracion de la prevista';
      detail='Has hecho una salida mas corta. No es un incumplimiento: el calendario mantiene lo realmente realizado.';
      next='Manten o revisa la siguiente sesion segun sensaciones; no recuperes minutos por obligacion.';
    } else {
      label='Resultado mixto';
      detail='La duracion y las sensaciones no permiten confirmar una mejora clara con esta unica sesion.';
      next='Mantendria la carga y esperaria otra salida comparable antes de progresar.';
    }
    return {label,detail,next,e,minutesDelta:Math.round((dur-e.minutes)*10)/10,
      retrospective:!run.sessionExpectation};
  }
  function outcomeHtml(run) {
    const o=sessionOutcome(run);if(!o.e)return '';
    return `<div class="card"><h2>Lo esperado vs. lo realizado</h2><h3>${esc(o.label)}</h3>
      <div class="row between" style="margin-top:8px"><span>Duracion</span><b>${fmtMin(o.e.minutes)} → ${fmtMin(run.durationS/60)} min</b></div>
      <div class="row between"><span>RPE orientativo</span><b>${o.e.rpeMin}–${o.e.rpeMax}/10</b></div>
      <div class="row between"><span>RPE declarado</span><b>${run.feeling ? run.feeling.rpe+'/10' : 'Pendiente'}</b></div>
      <div class="sub" style="margin-top:8px">${esc(o.detail)}</div>
      <div class="note">Proxima decision: ${esc(o.next)}</div>
      ${o.retrospective?'<div class="sub small">Criterio orientativo reconstruido a partir del plan guardado; no fue una prevision registrada antes de esa salida.</div>':''}
      <div class="sub small">El tiempo de Strava puede incluir caminar; esta comparativa no certifica que corrieras todo el tiempo sin pausas.</div></div>`;
  }
  function plannedSnapshot(w) {
    const durationS = Math.round(R.totalMin(w.items) * 60);
    const distanceM = R.distKm(w.items) * 1000;
    return { id: w.id, title: w.title, kind: w.kind, date: w.date, durationS, distanceM,
      paceSec: distanceM > 0 ? durationS / (distanceM / 1000) : null };
  }
  function eligibleForRun(w, run) {
    if (w.kind === 'carreraObjetivo') return w.date === run.date;
    if (w.status === 'planned') return true;
    // Se puede recuperar una sesión que fue marcada como perdida automáticamente;
    // las canceladas manualmente solamente se recuperan si coinciden exactamente.
    return w.status === 'skipped' && (w.date === run.date || !String(w.explanation || '').startsWith('Marcada por ti'));
  }
  function rememberPlanChange(run, w) {
    (run.autoChanges ||= []).push({ id: w.id, before: {
      date: w.date, status: w.status, explanation: w.explanation, items: JSON.parse(JSON.stringify(w.items)),
    } });
  }
  function avoidCrowding(run) {
    // No reescribimos semanas antiguas al importar mucho histórico.
    const today = R.today(), first = R.mondayOf(run.date), end = R.addDays(first, 6);
    if (end < today || R.diffDays(run.date, today) > 7) return;
    const remaining = S.workouts.filter(w => w.status === 'planned' && w.date >= today &&
      w.date >= run.date && w.date <= end && w.kind !== 'carreraObjetivo')
      .sort(byDate);
    let softened = false;
    for (const w of remaining) {
      const conflict = S.runs.some(r => Math.abs(R.diffDays(r.date, w.date)) < 2);
      if (conflict) {
        if (w.manual) {
          w.explanation = 'Aviso: esta sesión creada por ti queda muy cerca de una carrera real; revisa la recuperación antes de hacerla.';
          continue;
        }
        const old = w.date;
        let slot = null;
        const earliest = [today, R.addDays(run.date, 2)].sort().pop();
        for (let d = earliest; d <= end; d = R.addDays(d, 1)) {
          if (S.unavailable.includes(d) || S.profile.noRun.includes(R.weekday(d))) continue;
          if (S.runs.some(r => Math.abs(R.diffDays(r.date, d)) < 2)) continue;
          if (S.workouts.some(x => x.id !== w.id && x.status === 'planned' && Math.abs(R.diffDays(x.date, d)) < 2)) continue;
          if (S.extras.some(e => e.date === d && e.intense)) continue;
          if (R.violatesIntensity(snap(), w, d)) continue;
          slot = d; break;
        }
        rememberPlanChange(run, w);
        if (slot) {
          w.date = slot;
          w.explanation = `Reajustada del ${R.longDate(old)} al ${R.longDate(slot)}: así tienes al menos un día sin correr después de la salida real.`;
        } else {
          w.status = 'discarded';
          w.explanation = 'Retirada de esta semana para evitar acumular sesiones y correr sin suficiente recuperación tras la salida real.';
        }
      }
      // Si la salida fue bastante más larga de lo programado, suavizamos solo una
      // próxima sesión; nunca aumentamos carga para "recuperar" minutos perdidos.
      if (!softened && run.planned && run.durationS > run.planned.durationS * 1.25 &&
          w.status === 'planned' && w.date > run.date && !w.manual) {
        rememberPlanChange(run, w);
        const factor = run.durationS > run.planned.durationS * 1.7 ? 0.85 : 0.9;
        R.scale(w, factor, 'Salida real más larga que la prevista; priorizamos recuperación.');
        softened = true;
      }
    }
  }
  function linkRun(run) {
    if (run.planProcessed) return false;
    // Migración: carreras ya vinculadas por versiones anteriores.
    let w = run.workoutId ? S.workouts.find(x => x.id === run.workoutId) : null;
    if (!w) {
      const start = R.mondayOf(run.date), end = R.addDays(start, 6);
      const options = S.workouts.filter(x => !x.runId && x.date >= start && x.date <= end && eligibleForRun(x, run));
      // La sesion mas cercana de la misma semana: mismo dia, luego menor
      // distancia temporal. En empate, preferimos una anterior no realizada,
      // para no dejarla marcada como incumplida y duplicar el resto de la carga.
      options.sort((a, b) => {
        const da = Math.abs(R.diffDays(a.date, run.date)), db = Math.abs(R.diffDays(b.date, run.date));
        return da - db || a.date.localeCompare(b.date);
      });
      w = options[0] || null;
    }
    if (w) {
      run.planned ||= plannedSnapshot(w);
      run.sessionExpectation ||= sessionExpectation(run.planned);
      run.workoutId = w.id;
      w.status = 'completed'; w.runId = run.id;
      w.completedOn = run.date;
      // Otras sesiones del mismo día no deben figurar como incumplidas cuando
      // el entrenamiento real ya ha sustituido la actividad prevista.
      S.workouts.filter(x => x.id !== w.id && x.date === run.date && x.status === 'planned' &&
          x.kind !== 'carreraObjetivo').forEach(x => {
        rememberPlanChange(run, x);
        x.status = 'discarded';
        x.explanation = 'Sustituida por la carrera real de ese día.';
      });
      avoidCrowding(run);
    }
    run.planProcessed = true;
    return !!w;
  }
  function reconcileExistingRuns() {
    let changed = false;
    S.runs.slice().sort((a, b) => (a.start || '').localeCompare(b.start || '')).forEach(run => {
      if (run.planProcessed) return;
      linkRun(run); changed = true;
    });
    if (changed) save();
  }
  function restoreRunPlan(run) {
    (run.autoChanges || []).slice().reverse().forEach(c => {
      const w = wkById(c.id); if (!w) return;
      w.date = c.before.date; w.status = c.before.status; w.explanation = c.before.explanation;
      w.items = c.before.items;
    });
    const w = run.workoutId && wkById(run.workoutId);
    if (w && w.runId === run.id) {
      w.status = 'planned'; w.runId = null; delete w.completedOn;
      // La fecha original nunca se modificó al vincularla.
    }
  }
  function runPlanComparison(run) {
    const p = run.planned;
    if (!p) return '<div class="card"><h2>Plan y realidad</h2><div class="sub">Carrera libre, sin entrenamiento del plan asignado.</div></div>';
    const kmDelta = (run.distanceM - p.distanceM) / 1000;
    const minDelta = (run.durationS - p.durationS) / 60;
    const signed = (x, digits) => `${x > 0 ? '+' : ''}${x.toFixed(digits).replace('.', ',')}`;
    return `<div class="card"><h2>Planificado vs. realizado</h2>
      <div class="sub small">${esc(p.title)} · previsto para ${R.longDate(p.date)}${p.date === run.date ? '' : ' · realizado el ' + R.longDate(run.date)}</div>
      <div class="row between" style="margin-top:8px"><span>Distancia</span><span>${R.fmtKm(p.distanceM / 1000)} → <b>${R.fmtKm(run.distanceM / 1000)} km</b> (${signed(kmDelta,2)} km)</span></div>
      <div class="row between"><span>Duración</span><span>${R.fmtDur(p.durationS)} → <b>${R.fmtDur(run.durationS)}</b> (${signed(minDelta,1)} min)</span></div>
      <div class="row between"><span>Ritmo medio</span><span>${R.fmtPace(p.paceSec)} → <b>${R.fmtPace(R.avgPace(run))}</b></span></div>
      <div class="sub small" style="margin-top:8px">El ritmo previsto es orientativo: incluye calentamiento y recuperación. Se conserva el plan original para compararlo, pero el calendario muestra solo la carrera real.</div></div>`;
  }

  /* Informe post-entreno: datos observables separados de las sensaciones declaradas.
     Nunca inferimos el esfuerzo solo a partir de una velocidad o la FC media. */
  function runReview(run) {
    const f = run.feeling, planned = run.planned;
    let title = 'Valoración inicial', quality = 'Para valorar el esfuerzo y ajustar el plan a tus sensaciones, completa el cuestionario de abajo.';
    if (f) {
      if ((f.pain || '').trim()) {
        title = 'Revisar molestias';
        quality = 'Has registrado molestias. Prioriza la recuperación y evita forzar si persisten o aumentan.';
      } else if (f.rpe >= 8 || f.breathing >= 4 || f.fatigue >= 4) {
        title = 'Sesión exigente';
        quality = `Según tus sensaciones, fue una salida exigente (esfuerzo ${f.rpe}/10). Conviene vigilar la recuperación.`;
      } else if (f.rpe <= 5 && f.breathing <= 2 && f.fatigue <= 2 && f.canContinue) {
        title = 'Sesión cómoda';
        quality = `Te has sentido cómodo y con margen para continuar (esfuerzo ${f.rpe}/10). Esto ayuda a valorar tu progresión.`;
      } else {
        title = 'Esfuerzo moderado';
        quality = `Has registrado un esfuerzo ${f.rpe}/10. Mantener la regularidad y la recuperación importa más que acelerar cada salida.`;
      }
    }
    let planText = 'Carrera libre: no había una sesión del plan disponible para vincular durante esa semana.';
    if (planned && planned.durationS > 0) {
      const pct = Math.round((run.durationS / planned.durationS - 1) * 100);
      if (Math.abs(pct) < 10) planText = 'Has realizado una duración parecida a la prevista (diferencia menor del 10 %).';
      else if (pct > 0) planText = `Has corrido un ${pct} % más de tiempo que el previsto; eso supone más duración, pero no demuestra por sí solo que fuese más intenso.`;
      else planText = `Has corrido un ${Math.abs(pct)} % menos de tiempo que el previsto; no se considera un incumplimiento: el entrenamiento real sustituye al plan.`;
    }
    // Tendencia solo frente a salidas anteriores de distancia parecida.
    // Una diferencia de ritmo no equivale a una diferencia de esfuerzo.
    const prev = S.runs.filter(x => x.id !== run.id && x.start < run.start &&
      x.distanceM > 0 && run.distanceM > 0 &&
      x.distanceM / run.distanceM >= 0.8 && x.distanceM / run.distanceM <= 1.2)
      .sort((a,b) => b.start.localeCompare(a.start)).slice(0,3);
    let trend = 'Aún no hay suficientes salidas anteriores de distancia similar para valorar la evolución del ritmo.';
    if (prev.length >= 2) {
      const ordered = prev.map(R.avgPace).filter(x => Number.isFinite(x) && x > 0).sort((a,b) => a-b);
      if (ordered.length >= 2) {
        const median = ordered[Math.floor(ordered.length / 2)], diff = Math.round(R.avgPace(run) - median);
        trend = Math.abs(diff) < 10
          ? 'Ritmo parecido al de tus últimas salidas de distancia similar.'
          : `Ritmo ${Math.abs(diff)} s/km ${diff < 0 ? 'más rápido' : 'más lento'} que la referencia de tus últimas salidas de distancia similar. El terreno, la intención y el esfuerzo pueden explicar parte de la diferencia.`;
      }
    }
    return { title, quality, planText, trend, needsFeedback: !f };
  }
  function weekAdaptation(run) {
    const lines = [];
    if (run.planned) {
      lines.push(run.planned.date === run.date
        ? 'La sesión prevista para este día se ha sustituido por tu entrenamiento real.'
        : `Tu salida del ${R.longDate(run.date)} cuenta como la sesión prevista para ${R.longDate(run.planned.date)}.`);
    } else lines.push('La salida se registra como carrera libre, sin consumir una sesión planificada.');
    const seen = new Set();
    for (const c of (run.autoChanges || [])) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      const w = wkById(c.id);
      if (!w) continue;
      const before = c.before;
      if (w.status === 'discarded' && before.status !== 'discarded')
        lines.push(`Se ha retirado «${w.title}» para evitar acumular sesiones muy próximas.`);
      else if (w.date !== before.date)
        lines.push(`«${w.title}» se ha movido del ${R.longDate(before.date)} al ${R.longDate(w.date)} para dejar más recuperación.`);
      if (w.status === 'planned' && Math.abs(R.totalMin(w.items) - R.totalMin(before.items)) > 0.01)
        lines.push(`Se ha suavizado «${w.title}» porque la salida real fue más larga de lo previsto.`);
    }
    if (!(run.autoChanges || []).length && !run.coachAdviceApplied) {
      lines.push(run.planned ? 'Se mantienen los demás entrenamientos: las reglas automáticas no detectaron cambios necesarios.'
        : 'El resto del plan no se ha modificado.');
    }
    if (run.coachAdviceApplied)
      lines.push(`Además, has aceptado la propuesta del coach para «${run.coachAdviceApplied.title}».`);
    lines.push('Este ajuste es orientativo y no sustituye tus sensaciones ni una valoración profesional ante molestias.');
    return lines;
  }
  function postRunReport(run) {
    const review = runReview(run), changes = weekAdaptation(run);
    return `<div class="card"><h2>Valoración del entrenamiento</h2><h3>${esc(review.title)}</h3>
      <div class="sub" style="margin-top:5px">${esc(review.quality)}</div>
      <div class="note">${esc(review.planText)}</div>
      <div class="sub">${esc(review.trend)}</div>
      ${review.needsFeedback ? '<div class="sub small">Valoración provisional: faltan tus sensaciones para interpretar el esfuerzo real.</div>' : ''}</div>
      <div class="card"><h2>Cómo he adaptado tu semana</h2>
      ${changes.map(t => `<div class="sub" style="margin:5px 0">${esc(t)}</div>`).join('')}</div>`;
  }
  const wkById = id => S.workouts.find(w => w.id === id);
  const runById = id => S.runs.find(r => r.id === id);
  const sortedRuns = () => S.runs.slice().sort((a, b) => Date.parse(b.start) - Date.parse(a.start));

  /* ---------------- Render ---------------- */
  let rendering = false;
  function render() {
    // Quitar el foco antes de reemplazar el HTML: así el «change» pendiente se procesa ahora y no durante el reemplazo.
    const ae = document.activeElement;
    if (!rendering && ae && ae !== document.body && ae.blur) ae.blur();
    if (rendering) return;
    rendering = true;
    try { renderNow(); } finally { rendering = false; }
  }
  function renderNow() {
    const views = { home: vHome, cal: vCal, train: vTrain, prog: vProg, coach: vCoach, set: vSet };
    $('#app').innerHTML = (views[ui.tab] || vHome)() + tabbar();
    $('#modal-root').innerHTML = ui.modal ? vModal() : '';
    if (ui.tab === 'coach') { const c = $('#chatEnd'); if (c) c.scrollIntoView({ block: 'end' }); }
  }
  function tabbar() {
    const t = [['home', '🏠', 'Inicio'], ['cal', '📅', 'Calendario'], ['train', '🏃', 'Entrenar'], ['prog', '📈', 'Progreso'], ['coach', '💬', 'Coach']];
    return '<nav>' + t.map(([k, i, l]) => `<button data-act="tab" data-k="${k}" class="${ui.tab === k ? 'on' : ''}"><i>${i}</i>${l}</button>`).join('') + '</nav>';
  }
  function blockRow(b) {
    return `<div class="blk"><b>${R.BLOCKS[b.kind]}</b><span>${fmtMin(b.min)} min</span><small>${R.both(b.kmh)}</small></div>`;
  }
  function blocksHtml(items) {
    return items.map(i => i.t === 'r'
      ? `<div class="rep"><div class="hd">${i.reps} ×</div>${i.items.map(blockRow).join('')}</div>` : blockRow(i)).join('');
  }
  const wkSummary = w => `${Math.round(R.totalMin(w.items))} min · ≈ ${R.fmtKm(R.distKm(w.items))} km · ${R.INTENSITY[w.kind]}`;
  const runLine = r => `${R.fmtKm(r.distanceM / 1000)} km · ${R.fmtDur(r.durationS)} · ${R.fmtPace(R.avgPace(r))} min/km`;



  /* ---------------- V8: Intervals.icu → Companion → Apple Watch ---------------- */
  // Los eventos se identifican por el ID estable de sesión del coach.
  // Cuando se modifica un bloque, el mismo external_id actualiza el evento.
  const intervalsFingerprint = w => JSON.stringify({date:w.date,title:w.title,items:w.items});
  const intervalsSent = w => S.intervals.sent[w.id] || null;
  const intervalsIsCurrent = w => intervalsSent(w)?.fingerprint === intervalsFingerprint(w);
  const intervalsObsoleteIds = () => Object.keys(S.intervals.sent).filter(id => {
    const w = S.workouts.find(x=>x.id===id);
    return !w || w.status === 'skipped' || w.status === 'discarded';
  });
  function intervalsButton(w) {
    if (!w || w.status !== 'planned') return '';
    const sent = intervalsSent(w), current = intervalsIsCurrent(w);
    const label = !sent ? 'Enviar al Apple Watch' : current ? 'Reenviar al Apple Watch' : 'Actualizar en el Apple Watch';
    return `<button class="primary" data-act="intervals-send" data-id="${esc(w.id)}" ${ui.intervalsBusy?'disabled':''}>${ui.intervalsBusy ? 'Enviando…' : label}</button>`;
  }
  function intervalsStatus(w) {
    const sent=intervalsSent(w);
    if (!sent) return '';
    return `<div class="note ${intervalsIsCurrent(w)?'good':'warn'}">${intervalsIsCurrent(w)?
      'Sesión enviada a Intervals.icu. Abre Companion en el iPhone para actualizar el reloj.' :
      'Has modificado esta sesión después de enviarla. Vuelve a pulsar «Actualizar en el Apple Watch».'}</div>`;
  }
  async function intervalsRequest(route, body) {
    const token=await ensureStravaToken();
    if (!workerBase()) throw new Error('Configura primero el Worker en Ajustes.');
    const r=await fetch(workerBase()+route,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
      body:JSON.stringify(body)
    });
    let result;
    try {result=await r.json();} catch(_) {throw new Error('El Worker no devolvió JSON. Comprueba que has desplegado worker.js V8.');}
    if (!r.ok || !result.ok) throw new Error(result.error || `Error HTTP ${r.status} al conectar con Intervals.icu`);
    return result;
  }
  async function intervalsSend(id) {
    const w=wkById(id);
    if (!w || w.status!=='planned') {toast('Solo puedes enviar sesiones pendientes.');return;}
    if (ui.intervalsBusy) return;
    ui.intervalsBusy=true;render();
    try {
      const fingerprint=intervalsFingerprint(w);
      const result=await intervalsRequest('/intervals/workout',{
        id:w.id,date:w.date,title:w.title,items:w.items
      });
      S.intervals.sent[w.id]={eventId:result.id,externalId:result.externalId,
        fingerprint,sentAt:new Date().toISOString()};
      save();
      toast(result.structured?'Sesión enviada. Abre Companion en el iPhone.':'Enviada, pero comprueba los bloques en Intervals.icu.');
      if (!result.structured) ui.modal={type:'msg',title:'Revisa los bloques en Intervals.icu',
        body:'La API ha guardado el evento, pero no confirmó que reconociera los intervalos estructurados. Abre su calendario y comprueba que aparezcan antes de sincronizar con el reloj.'};
    } catch(e) {
      ui.modal={type:'msg',title:'No se pudo enviar a Intervals.icu',body:e.message};
    }
    ui.intervalsBusy=false;render();
  }
  async function intervalsRemove(ids) {
    if (!Array.isArray(ids) || !ids.length || ui.intervalsBusy) return;
    ui.intervalsBusy=true;render();
    try {
      await intervalsRequest('/intervals/delete',{ids});
      ids.forEach(id=>delete S.intervals.sent[id]);
      save();toast(ids.length===1?'Sesión retirada de Intervals.icu.':'Sesiones antiguas retiradas de Intervals.icu.');
    } catch(e) {ui.modal={type:'msg',title:'No se pudo retirar',body:e.message};}
    ui.intervalsBusy=false;render();
  }

  /* ---------------- V7: lectura objetiva de la semana ---------------- */
  function weeklyDigest(start) {
    const end = R.addDays(start, 7);
    const runs = S.runs.filter(r => r.date >= start && r.date < end);
    const sched = S.workouts.filter(w => w.date >= start && w.date < end && w.kind !== 'carreraObjetivo');
    const totalM = runs.reduce((a, r) => a + (r.distanceM || 0), 0);
    const totalS = runs.reduce((a, r) => a + (r.durationS || 0), 0);
    const feedbacks = runs.filter(r => r.feeling).map(r => r.feeling);
    return { start, runs, sessions: runs.length, km: totalM / 1000, min: totalS / 60,
      pace: totalM > 0 ? totalS / (totalM / 1000) : null,
      planned: sched.length, done: sched.filter(w => w.status === 'completed').length,
      pending: sched.filter(w => w.status === 'planned').length,
      skipped: sched.filter(w => w.status === 'skipped').length,
      adapted: sched.filter(w => w.status === 'discarded').length,
      avgRpe: feedbacks.length ? feedbacks.reduce((n, f) => n + (f.rpe || 0), 0) / feedbacks.length : null };
  }
  function weeklyProposal() {
    const now = R.today(), next = R.addDays(R.mondayOf(now), 7), end = R.addDays(next, 7);
    const all = S.workouts.filter(w => w.status === 'planned' && !w.manual && w.date >= next && w.date < end && w.kind !== 'carreraObjetivo');
    const upcomingRace = S.goal.kind !== 'maintain' && S.goal.date >= next && S.goal.date < end;
    const inLast14 = S.runs.filter(r => r.date >= R.addDays(now, -13) && r.date <= now);
    const prior14 = S.runs.filter(r => r.date >= R.addDays(now, -27) && r.date < R.addDays(now, -13));
    const minutes = arr => arr.reduce((n, r) => n + r.durationS / 60, 0);
    const last = inLast14.slice().sort((a, b) => b.date.localeCompare(a.date))[0];
    const feltHard = inLast14.some(r => r.feeling && (r.feeling.pain || r.feeling.rpe >= 8 || r.feeling.fatigue >= 4 || r.feeling.breathing >= 4));
    const feltComfortable = inLast14.filter(r => r.feeling && r.feeling.rpe <= 5 && r.feeling.breathing <= 2 && r.feeling.fatigue <= 2 && !r.feeling.pain).length;
    let factor = 1, reason;
    if (!all.length) reason = 'No hay sesiones automáticas pendientes para ajustar la próxima semana.';
    else if (feltHard) { factor = 0.9; reason = 'Hay señales de esfuerzo alto o molestias en las sensaciones recientes: sugiero reducir un 10 % los bloques de esfuerzo.'; }
    else if (upcomingRace) reason = 'La próxima semana incluye la carrera objetivo: mantengo la descarga prevista, sin aumentar carga.';
    else if (inLast14.length >= 3 && prior14.length >= 2 && feltComfortable >= 2 && minutes(inLast14) <= minutes(prior14) * 1.10) {
      factor = 1.05;
      reason = 'Has mantenido la regularidad con al menos dos salidas cómodas: propongo un aumento prudente de hasta el 5 % en bloques de esfuerzo.';
    } else reason = 'Aún no hay evidencia suficiente para subir o bajar la carga. Mantengo la planificación; tus salidas reales seguirán sustituyendo las previstas.';
    if (last && R.diffDays(last.date, now) < 2 && feltHard) reason += ' Evita encadenar sesiones exigentes sin recuperación.';
    return { week: next, ids: all.map(w => w.id), factor, reason, done: S.weeklyDecisions[next] || null };
  }
  function applyWeekDecision(accept) {
    const p = weeklyProposal();
    if (p.done || !p.ids.length) return false;
    let modified = 0;
    if (accept && Math.abs(p.factor - 1) > 0.001) {
      for (const id of p.ids) {
        const w = wkById(id);
        if (w && w.status === 'planned' && !w.manual && w.kind !== 'carreraObjetivo') {
          if (R.scale(w, p.factor, 'Revisión semanal aceptada: ' + p.reason)) modified++;
        }
      }
    }
    S.weeklyDecisions[p.week] = { accepted: accept, factor: accept ? p.factor : 1, modified, at: new Date().toISOString() };
    save(); return true;
  }
  function weeklyReportHtml() {
    const today = R.today(), monday = R.mondayOf(today), thisW = weeklyDigest(monday), prevW = weeklyDigest(R.addDays(monday, -7));
    const delta = prevW.sessions ? thisW.km - prevW.km : null;
    const p = weeklyProposal();
    const note = thisW.avgRpe == null ? 'Faltan sensaciones de algunas carreras: el esfuerzo no se deduce del ritmo.' : `Esfuerzo medio declarado: ${fmtMin(thisW.avgRpe)}/10.`;
    return `<div class="card"><h2>Tu semana · desde ${esc(R.longDate(monday))}</h2>
      <div class="stats"><div><b>${R.fmtKm(thisW.km)}</b><span>km</span></div><div><b>${Math.round(thisW.min)}</b><span>min</span></div><div><b>${thisW.sessions}</b><span>salidas</span></div><div><b>${thisW.pace ? R.fmtPace(thisW.pace) : '–'}</b><span>ritmo medio</span></div></div>
      <div class="sub" style="margin-top:10px">Plan: ${thisW.done} completadas · ${thisW.pending} pendientes · ${thisW.skipped} omitidas · ${thisW.adapted} reajustadas.</div>
      <div class="sub">Semana anterior: ${R.fmtKm(prevW.km)} km y ${prevW.sessions} carreras.${delta !== null ? ' Diferencia: ' + (delta > 0 ? '+' : '') + R.fmtKm(delta) + ' km.' : ''}</div>
      <div class="sub" style="margin-top:8px">${esc(note)}</div></div>
      <div class="card"><h2>Propuesta para la próxima semana</h2><div class="sub">Semana del ${R.longDate(p.week)} · ${p.ids.length} sesión(es) automática(s).</div>
      <p>${esc(p.reason)}</p>${p.done ? `<div class="note">${p.done.accepted ? 'Propuesta aceptada' : 'Propuesta descartada'} · ${p.done.modified || 0} sesiones modificadas.</div>` :
       p.ids.length ? `<div class="btns"><button class="primary" data-act="weekly-accept">Aceptar propuesta</button><button data-act="weekly-decline">Mantener mi plan</button></div>` : ''}
      <div class="sub small" style="margin-top:8px">El sistema no modifica sesiones creadas por ti. Los cambios de carga requieren aceptación; las salidas reales siguen adaptando el calendario según las reglas de la V6.</div></div>`;
  }
  function forecastTrend() {
    const days = [...new Set(S.runs.filter(r => r.date).map(r => r.date))].sort().slice(-120);
    return days.map(date => {
      const ts = new Date(date + 'T23:59:59').getTime();
      const past = S.runs.filter(r => Date.parse(r.start) <= ts);
      const p = R.predictRace(5, past, ts);
      return p.ok ? { x: ts, y: p.mid / 60, lo: p.low / 60, hi: p.high / 60, confidence: p.confidence } : null;
    }).filter(Boolean).slice(-20);
  }
  function coachDataContext() {
    const today = R.today(), p = S.profile, f = fitNow();
    const all = sortedRuns().filter(r => r.date && r.distanceM > 0 && r.durationS > 0);
    const currentRuns = all.filter(r => r.date >= R.addDays(today, -41) && r.date <= today);
    const longestTotal = currentRuns.reduce((best, r) => !best || r.durationS > best.durationS ? r : best, null);
    const latest = currentRuns.length ? currentRuns[0] : null;
    const plannedFor = r => r.planned ? {
      originalDate: r.planned.date, title: r.planned.title,
      plannedMinutes: Math.round(r.planned.durationS / 60), plannedKm: +(r.planned.distanceM / 1000).toFixed(2)
    } : null;
    return {
      contextVersion: '7.3', today,
      dataRules: [
        'Para evaluar la forma ACTUAL solo se usan carreras de los ultimos 42 dias; las anteriores se excluyen del analisis deportivo actual.',
        'El perfil se recalcula de forma automatica usando solo datos recientes y no esta condicionado por las marcas antiguas.',
        'Duracion total o moving_time NO es igual a minutos continuos sin caminar; la base del plan es una estimacion conservadora.',
        'Un ritmo mas rapido no demuestra por si solo mejor forma si cambian distancia o esfuerzo.',
        'El coach puede recomendar ajustes, pero cualquier modificacion de sesiones desde el chat requiere accion del usuario.',
        'Cada sesion futura tiene una meta orientativa de RPE por tipo y duracion. Compara despues lo esperado y lo observado. RPE previsto es un rango de carga, no una prediccion de sensaciones.'
      ],
      goal: { title: S.goal.title, date: S.goal.date, distanceKm: S.goal.distanceKm,
        daysUntil: Math.max(0, R.diffDays(today, S.goal.date)) },
      runner: {
        profile: { source: f.fromData ? 'automatico: ultimos 42 dias' : 'provisional: pocos datos recientes',
          easyPaceMinKm: R.fmtPace(p.easyPace), resistanceBaseEstimateMin: p.continuousMin,
          resistanceBaseIsVerifiedContinuous: false, weeklySessions: p.weeklySessions,
          confidence: f.confidence, evidenceRuns: f.runsConsidered },
        longestRecordedSessionLast42Days: longestTotal ? { date: longestTotal.date,
          durationMin: +(longestTotal.durationS / 60).toFixed(1), km: +(longestTotal.distanceM / 1000).toFixed(2),
          note: 'Minutos de movimiento, NO demuestra continuidad sin caminar.' } : null
      },
      currentEvidence: { analysisWindowDays: 42, currentRunCount: currentRuns.length,
        olderRunCountExcludedFromCurrentFitness: all.length - currentRuns.length,
        mostRecent: latest ? {date: latest.date, km: +(latest.distanceM/1000).toFixed(2),
          paceMinKm: R.fmtPace(R.avgPace(latest))} : null },
      weeks: [weeklyDigest(R.mondayOf(today)), weeklyDigest(R.addDays(R.mondayOf(today), -7))]
        .map(w => ({ week:w.start, km:+w.km.toFixed(2), runs:w.sessions, minutes:Math.round(w.min), avgRpe:w.avgRpe, pending:w.pending })),
      recentRuns: currentRuns.slice(0,8).map(r => ({ date:r.date, km:+(r.distanceM/1000).toFixed(2),
        minutes:+(r.durationS/60).toFixed(1), paceMinKm:R.fmtPace(R.avgPace(r)),
        reportedFeeling:r.feeling ? {rpe:r.feeling.rpe, breathing:r.feeling.breathing,
          fatigue:r.feeling.fatigue, pain:!!r.feeling.pain, couldContinue:!!r.feeling.canContinue} : null,
        originalPlan:plannedFor(r), expectedVsActual:r.planned ? (()=>{const o=sessionOutcome(r);return {
          expectedRpeRange:[o.e.rpeMin,o.e.rpeMax], expectedMinutes:o.e.minutes,
          actualRpe:r.feeling?.rpe??null, result:o.label,
          reconstructedFromPlan:o.retrospective};})() : null,
        automaticPlanChanges:(r.autoChanges||[]).length })),
      upcoming: S.workouts.filter(w => w.status==='planned' && w.date >= today && w.date < R.addDays(today,14))
        .sort(byDate).slice(0,7).map(w => ({ date:w.date, title:w.title,
          minutes:Math.round(R.totalMin(w.items)), approxKm:+R.distKm(w.items).toFixed(2), type:w.kind,
          origin:w.manual?'manual':'automatic', expectedRpe:expectedEffort(w.kind),
          expectedPurpose:sessionExpectation(w).purpose,
          lastAdjustment:(w.explanation||'').slice(0,130) })),
      forecast5K:(() => {const x=R.predictRace(5,S.runs);return x.ok?
        {time:R.fmtDur(x.mid),confidence:x.confidence,method:'Formula estimativa; no es garantia de tiempo de carrera.'}:
        {available:false,reason:x.reason};})()
    };
  }

  /* ---- Inicio ---- */
  function vHome() {
    const t = R.today(), g = S.goal, days = Math.max(R.diffDays(t, g.date), 0), maintain = g.kind === 'maintain';
    const closed = S.goals.filter(x => (x.status === 'achieved' || x.status === 'missed') && !x.seen).slice(-1)[0];
    const fit = fitNow(), pf = S.profile;
    const review = fit.fromData; // panel de perfil automatico, no pide actualizar datos manuales
    const next = S.workouts.filter(w => w.status === 'planned' && w.date >= t).sort(byDate)[0];
    const ws = R.mondayOf(t), we = R.addDays(ws, 7), wr = S.runs.filter(r => r.date >= ws && r.date < we);
    const due = S.workouts.filter(w => w.date >= ws && w.date < we && w.status !== 'discarded' &&
      (w.date <= t || (w.status === 'completed' && w.completedOn && w.completedOn <= t)));
    const comp = due.length ? Math.round(due.filter(w => w.status === 'completed').length / due.length * 100) + ' %' : '–';
    const pending = sortedRuns().find(r => !r.feeling);
    const latest = sortedRuns()[0];
    const rec = R.recovery(S.runs);
    return `<div class="row between"><h1>Inicio</h1><button class="link" data-act="tab" data-k="set" aria-label="Ajustes">⚙️ Ajustes</button></div>
    ${closed ? closedCard(closed) : ''}
    ${maintain
      ? `<div class="card row between"><div><h3>Modo mantenimiento</h3><div class="sub">Sin carrera fijada: semanas variadas con una más suave cada cuatro. El plan se renueva solo.</div></div><button data-act="goals-open">Objetivos</button></div>`
      : `<div class="card row between"><div><h3>${esc(g.title)}</h3><div class="sub">${R.longDate(g.date)}${g.kind === 'time' && g.targetTimeSec ? ' · objetivo ' + R.fmtDur(g.targetTimeSec) : ''}</div><button class="link" data-act="goals-open">Objetivos</button></div><div style="text-align:center"><div class="big">${days}</div><div class="sub small">días</div></div></div>`}
    ${review ? `<div class="card"><h2>Mi perfil, calculado automáticamente</h2>
      <div class="stats"><div><b>${R.fmtPace(fit.easyPace)}</b><span>ritmo cómodo orientativo</span></div><div><b>${fit.baseMin}</b><span>min de base estimada</span></div><div><b>${Math.round(fit.longestMovingMin)}</b><span>min máx. en movimiento</span></div><div><b>${fit.runsConsidered}</b><span>salidas recientes</span></div></div>
      <div class="sub" style="margin-top:8px">Solo las carreras de los últimos 42 días influyen en tu forma actual. Confianza ${fit.confidence}. El tiempo continuo es una estimación conservadora, no una medición de minutos sin caminar.</div>
      <div class="btns"><button data-act="replan-ok">Recalcular mis sesiones futuras</button></div></div>` :
      `<div class="card"><h2>Mi perfil</h2><div class="sub">Faltan salidas recientes para actualizarlo automáticamente. No tomaré las carreras del año pasado como referencia de tu forma actual.</div></div>`}
    ${S.notes && S.notes.length ? S.notes.map(n => `<div class="note warn">${esc(n)}</div>`).join('') : ''}
    <div class="card"><h2>Próximo entrenamiento</h2>${next
      ? `<div data-act="wk-open" data-id="${next.id}" style="cursor:pointer"><h3>${esc(next.title)}</h3><div class="sub">${R.longDate(next.date)}</div><p style="margin:6px 0">${esc(next.objective)}</p><div class="sub">${wkSummary(next)}</div></div>${sessionExpectationHtml(next)}`
      : '<div class="sub">No hay sesiones pendientes.</div>'}</div>
    <div class="card"><h2>Recuperación estimada</h2><h3>${rec.level}</h3><div class="sub">${esc(rec.detail)}</div></div>
    ${latest ? `<div class="card" data-act="run-open" data-id="${latest.id}" style="cursor:pointer"><h2>Última carrera · Informe del coach</h2><h3>${esc(runReview(latest).title)}</h3><div class="sub">${runLine(latest)}</div><div class="sub" style="margin-top:6px">${esc(runReview(latest).planText)}</div><div class="btns"><button class="primary" data-act="run-open" data-id="${latest.id}">${latest.feeling ? 'Ver valoración y adaptación' : 'Ver informe y valorar sensaciones'}</button></div></div>` : ''}
    ${pending && latest && pending.id !== latest.id ? `<div class="card" data-act="run-open" data-id="${pending.id}" style="cursor:pointer"><b>Tienes una carrera pendiente de valorar</b><div class="sub">${runLine(pending)} · ${pending.date}</div></div>` : ''}
    <div class="card"><h2>Tu semana · resumen automático</h2><div class="stats"><div><b>${R.fmtKm(wr.reduce((s, r) => s + r.distanceM / 1000, 0))}</b><span>km</span></div><div><b>${Math.round(wr.reduce((s, r) => s + r.durationS / 60, 0))}</b><span>min</span></div><div><b>${wr.length}</b><span>carreras</span></div><div><b>${comp}</b><span>cumplimiento</span></div></div>
      <div class="btns"><button class="primary" data-act="week-report">Ver informe y propuesta</button></div></div>
    <div class="card"><h2>Strava</h2>${stravaCard()}</div>
    ${storageOk ? '' : '<div class="note bad">No puedo guardar datos en este navegador (¿modo privado?). Lo que hagas se perderá al cerrar.</div>'}`;
  }
  function closedCard(g) {
    const res = g.status === 'achieved'
      ? `<b class="good">¡Objetivo conseguido!</b><div class="sub">${g.kind === 'time' || g.resultSec ? 'Tiempo: ' + R.fmtDur(g.resultSec) + ' · ' : ''}${esc(g.title)}. Ya estás en modo mantenimiento; cuando quieras, elige el siguiente reto.</div>`
      : `<b>Objetivo no conseguido</b><div class="sub">${g.noRun ? 'No consta ninguna carrera de esa distancia en la fecha (¿sincronizaste con Strava?).' : (g.resultSec ? 'Tiempo: ' + R.fmtDur(g.resultSec) + ' (objetivo ' + R.fmtDur(g.targetTimeSec) + ').' : '')} Sin drama: pasas a modo mantenimiento y puedes elegir otro objetivo.</div>`;
    return `<div class="card">${res}<div class="btns"><button class="primary" data-act="goals-open">Elegir siguiente objetivo</button><button data-act="goal-seen" data-id="${g.id}">Entendido</button></div></div>`;
  }
  function stravaCard() {
    const st = S.strava;
    if (!st.worker) return '<div class="sub">Sin configurar. En Ajustes puedes conectar Strava (hace falta la guía de la carpeta). Mientras tanto, puedes añadir carreras a mano en Progreso.</div><div class="btns"><button data-act="tab" data-k="set">Ir a Ajustes</button></div>';
    if (!st.tokens) return '<div class="sub">Falta autorizar tu cuenta de Strava.</div><div class="btns"><button class="primary" data-act="strava-connect">Conectar Strava</button></div>';
    return `<div class="sub">${esc(ui.stravaMsg || 'Conectado.')}${st.lastSync ? ' Última sincronización: ' + new Date(st.lastSync).toLocaleString('es-ES') : ''}</div><div class="btns"><button class="primary" data-act="strava-sync" ${ui.busy ? 'disabled' : ''}>${ui.busy ? 'Sincronizando…' : 'Sincronizar ahora'}</button><button data-act="tab" data-k="set">Ajustes de Strava</button></div>`;
  }

  /* ---- Calendario ---- */
  function vCal() {
    const t = R.today(), goalLine = `<div class="sub" style="color:var(--accent);margin:-4px 2px 8px">${S.goal.kind === 'maintain' ? 'Modo mantenimiento' : Math.max(R.diffDays(t, S.goal.date), 0) + ' días hasta «' + esc(S.goal.title) + '»'}</div>`;
    const seg = `<div class="seg"><button data-act="cal-mode" data-m="week" class="${ui.calMode === 'week' ? 'on' : ''}">Semana</button><button data-act="cal-mode" data-m="month" class="${ui.calMode === 'month' ? 'on' : ''}">Mes</button></div>`;
    let head, body;
    if (ui.calMode === 'week') {
      const ws = R.mondayOf(ui.calAnchor), we = R.addDays(ws, 6), a = R.parseDate(ws), b = R.parseDate(we);
      head = `${a.getDate()} ${R.MONTHS[a.getMonth()].slice(0, 3)} – ${b.getDate()} ${R.MONTHS[b.getMonth()].slice(0, 3)}`;
      const real = S.runs.filter(r => r.date >= ws && r.date <= we);
      const pending = S.workouts.filter(w => w.status === 'planned' && w.date >= ws && w.date <= we);
      const moved = real.filter(r => r.planned && r.planned.date !== r.date);
      const weeklyNote = `<div class="card"><h2>Resumen de la semana</h2><div class="sub">${real.length} salida(s) realizadas · ${pending.length} sesión(es) pendientes.</div>
        ${moved.map(r => `<div class="sub small" style="margin-top:6px">La carrera del ${R.longDate(r.date)} sustituye la sesión prevista para el ${R.longDate(r.planned.date)}.</div>`).join('')}
        <div class="sub small" style="margin-top:6px">El plan restante solo se reajusta si hay muy poca recuperación o una salida mucho más larga de lo previsto.</div></div>`;
      body = weeklyNote + `<div class="card">${Array.from({ length: 7 }, (_, i) => dayHtml(R.addDays(ws, i))).join('')}</div>`;
    } else {
      const d = R.parseDate(ui.calAnchor), first = new Date(d.getFullYear(), d.getMonth(), 1), n = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      head = `${R.MONTHS[d.getMonth()]} ${d.getFullYear()}`;
      let cells = ['L', 'M', 'X', 'J', 'V', 'S', 'D'].map(x => `<div class="h">${x}</div>`).join('') + '<div></div>'.repeat((first.getDay() + 6) % 7);
      for (let i = 1; i <= n; i++) {
        const ds = R.fmtDate(new Date(d.getFullYear(), d.getMonth(), i));
        // Mes: las carreras reales también deben marcarse aunque no existiera una sesión planificada.
        // Un punto verde por día con carrera real (sin duplicar la sesión vinculada al plan).
        const hasRealRun = S.runs.some(r => r.date === ds);
        const hasCompletedPlan = S.workouts.some(w => w.date === ds && w.status === 'completed' && !w.runId);
        const pendingDots = S.workouts.filter(w => w.date === ds && w.status === 'planned')
          .map(() => '<i style="background:var(--accent)"></i>').join('');
        const dots = pendingDots
          + (hasRealRun || hasCompletedPlan ? '<i style="background:var(--good)"></i>' : '')
          + (S.extras.some(e => e.date === ds) ? '<i style="background:#3b82f6"></i>' : '');
        cells += `<button class="c ${ui.calSel === ds ? 'sel' : ''} ${S.unavailable.includes(ds) ? 'nope' : ''}" data-act="cal-sel" data-d="${ds}">${i}<div class="dots">${dots}</div></button>`;
      }
      body = `<div class="card"><div class="grid7">${cells}</div></div><div class="card">${dayHtml(ui.calSel)}</div>`;
    }
    return `<h1>Calendario</h1>${seg}<div class="row between" style="margin-bottom:8px"><button data-act="cal-prev">‹</button><b style="text-transform:capitalize">${head}</b><button data-act="cal-next">›</button></div>${goalLine}${body}
    <div class="sub small" style="margin:0 4px 8px">🚫 marcar el día como no disponible (reprograma o descarta lo que haya) · ✅ volver a disponible · ＋ añadir otra actividad (pádel…). Para mover una sesión, entra en ella y pulsa «Mover». En el mes: ● naranja plan pendiente, ● verde carrera realizada, ● azul otra actividad.</div>`;
  }
  function dayHtml(ds) {
    const t = R.today(), blocked = S.unavailable.includes(ds), d = R.parseDate(ds);
    const ws = S.workouts.filter(w => w.date === ds && (w.status === 'planned' || w.status === 'skipped' || (w.status === 'completed' && !w.runId))).map(w =>
      `<div class="item" data-act="wk-open" data-id="${w.id}" style="cursor:pointer"><span class="dot" style="background:${w.status === 'completed' ? 'var(--good)' : w.status === 'skipped' ? 'var(--sub)' : 'var(--accent)'}"></span><div class="grow"><b>${esc(w.title)}</b><div class="sub small">${wkSummary(w)}${w.status === 'skipped' ? ' · no realizada' : ''}${intervalsSent(w) && w.status === 'planned' ? (intervalsIsCurrent(w) ? ' · Enviada a Intervals' : ' · Actualizar en Intervals') : ''}</div></div>›</div>`).join('');
    // Mostrar cada carrera real importada desde Strava o introducida a mano.
    // No se pierde ninguna carrera por no coincidir con una fecha de entrenamiento planificado.
    const rs = S.runs.filter(r => r.date === ds).sort((a, b) => (a.start || '').localeCompare(b.start || '')).map(r =>
      `<div class="item" data-act="run-open" data-id="${r.id}" style="cursor:pointer"><span class="dot" style="background:var(--good)"></span><div class="grow"><b>${esc(r.name || 'Carrera realizada')}</b><div class="sub small">${runLine(r)} · ${r.source === 'strava' ? 'Strava' : 'Registro manual'}${r.workoutId ? ' · Sustituye sesión del plan' : ''}</div></div>›</div>`).join('');
    const es = S.extras.filter(e => e.date === ds).map(e => `<div class="item"><span class="dot" style="background:#3b82f6"></span><div class="grow">${esc(e.title)} · ${e.durationMin} min</div><button class="link" data-act="extra-del" data-id="${e.id}">Borrar</button></div>`).join('');
    return `<div class="day"><div class="hd"><span class="${ds === t ? 'today' : ''}">${R.WEEKDAYS[d.getDay()]} ${d.getDate()} ${blocked ? '🚫' : ''}</span>
      <span><button class="link" aria-label="${blocked ? 'Marcar disponible' : 'Marcar no disponible'}" data-act="toggle-unavail" data-d="${ds}">${blocked ? '✅' : '🚫'}</button><button class="link" aria-label="Añadir actividad" data-act="extra-open" data-d="${ds}">＋</button></span></div>
      ${ws}${rs}${es}${!ws && !rs && !es ? `<div class="sub small">${blocked ? 'No disponible' : 'Libre'}</div>` : ''}</div>`;
  }

  /* ---- Entrenar ---- */
  const TEMPLATES = [
    ['Ejemplo 3-4-9-2-9-5 (ritmos en min/km)', 'carreraContinua', '3 min calentando a 10:00, 4 min progresión a 9:00, 9 min a 8:00, 2 min recuperación a 10:00, 9 min a 8:00, 5 min enfriando a 12:00'],
    ['Correr y caminar 5 × 2 min', 'intervalos', '5 min calentando, 5x2 min a 7:50 con 2 min caminando, 5 min enfriando'],
    ['Rodaje suave 20 min', 'rodajeSuave', '5 min calentando, 20 min a 8:00, 5 min enfriando'],
    ['Recuperación 15 min', 'recuperacion', '15 min a 8:45'],
    ['Intervalos cortos 6 × 30 s', 'intervalos', '8 min calentando, 6x30 s a 7:00 con 90 s caminando, 5 min enfriando'],
    ['Prueba de rendimiento', 'prueba', '10 min calentando, 6 min a 7:30, 8 min enfriando'],
  ];
  function vTrain() {
    const t = R.today();
    const w = S.workouts.find(x => x.date === t && x.status === 'planned') || S.workouts.filter(x => x.status === 'planned' && x.date >= t).sort(byDate)[0];
    const c = ui.create;
    return `<h1>Entrenar</h1>
    ${w ? `<div class="card"><h2>${w.date === t ? 'Sesión de hoy' : 'Próxima sesión'}</h2><h3>${esc(w.title)}</h3><div class="sub">${R.longDate(w.date)} · ${wkSummary(w)}</div><div style="margin-top:8px">${blocksHtml(w.items)}</div>
      ${w.notes ? `<div class="note">${esc(w.notes)}</div>` : ''}${intervalsStatus(w)}<div class="btns"><button data-act="wk-open" data-id="${w.id}">Ver / editar</button>${intervalsButton(w)}</div></div>${sessionExpectationHtml(w)}` : '<div class="card sub">No hay sesiones pendientes.</div>'}
    <div class="card"><h2>Crear sesión escribiendo una frase</h2>
      <div class="sub small">Ejemplos: «5x2 min a 7:30 con 2 min caminando» · «10 min calentando, 20 min a 8:00, 5 min enfriando» · «6x30 s a 7:00 con 90 s caminando». El ritmo se da en min:seg o en km/h («a 9 km/h»). Sin ritmo, usa el tuyo cómodo (${R.fmtPace(S.profile.easyPace)}).</div>
      <textarea data-ui="create.text" placeholder="Escribe la sesión…">${esc(c.text)}</textarea>
      <div class="row" style="margin-top:8px"><select data-ui="create.kind">${Object.entries(R.KINDS).map(([k, v]) => `<option value="${k}" ${c.kind === k ? 'selected' : ''}>${v}</option>`).join('')}</select><input type="date" data-ui="create.date" value="${c.date}"></div>
      <div class="btns"><button data-act="create-preview">Previsualizar</button>${c.preview && c.preview.items.length ? '<button class="primary" data-act="create-save">Guardar sesión</button>' : ''}</div>
      ${c.preview ? `<div style="margin-top:8px">${c.preview.errors.map(e => `<div class="note bad">${esc(e)}</div>`).join('')}${c.preview.items.length ? `<div class="sub small">${Math.round(R.totalMin(c.preview.items))} min · ≈ ${R.fmtKm(R.distKm(c.preview.items))} km</div>${blocksHtml(c.preview.items)}` : ''}</div>` : ''}
      <h2 style="margin-top:14px">Plantillas (rellenan la frase)</h2>
      ${TEMPLATES.map((x, i) => `<div class="item"><button class="link grow" style="text-align:left" data-act="tpl" data-i="${i}">${esc(x[0])}</button></div>`).join('')}
    </div>
    <div class="card"><h2>Cómo ejecutarla hoy</h2><div class="sub">Pulsa «Enviar al Apple Watch». Después abre Intervals.icu Companion en el iPhone: sincronizará el entrenamiento estructurado con la app Entreno del reloj. Los avisos los gestiona Apple Watch. Al terminar, Strava enviará los datos reales a Running Coach.</div></div>`;
  }

  /* ---- Progreso ---- */
  function lineChart(pts, fmt, color = 'var(--accent)', what = 'carreras') {
    if (pts.length < 2) return `<div class="sub small">Necesito al menos 2 ${what} en este periodo para dibujar la gráfica.</div>`;
    const W = 320, H = 130, pl = 34, pr = 8, pt = 8, pb = 18;
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), pad = (y1 - y0) * 0.15 || 1;
    const X = v => pl + (x1 === x0 ? 0.5 : (v - x0) / (x1 - x0)) * (W - pl - pr), Y = v => pt + (1 - (v - (y0 - pad)) / (y1 - y0 + 2 * pad)) * (H - pt - pb);
    const path = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');
    const d0 = new Date(x0).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }), d1 = new Date(x1).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" class="chartwrap"><path d="${path}" fill="none" stroke="${color}" stroke-width="2.5"/>${pts.map(p => `<circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="3.5" fill="${color}"/>`).join('')}
      <text x="2" y="${Y(y1) + 3}">${fmt(y1)}</text><text x="2" y="${Y(y0) + 3}">${fmt(y0)}</text><text x="${pl}" y="${H - 3}">${d0}</text><text x="${W - pr}" y="${H - 3}" text-anchor="end">${d1}</text></svg>`;
  }
  function barChart(bars, fmt) {
    if (!bars.length) return '';
    const W = 320, H = 130, pl = 30, pb = 18, mx = Math.max(...bars.map(b => b.y), 0.1), bw = (W - pl - 6) / bars.length;
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" class="chartwrap">${bars.map((b, i) => { const h = b.y / mx * (H - pb - 14); return `<rect x="${pl + i * bw + 3}" y="${H - pb - h}" width="${Math.max(bw - 6, 3)}" height="${h}" rx="3" fill="var(--accent)"/><text x="${pl + i * bw + bw / 2}" y="${H - 5}" text-anchor="middle">${b.l}</text>`; }).join('')}<text x="2" y="14">${fmt(mx)}</text></svg>`;
  }
  function vProg() {
    const segs = [['runs', 'Carreras'], ['weight', 'Peso'], ['act', 'Actividad'], ['pred', 'Previsión']];
    const bar = `<div class="seg">${segs.map(([k, l]) => `<button data-act="pseg" data-k="${k}" class="${ui.pseg === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    if (ui.pseg === 'weight') return `<h1>Progreso</h1>${bar}${vWeight()}`;
    if (ui.pseg === 'act') return `<h1>Progreso</h1>${bar}${vActivity()}`;
    if (ui.pseg === 'pred') return `<h1>Progreso</h1>${bar}${vPred()}`;
    return vRuns(bar);
  }
  function vWeight() {
    const t = R.today(), ws = S.weights.slice().sort((a, b) => a.date.localeCompare(b.date)), st = R.weightStats(S.weights, t);
    const chg = v => v == null ? '–' : (v > 0 ? '+' : '') + (Math.round(v * 10) / 10).toString().replace('.', ',') + ' kg';
    return `<div class="card"><h2>Registrar peso</h2><div class="row"><input id="wKg" type="number" inputmode="decimal" step="0.1" placeholder="kg" class="grow"><input id="wDate" type="date" value="${t}"></div>
      <div class="btns"><button class="primary" data-act="wt-save">Guardar</button></div>
      <div class="sub small" style="margin-top:6px">Se introduce a mano: una web no puede leer Apple Salud. Al guardar el más reciente, se actualiza el peso de tu perfil.</div></div>
      ${st ? `<div class="card"><h2>Evolución</h2>${lineChart(ws.map(w => ({ x: Date.parse(w.date), y: w.kg })), v => v.toFixed(1), 'var(--accent)', 'registros de peso')}
        <div class="stats"><div><b>${fmtMin(st.current)}</b><span>kg actual</span></div><div><b>${chg(st.change30)}</b><span>30 días</span></div><div><b>${chg(st.change90)}</b><span>90 días</span></div></div>
        <div class="sub small">Mín. ${fmtMin(st.min)} kg · máx. ${fmtMin(st.max)} kg. El peso fluctúa día a día; fíjate en la tendencia de semanas, no en un dato suelto.</div></div>
      <div class="card"><h2>Registros</h2>${ws.slice().reverse().slice(0, 30).map(w => `<div class="item"><div class="grow">${R.longDate(w.date)} · <b>${fmtMin(w.kg)} kg</b></div><button class="link" data-act="wt-del" data-d="${w.date}">Borrar</button></div>`).join('')}</div>`
      : '<div class="card sub">Aún no hay registros de peso.</div>'}`;
  }
  function vActivity() {
    const t = R.today(), wk0 = R.mondayOf(t), weeks = Array.from({ length: 8 }, (_, i) => R.addDays(wk0, -7 * (7 - i)));
    const rows = weeks.map(w0 => {
      const w1 = R.addDays(w0, 7), run = S.runs.filter(r => r.date >= w0 && r.date < w1).reduce((s, r) => s + r.durationS / 60, 0), oth = S.extras.filter(e => e.date >= w0 && e.date < w1).reduce((s, e) => s + (e.durationMin || 0), 0);
      return { w0, run, oth };
    });
    const bars = rows.map(r => ({ l: R.parseDate(r.w0).getDate() + '/' + (R.parseDate(r.w0).getMonth() + 1), y: r.run + r.oth }));
    const recent = S.extras.filter(e => e.date <= t).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 12);
    return `<div class="card"><h2>Minutos de actividad por semana</h2>${barChart(bars, v => Math.round(v) + ' min')}<div class="sub small">Carrera + otras actividades (pádel, bici… las que lleguen de Strava o añadas tú).</div></div>
      <div class="card"><h2>Detalle</h2>${rows.slice().reverse().map(r => `<div class="row between small"><span>Semana del ${R.parseDate(r.w0).getDate()}/${R.parseDate(r.w0).getMonth() + 1}</span><span>${Math.round(r.run)} min correr · ${Math.round(r.oth)} min otras</span></div>`).join('')}</div>
      <div class="card"><h2>Otras actividades recientes</h2>${recent.length ? recent.map(e => `<div class="item"><div class="grow">${R.longDate(e.date)} · ${esc(e.title)} · ${e.durationMin} min${e.stravaId ? ' (Strava)' : ''}</div></div>`).join('') : '<div class="sub">Ninguna. Sincroniza con Strava o añádelas con ＋ en el calendario.</div>'}</div>
      <div class="note">Pasos, pulsaciones en reposo y VO₂ máx. no están disponibles en esta versión web (viven en Apple Salud, que una web no puede leer).</div>`;
  }
  function vPred() {
    const fit = fitNow(), g = S.goal, ds = [5, 10]; if (g.distanceKm > 0 && !ds.includes(g.distanceKm)) ds.push(g.distanceKm);
    const cards = ds.map(d => { const p = R.predictRace(d, S.runs);
      return `<div class="card"><h2>${R.fmtKm(d)} km</h2>${p.ok ? `<h3>${R.fmtDur(p.mid)}</h3><div class="sub">Horquilla: ${R.fmtDur(p.low)} – ${R.fmtDur(p.high)} · confianza ${p.confidence.toLowerCase()}</div><div class="sub small" style="margin-top:6px">${esc(p.basis)}</div>` : `<div class="sub">Sin previsión: ${esc(p.reason)}</div>`}</div>`; }).join('');
    const asc = sortedRuns().slice().reverse();
    const opt = sel => `<option value="">Elige…</option>` + asc.map(r => `<option value="${r.id}" ${sel === r.id ? 'selected' : ''}>${r.date} · ${R.fmtKm(r.distanceM / 1000)} km</option>`).join('');
    const a = runById(ui.cmpA), b = runById(ui.cmpB);
    let cmp = '';
    if (a && b && a.id !== b.id) { const [o, n] = a.start <= b.start ? [a, b] : [b, a], c = R.compareRuns(o, n); cmp = `<div style="margin-top:8px">${c.lines.map(l => `<div class="small">${esc(l)}</div>`).join('')}<div class="note">${esc(c.verdict)}</div><div class="sub small">Compara la más antigua con la más reciente.</div></div>`; }
    const history = forecastTrend();
    const historyCard = `<div class="card"><h2>Evolución de tu previsión de 5 km</h2>
      ${history.length >= 2 ? lineChart(history, v => R.fmtDur(v * 60), 'var(--accent)', 'estimaciones') : '<div class="sub">Todavía faltan carreras para mostrar una tendencia de previsión fiable.</div>'}
      ${history.length ? `<div class="sub small">Última estimación: ${R.fmtDur(history[history.length-1].y*60)} · confianza ${history[history.length-1].confidence.toLowerCase()}.</div>` : ''}
      <div class="sub small">Cada punto utiliza únicamente las carreras registradas hasta esa fecha. Las previsiones son orientativas y dependen del tipo de sesión y del esfuerzo.</div></div>`;
    return `<div class="card"><h2>Mi forma</h2><div class="sub">${esc(fit.note)}</div>${fit.weeklyMinutes ? `<div class="sub small">Media de las últimas 4 semanas: ${Math.round(fit.weeklyMinutes)} min de carrera por semana.</div>` : ''}</div>${historyCard}${cards}
      <div class="card"><h2>Comparar dos carreras</h2><div class="row"><select data-ui="cmpA">${opt(ui.cmpA)}</select><select data-ui="cmpB">${opt(ui.cmpB)}</select></div>${cmp}</div>
      <div class="note">Las previsiones salen de tus entrenos, no de una carrera a tope: son orientativas. Con pocos datos la app prefiere no dar cifra.</div>`;
  }
  function vRuns(bar) {
    const all = sortedRuns(), from = ui.period ? R.addDays(R.today(), -ui.period) : '0000-00-00';
    const inP = all.filter(r => r.date >= from), asc = inP.slice().reverse();
    const wk = {}; inP.forEach(r => { const k = R.mondayOf(r.date); wk[k] = (wk[k] || 0) + r.distanceM / 1000; });
    const bars = Object.keys(wk).sort().slice(-12).map(k => ({ l: R.parseDate(k).getDate() + '/' + (R.parseDate(k).getMonth() + 1), y: wk[k] }));
    const hr = asc.filter(r => r.avgHR).map(r => ({ x: Date.parse(r.start), y: r.avgHR }));
    const best5 = all.map(r => { const s = (r.splits || []).filter(x => !x.partial); return s.length >= 5 ? s.slice(0, 5).reduce((a, x) => a + x.paceSec, 0) : null; }).filter(Boolean);
    const hist = all.filter(r => ui.filter === 'all' || (ui.filter === 'free' ? !r.workoutId : (wkById(r.workoutId) || {}).kind === ui.filter));
    return `<h1>Progreso</h1>${bar}
    <div class="seg">${[[7, '7 d'], [30, '30 d'], [90, '90 d'], [0, 'Todo']].map(([n, l]) => `<button data-act="period" data-n="${n}" class="${ui.period === n ? 'on' : ''}">${l}</button>`).join('')}</div>
    ${!inP.length ? '<div class="card sub">Aún no hay carreras en este periodo. Sincroniza con Strava desde Inicio o añade una a mano.</div>' : `
    <div class="card"><h2>Distancia semanal (km)</h2>${barChart(bars, v => v.toFixed(1))}</div>
    <div class="card"><h2>Ritmo medio por carrera (min/km)</h2>${lineChart(asc.map(r => ({ x: Date.parse(r.start), y: R.avgPace(r) })), v => R.fmtPace(v))}<div class="sub small">Más bajo = más rápido.</div></div>
    ${hr.length ? `<div class="card"><h2>Frecuencia cardíaca media (lpm)</h2>${lineChart(hr, v => Math.round(v), '#e5484d')}</div>` : ''}
    <div class="card"><h2>Resumen</h2><div class="row between"><span>Carreras</span><b>${inP.length}</b></div><div class="row between"><span>Distancia total</span><b>${R.fmtKm(inP.reduce((s, r) => s + r.distanceM / 1000, 0))} km</b></div><div class="row between"><span>Mejor 5 km (con parciales)</span><b>${best5.length ? R.fmtDur(Math.min(...best5)) : 'Sin datos aún'}</b></div></div>`}
    <div class="card"><h2>Historial</h2><div class="row"><select data-ui="filter" class="grow"><option value="all">Todas</option><option value="free" ${ui.filter === 'free' ? 'selected' : ''}>Libres</option>${Object.entries(R.KINDS).map(([k, v]) => `<option value="${k}" ${ui.filter === k ? 'selected' : ''}>${v}</option>`).join('')}</select><button data-act="run-add-open">+ A mano</button></div>
      ${hist.length ? hist.map(r => `<div class="item" data-act="run-open" data-id="${r.id}" style="cursor:pointer;border-bottom:1px solid var(--line)"><div class="grow"><b>${new Date(r.start).toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' })}</b><div class="sub small">${runLine(r)}${r.feeling ? '' : ' · sin sensaciones'}</div></div>›</div>`).join('') : '<div class="sub" style="margin-top:8px">Sin carreras.</div>'}</div>`;
  }

  /* ---- Coach ---- */
  function vCoach() {
    const msgs = S.chat.length ? S.chat : [{ who: 'c', text: 'Soy tu coach. Puedo ayudarte a interpretar las salidas y el calendario. Si la IA no está configurada, seguiré respondiendo con reglas. Nunca aplicaré una propuesta de chat sin tu permiso.' }];
    return `<h1>Coach</h1><div class="sub small" style="margin:-8px 2px 8px">IA generativa con Cloudflare Workers AI cuando está configurada; si no, coach por reglas. Se envían solo métricas y sesiones resumidas, nunca claves, GPS ni tokens al modelo. La IA no modifica el calendario por sí sola.</div>
    ${msgs.map((m, i) => `<div class="msg ${m.who}">${esc(m.text)}</div>${m.proposal ? `<div class="prop"><div class="sub small">Propuesta</div><b>${esc(m.proposal.title)}</b>${m.state === 'ok' ? '<div class="good" style="margin-top:6px">✔ Aplicada al calendario</div>' : m.state === 'no' ? '<div class="sub" style="margin-top:6px">Descartada; el plan no ha cambiado</div>' : `<div class="btns"><button class="primary" data-act="prop-ok" data-i="${i}">Aceptar</button><button data-act="prop-no" data-i="${i}">Rechazar</button></div>`}</div>` : ''}`).join('')}
    ${ui.aiBusy ? '<div class="note">El coach está preparando una respuesta…</div>' : ''}
    <div class="row" style="margin-top:10px"><input id="chatIn" class="grow" placeholder="Pregunta a tu coach…" enterkeyhint="send" ${ui.aiBusy?'disabled':''}><button class="primary" data-act="chat-send" ${ui.aiBusy?'disabled':''}>Enviar</button></div><div id="chatEnd"></div>`;
  }

  /* ---- Ajustes ---- */
  function vSet() {
    const p = S.profile, g = S.goal, maint = g.kind === 'maintain';
    const role = d => p.preferred.includes(d) ? 'p' : p.joker.includes(d) ? 'j' : 'n';
    const num = (label, path, val, step = 1) => `<label>${label}</label><input type="number" inputmode="decimal" step="${step}" data-s="${path}" value="${val}">`;
    return `<h1>Ajustes</h1>
    <div class="card"><h2>Corredor</h2>${num('Edad', 'profile.age', p.age)}${num('Altura (cm)', 'profile.heightCm', p.heightCm)}${num('Peso (kg)', 'profile.weightKg', p.weightKg)}
      <label>Nivel</label><input data-s="profile.level" value="${esc(p.level)}">
      <label>Perfil de entrenamiento (automático con Strava)</label>
      <div class="note">${fitNow().fromData ?
        `Ritmo cómodo orientativo: <b>${R.fmtPace(p.easyPace)} min/km</b> · Base de resistencia estimada: <b>${p.continuousMin} min</b> · Referencia: ${fitNow().runsConsidered} salidas en 42 días. El tiempo sin caminar no se puede demostrar solo con Strava.` :
        `Aún no hay 2 carreras válidas en los últimos 42 días. Hasta entonces utilizamos provisionalmente ${R.fmtPace(p.easyPace)} min/km y ${p.continuousMin} min de base.`}</div>
      ${fitNow().fromData ? '' : `${num('Base provisional (minutos)', 'profile.continuousMin', p.continuousMin)}<label>Ritmo provisional (min:seg por km)</label><input data-s="profile.easyPace" data-t="pace" value="${R.fmtPace(p.easyPace)}">`}
      ${num('Sesiones por semana', 'profile.weeklySessions', p.weeklySessions)}
      <label>FC máxima real (vacío = estimada ${R.maxHR({ ...p, maxHROverride: null })} lpm, fórmula 208 − 0,7 × edad)</label><input type="number" inputmode="numeric" data-s="profile.maxHROverride" data-t="nullnum" value="${p.maxHROverride ?? ''}">
      <div class="note">«Minutos seguidos» y «ritmo cómodo» determinan el plan: pon valores reales; la app no los adivina.</div></div>
    <div class="card"><h2>Disponibilidad semanal</h2>${[1, 2, 3, 4, 5, 6, 0].map(d => `<div class="row between" style="margin:6px 0"><span>${R.WEEKDAYS[d]}</span><select data-wd="${d}"><option value="p" ${role(d) === 'p' ? 'selected' : ''}>Preferente</option><option value="j" ${role(d) === 'j' ? 'selected' : ''}>Comodín</option><option value="n" ${role(d) === 'n' ? 'selected' : ''}>No correr</option></select></div>`).join('')}
      <div class="row between" style="margin-top:8px"><span>Pádel los lunes</span><input type="checkbox" data-padel ${p.padel.includes(1) ? 'checked' : ''}></div></div>
    <div class="card"><h2>Objetivo principal</h2><label>Título</label><input data-s="goal.title" value="${esc(g.title)}">${maint ? '<div class="sub small" style="margin-top:6px">Modo mantenimiento (sin carrera).</div>' : num('Distancia (km)', 'goal.distanceKm', g.distanceKm, 0.5) + '<label>Fecha</label><input type="date" data-s="goal.date" value="' + g.date + '">'}
      <div class="btns"><button class="primary" data-act="regen">Regenerar plan</button><button data-act="goals-open">Objetivos…</button></div><div class="sub small" style="margin-top:6px">Regenerar sustituye las sesiones futuras pendientes generadas por la app; no toca el histórico, lo completado ni las sesiones que creaste tú.</div></div>
    <div class="card"><h2>Strava</h2>
      <label>Dirección de tu Worker (ver GUIA.md)</label><input data-s="strava.worker" data-t="url" placeholder="https://xxxx.workers.dev" value="${esc(S.strava.worker)}">
      ${S.strava.worker && !S.strava.tokens ? `<div class="sub small" style="margin-top:8px">Recomendado: pulsa «Obtener código», autoriza en Strava, copia el código que aparece y pégalo aquí.</div><div class="btns"><button class="primary" data-act="strava-manual">Obtener código</button></div><label>Código</label><input id="stCode" placeholder="Pega aquí el código"><div class="btns"><button data-act="strava-code">Usar código</button><button data-act="strava-connect">Conectar automáticamente</button></div>` : ''}
      <div class="btns">${S.strava.worker && S.strava.tokens ? '<button data-act="strava-connect">Reautorizar</button>' : ''}${S.strava.tokens ? '<button data-act="strava-sync">Sincronizar</button><button data-act="strava-athlete-id">Ver mi ID de atleta</button><button class="danger" data-act="strava-disc">Desconectar</button>' : ''}</div>
      <div class="sub small" style="margin-top:8px">Sincronización automática al abrir o volver a la app si han pasado 15 minutos desde la última importación. Puedes sincronizar manualmente cuando quieras.</div></div>
    <div class="card"><h2>Apple Watch · Intervals.icu</h2>
      <div class="sub">No necesitas pegar claves aquí: INTERVALS_API_KEY e INTERVALS_ATHLETE_ID se guardan en Cloudflare. Entra en una sesión pendiente y pulsa «Enviar al Apple Watch». Después abre Companion en el iPhone.</div>
      <div class="sub small" style="margin-top:6px">Sesiones enviadas: ${Object.keys(S.intervals.sent).length}. No se envían automáticamente los cambios del coach: cuando cambies una sesión, pulsa «Actualizar en el Apple Watch».</div>
      ${intervalsObsoleteIds().length ? `<div class="note warn">Tienes ${intervalsObsoleteIds().length} sesiones antiguas, descartadas o eliminadas del plan que siguen en Intervals.icu.</div><div class="btns"><button class="danger" data-act="intervals-clean" ${ui.intervalsBusy?'disabled':''}>Retirar sesiones antiguas de Intervals.icu</button></div>` : ''}
      <div class="sub small" style="margin-top:6px">Si editas el entrenamiento desde Intervals.icu, al reenviarlo desde Running Coach se sustituirán esos cambios. Solo elimina sesiones creadas por Running Coach.</div>
    </div>
    <div class="card"><h2>IA generativa</h2>
      <div class="sub">Se activa con un binding <b>AI</b> de Cloudflare Workers y la variable <b>ALLOWED_STRAVA_ATHLETE_ID</b> en tu Worker. Si no está configurada, el coach sigue funcionando por reglas.</div>
      <div class="sub small" style="margin-top:8px">La IA recibe un resumen de las últimas carreras, sensaciones, objetivos y sesiones próximas; no recibe tus tokens, datos GPS ni datos de Strava sin resumir. Las recomendaciones nunca se aplican automáticamente.</div></div>
    <div class="card"><h2>Tus datos</h2><div class="sub small">Se guardan solo en este navegador. Haz copia de vez en cuando: si borras datos del sitio o desinstalas la app, se pierden.</div>
      <div class="btns"><button data-act="export">Exportar copia</button><button data-act="import">Importar copia</button><button class="danger" data-act="reset">Borrar todo</button></div><input type="file" id="file" accept="application/json" hidden></div>`;
  }

  /* ---- Modales ---- */
  function vModal() {
    const m = ui.modal, top = (t) => `<div class="top"><h3>${t}</h3><button data-act="close">Cerrar</button></div>`;
    let inner = '';
    if (m.type === 'msg') inner = top(esc(m.title)) + `<div class="card" style="white-space:pre-wrap">${esc(m.body)}</div>`;
    else if (m.type === 'goals') inner = top('Objetivos') + goalsHtml();
    else if (m.type === 'weekly') inner = top('Informe semanal') + weeklyReportHtml();
    else if (m.type === 'wk') {
      const w = wkById(m.id); if (!w) return '';
      inner = top(esc(w.title)) + `<div class="card"><div class="sub">${R.KINDS[w.kind]} · ${R.longDate(w.date)}</div><div style="margin-top:4px">${wkSummary(w)}</div>${w.status !== 'planned' ? `<div class="sub" style="margin-top:4px">Estado: ${w.status === 'completed' ? 'completada' : w.status === 'skipped' ? 'no realizada' : 'descartada'}</div>` : ''}</div>
        ${w.explanation ? `<div class="note">✨ ${esc(w.explanation)}</div>` : ''}${w.objective ? `<div class="card"><h2>Objetivo</h2>${esc(w.objective)}</div>` : ''}
        ${sessionExpectationHtml(w)}
        <div class="card"><h2>Bloques</h2>${blocksHtml(w.items)}</div>${w.notes ? `<div class="card"><h2>Indicaciones del entrenador</h2>${esc(w.notes)}</div>` : ''}
        <div class="btns">${w.status === 'planned' ? `<button data-act="move-open" data-id="${w.id}">Mover</button><button data-act="wk-edit" data-id="${w.id}">Editar</button>` : ''}<button data-act="wk-dup" data-id="${w.id}">Duplicar</button>${w.status === 'planned' && w.kind !== 'carreraObjetivo' ? `<button class="danger" data-act="wk-skip" data-id="${w.id}">No la haré</button>` : ''}${w.runId && runById(w.runId) ? `<button data-act="run-open" data-id="${w.runId}">Ver carrera</button>` : ''}</div>
        ${intervalsStatus(w)}<div class="btns">${intervalsButton(w)}${intervalsSent(w) ? `<button class="danger" data-act="intervals-remove" data-id="${esc(w.id)}" ${ui.intervalsBusy?'disabled':''}>Retirar de Intervals.icu</button>` : ''}</div>`;
    } else if (m.type === 'move') {
      const w = wkById(m.id), t = R.today();
      inner = top('Mover «' + esc(w.title) + '»') + '<div class="card">' + Array.from({ length: 21 }, (_, i) => R.addDays(t, i)).map(d => {
        const bad = S.unavailable.includes(d) ? 'no disponible' : R.violatesIntensity(snap(), w, d) ? 'junta dos sesiones intensas' : S.profile.noRun.includes(R.weekday(d)) ? 'día sin correr' : S.workouts.some(o => o.date === d && o.id !== w.id && o.status === 'planned') ? 'ya hay otra sesión' : '';
        return `<div class="item"><button class="link grow" style="text-align:left" data-act="move-do" data-id="${w.id}" data-d="${d}">${R.longDate(d)}</button><span class="sub small ${bad ? 'warn' : ''}">${bad ? '⚠ ' + bad : ''}</span></div>`;
      }).join('') + '</div>';
    } else if (m.type === 'ed') {
      inner = top(m.id ? 'Editar sesión' : 'Sesión') + edHtml(m.draft);
    } else if (m.type === 'extra') {
      inner = top('Nueva actividad') + `<div class="card"><label>Actividad</label><input id="xTitle" value="Pádel"><label>Duración (min)</label><input id="xMin" type="number" value="60"><div class="row between" style="margin-top:10px"><span>Cuenta como sesión intensa</span><input id="xInt" type="checkbox" checked></div><div class="sub small">Las intensas evitan que el plan ponga una sesión intensa de running pegada a ellas.</div><div class="btns"><button class="primary" data-act="extra-save" data-d="${m.date}">Añadir</button></div></div>`;
    } else if (m.type === 'runadd') {
      inner = top('Añadir carrera a mano') + `<div class="card"><label>Fecha</label><input id="rDate" type="date" value="${R.today()}"><label>Distancia (km)</label><input id="rKm" type="number" inputmode="decimal" step="0.01"><label>Duración (min:seg o minutos)</label><input id="rDur" placeholder="32:10"><label>FC media (opcional)</label><input id="rHR" type="number" inputmode="numeric"><div class="btns"><button class="primary" data-act="run-add-save">Guardar</button></div></div>`;
    } else if (m.type === 'run') {
      const r = runById(m.id); if (!r) return '';
      const f = r.feeling || { rpe: 5, breathing: 2, fatigue: 2, pain: '', canContinue: true };
      const sp = (r.splits || []);
      const nxt = !r.adviceHandled && r.evaluation && nextPlannedAfter(r.date);
      inner = top(new Date(r.start).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })) + `
      <div class="card"><div class="sub small">Fuente: ${r.source === 'strava' ? 'Strava' : 'manual'}${r.name ? ' · ' + esc(r.name) : ''}</div>
        <div class="stats" style="grid-template-columns:repeat(3,1fr);margin-top:8px"><div><b>${R.fmtKm(r.distanceM / 1000)}</b><span>km</span></div><div><b>${R.fmtDur(r.durationS)}</b><span>tiempo</span></div><div><b>${R.fmtPace(R.avgPace(r))}</b><span>min/km</span></div>
        <div><b>${r.avgHR ? Math.round(r.avgHR) : '–'}</b><span>FC media</span></div><div><b>${r.maxHR ? Math.round(r.maxHR) : '–'}</b><span>FC máx.</span></div><div><b>${r.cadence || '–'}</b><span>pasos/min</span></div></div>
        <div class="sub small" style="margin-top:6px">Desnivel +: ${r.elevation != null ? Math.round(r.elevation) + ' m' : '–'}</div></div>
      ${runPlanComparison(r)}
      ${outcomeHtml(r)}
      ${postRunReport(r)}
      <div class="card"><h2>Parciales por km</h2>${sp.length ? barChart(sp.map(s => ({ l: s.km, y: s.paceSec / 60 })), v => v.toFixed(1)) + sp.map(s => `<div class="row between small"><span>km ${s.km}${s.partial ? ' (parcial)' : ''}</span><span>${R.fmtPace(s.paceSec)} min/km${s.hr ? ' · ' + Math.round(s.hr) + ' lpm' : ''}</span></div>`).join('') : `<div class="sub">${r.stravaId ? 'Aún no cargados.' : 'No disponibles en carreras manuales.'}</div>${r.stravaId && S.strava.tokens ? `<div class="btns"><button data-act="load-splits" data-id="${r.id}">Cargar parciales</button></div>` : ''}`}</div>
      <div class="card"><h2>Sensaciones</h2>
        <label>Esfuerzo percibido: <b id="rpeV">${f.rpe}</b>/10</label><input type="range" min="1" max="10" id="fRpe" value="${f.rpe}" oninput="document.getElementById('rpeV').textContent=this.value">
        <label>Respiración</label><select id="fBr">${['Muy cómoda', 'Cómoda', 'Algo exigida', 'Muy exigida', 'Me ahogaba'].map((t, i) => `<option value="${i + 1}" ${f.breathing === i + 1 ? 'selected' : ''}>${t}</option>`).join('')}</select>
        <label>Fatiga muscular</label><select id="fFa">${['Nada', 'Poca', 'Media', 'Bastante', 'Muy cargadas'].map((t, i) => `<option value="${i + 1}" ${f.fatigue === i + 1 ? 'selected' : ''}>${t}</option>`).join('')}</select>
        <label>Molestias o dolores (vacío si no hubo)</label><input id="fPain" value="${esc(f.pain)}" placeholder="Ej.: tibia derecha">
        <div class="row between" style="margin-top:10px"><span>Habría podido continuar corriendo</span><input type="checkbox" id="fCan" ${f.canContinue ? 'checked' : ''}></div>
        <div class="btns"><button class="primary" data-act="feel-save" data-id="${r.id}">Guardar sensaciones</button></div></div>
      ${r.evaluation ? `<div class="card"><h2>Evaluación del coach (por reglas)</h2>${esc(r.evaluation)}${nxt && (Math.abs((r.adviceFactor || 1) - 1) > 0.001 || r.adviceRecovery > 0) ? `<div class="note">Propuesta para «${esc(nxt.title)}» (${R.longDate(nxt.date)}): ${r.adviceFactor > 1 ? 'subir' : r.adviceFactor < 1 ? 'bajar' : 'mantener'} los bloques de esfuerzo${r.adviceFactor !== 1 ? ' ' + Math.round(Math.abs(r.adviceFactor - 1) * 100) + ' %' : ''}${r.adviceRecovery > 0 ? ' y dar un día de descanso extra' : ''}.</div><div class="btns"><button class="primary" data-act="advice-apply" data-id="${r.id}">Aplicar</button><button data-act="advice-no" data-id="${r.id}">Dejar como está</button></div>` : ''}</div>` : ''}
      <div class="btns"><button class="danger" data-act="run-del" data-id="${r.id}">Borrar carrera</button></div>`;
    }
    return `<div class="overlay" data-act="overlay"><div class="sheet" data-sheet>${inner}</div></div>`;
  }

  const goalLabel = g => g.kind === 'maintain' ? 'Mantenimiento' : `${R.fmtKm(g.distanceKm)} km${g.kind === 'time' && g.targetTimeSec ? ' en menos de ' + R.fmtDur(g.targetTimeSec) : ''} · ${R.longDate(g.date)}`;
  function goalsHtml() {
    const g = S.goal, t = R.today(), fit = fitNow(), lastClosed = S.goals.filter(x => x.status === 'achieved' || x.status === 'missed').slice(-1)[0] || null;
    const sug = R.suggestGoals(lastClosed, S.runs, fit, t); goalsHtml.sug = sug;
    const hist = S.goals.filter(x => x.status !== 'active').slice().reverse();
    const lab = { achieved: '✔ conseguido', missed: 'no conseguido', replaced: 'sustituido' };
    const f = ui.gform || (ui.gform = { kind: 'finish', km: '5', date: R.targetDate(8, t), time: '' });
    return `<div class="card"><h2>Objetivo actual</h2><h3>${esc(g.title)}</h3><div class="sub">${goalLabel(g)}</div></div>
      <div class="card"><h2>Sugerencias (según lo que ya has corrido)</h2>${sug.map((x, i) => `<div class="item" style="display:block"><b>${esc(x.title)}</b><div class="sub small">${esc(x.detail)}</div><div class="btns"><button class="primary" data-act="goal-pick" data-i="${i}">Elegir este</button></div></div>`).join('')}
        <div class="sub small" style="margin-top:6px">Al elegir uno se sustituye el objetivo actual y se regeneran las sesiones futuras. Si hay datos suficientes, se actualiza antes tu perfil con tu forma real.</div></div>
      <div class="card"><h2>Crear uno propio</h2>
        <label>Tipo</label><select data-ui="gform.kind"><option value="finish" ${f.kind === 'finish' ? 'selected' : ''}>Completar una distancia</option><option value="time" ${f.kind === 'time' ? 'selected' : ''}>Conseguir un tiempo</option><option value="maintain" ${f.kind === 'maintain' ? 'selected' : ''}>Solo mantenerme</option></select>
        <label>Distancia (km)</label><input type="number" inputmode="decimal" step="0.5" data-ui="gform.km" value="${esc(f.km)}">
        <label>Fecha</label><input type="date" data-ui="gform.date" value="${f.date}">
        <label>Tiempo objetivo (min:seg, solo si es «conseguir un tiempo»)</label><input data-ui="gform.time" placeholder="27:30" value="${esc(f.time)}">
        <div class="btns"><button class="primary" data-act="goal-custom">Crear objetivo</button></div></div>
      ${hist.length ? `<div class="card"><h2>Historial</h2>${hist.map(x => `<div class="row between small" style="margin:4px 0"><span>${esc(x.title)}</span><span class="sub">${lab[x.status] || x.status}${x.resultSec ? ' · ' + R.fmtDur(x.resultSec) : ''}</span></div>`).join('')}</div>` : ''}`;
  }

  /* ---- Editor de sesión ---- */
  const getP = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
  function edBlock(b, p, inRep) {
    const val = b.unit === 'kmh' ? R.fmtKmh(b.kmh) : R.fmtPace(R.paceFromKmh(b.kmh));
    return `<div class="edblk"><div class="line"><select data-f="${p}.kind">${Object.entries(R.BLOCKS).map(([k, v]) => `<option value="${k}" ${b.kind === k ? 'selected' : ''}>${v}</option>`).join('')}</select><button class="link danger" data-act="ed-del" data-p="${p}">Quitar</button></div>
      <div class="line"><input data-f="${p}.min" inputmode="decimal" value="${fmtMin(b.min)}"> min <select data-f="${p}.unit"><option value="minkm" ${b.unit === 'minkm' ? 'selected' : ''}>min/km</option><option value="kmh" ${b.unit === 'kmh' ? 'selected' : ''}>km/h</option></select><input data-f="${p}.val" inputmode="decimal" value="${val}"></div>
      <div class="sub small">${R.both(b.kmh)}</div></div>`;
  }
  function edHtml(d) {
    return `<div class="card"><label>Título</label><input data-f="title" style="width:100%" value="${esc(d.title)}"><label>Tipo</label><select data-f="kind">${Object.entries(R.KINDS).map(([k, v]) => `<option value="${k}" ${d.kind === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <label>Objetivo</label><textarea data-f="objective">${esc(d.objective)}</textarea><label>Indicaciones</label><textarea data-f="notes">${esc(d.notes)}</textarea></div>
      <div class="card"><h2>Bloques · ${Math.round(R.totalMin(d.items))} min · ≈ ${R.fmtKm(R.distKm(d.items))} km</h2>
      ${d.items.map((it, i) => it.t === 'r' ? `<div class="edblk"><div class="line grp"><b>Repetir</b><input data-f="items.${i}.reps" inputmode="numeric" value="${it.reps}"> veces <button class="link danger" data-act="ed-del" data-p="items.${i}">Quitar grupo</button></div><div class="grp">${it.items.map((b, j) => edBlock(b, `items.${i}.items.${j}`)).join('')}<button class="link" data-act="ed-add" data-p="items.${i}.items">+ bloque en el grupo</button></div></div>` : edBlock(it, `items.${i}`)).join('')}
      <div class="btns"><button data-act="ed-add" data-p="items">+ Bloque</button><button data-act="ed-addrep">+ Repetición</button></div></div>
      <div class="btns"><button class="primary" data-act="ed-save">Guardar</button></div>`;
  }
  const newBlock = () => R.mkBlock('carrera', 5, S.profile.easyPace);

  /* ---------------- Strava ---------------- */
  const workerBase = () => S.strava.worker.replace(/\/+$/, '');
  async function ensureStravaToken() {
    const st = S.strava;
    if (!st.tokens) throw new Error('Strava no está autorizado.');
    if (st.tokens.expires_at < Date.now() / 1000 + 60) {
      const r = await fetch(workerBase() + '/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: st.tokens.refresh_token }) });
      if (!r.ok) throw new Error('No se pudo renovar el permiso de Strava (' + r.status + '). Vuelve a conectar.');
      st.tokens = await r.json(); save();
    }
    return st.tokens.access_token;
  }
  async function stravaFetch(path) {
    const token = await ensureStravaToken();
    const r = await fetch(workerBase() + '/api' + path, { headers: { Authorization: 'Bearer ' + token } });
    if (r.status === 429) throw new Error('Strava limita las peticiones (100 cada 15 min). Prueba más tarde.');
    if (!r.ok) {
      // Diagnóstico: mostrar la respuesta de Strava sin exponer los tokens.
      // No incluye Authorization ni las claves de la API.
      let detalle = '';
      try {
        const raw = await r.text();
        let obj = null;
        try { obj = JSON.parse(raw); } catch (_) { /* respuesta no JSON */ }
        if (obj && typeof obj === 'object') {
          const message = typeof obj.message === 'string' ? obj.message :
            typeof obj.error === 'string' ? obj.error : '';
          const causes = Array.isArray(obj.errors) ? obj.errors.slice(0, 3)
            .map(x => [x.resource, x.field, x.code].filter(Boolean).join('/')).join(', ') : '';
          detalle = [message, causes].filter(Boolean).join(' · ');
        } else if (/^\s*</.test(raw)) {
          detalle = 'El servidor devolvió HTML en lugar de JSON';
        } else {
          detalle = raw.replace(/[\r\n]+/g, ' ').slice(0, 130);
        }
      } catch (_) { /* diagnóstico no disponible */ }
      const ruta = path.split('?')[0]; // solo ruta, nunca parámetros ni credenciales
      throw new Error(`HTTP ${r.status} consultando ${ruta}${detalle ? ' · ' + detalle.slice(0, 170) : ''}`);
    }
    return r.json();
  }
  async function stravaSync(auto = false) {
    if (ui.busy) return; ui.busy = true; ui.stravaMsg = ''; render();
    try {
      const imported = [], newExtras = []; let skipped = 0;
      const cutoff = R.addDays(R.today(), -120), mhr = R.maxHR(S.profile);
      for (let page = 1; page <= 10; page++) {
        const acts = await stravaFetch(`/athlete/activities?per_page=100&page=${page}`);
        if (!acts.length) break;
        acts.filter(a => !R.isRunType(a)).forEach(a => {   // pádel, bici, fuerza… cuentan como carga y como «no juntar intensas»
          const ex = R.stravaToExtra(a, mhr);
          if (ex.date < cutoff || ex.date > R.today() || ex.durationMin < 10) return;
          if (S.extras.some(e => e.stravaId === ex.stravaId) || newExtras.some(e => e.stravaId === ex.stravaId)) return;
          newExtras.push(ex);
        });
        acts.filter(R.isRunType).forEach(a => {
          const run = R.stravaToRun(a, null);
          if (R.isDuplicateRun(S.runs, run) || imported.some(x => x.stravaId === run.stravaId)) { skipped++; return; }
          imported.push(run);
        });
        if (acts.length < 100) break;
      }
      // parciales: solo de las 12 más recientes (límite de peticiones de Strava); el resto, bajo demanda
      imported.sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
      for (const run of imported.slice(0, 12)) {
        try { const det = await stravaFetch('/activities/' + run.stravaId); const full = R.stravaToRun(det, det); run.splits = full.splits; } catch (e) { /* se pueden cargar luego */ }
      }
      imported.slice().sort((a, b) => Date.parse(a.start) - Date.parse(b.start)).forEach(r => { S.runs.push(r); linkRun(r); });
      newExtras.forEach(ex => {   // el pádel real sustituye al «Pádel» automático de ese día
        if (ex.title === 'Pádel') S.extras = S.extras.filter(e => !(e.auto && e.date === ex.date));
        S.extras.push(ex);
      });
      if (imported.length) applyFitness(); // perfil automatico tras nuevas carreras
      S.strava.lastSync = new Date().toISOString();
      ui.stravaMsg = (imported.length ? `${imported.length} carrera(s) nueva(s) importada(s).` : 'Sin carreras nuevas.') + (newExtras.length ? ` ${newExtras.length} otra(s) actividad(es) añadida(s).` : '');
      if (imported.length) {
        const newest = imported[0];
        // Solo abrimos el informe automáticamente para una salida reciente; al importar
        // el histórico completo no interrumpimos con informes de entrenos antiguos.
        if (!auto && newest.date >= R.addDays(R.today(), -14) && newest.date <= R.today()) {
          ui.tab = 'home'; ui.modal = { type: 'run', id: newest.id };
        }
      }
      save();
    } catch (e) { ui.stravaMsg = 'Error: ' + e.message; }
    ui.busy = false; render();
  }

  /* El modelo recibe solo un resumen de rendimiento, no credenciales ni GPS.
     La identidad del corredor se comprueba en el Worker antes de ejecutar IA. */
  async function generativeCoach(text) {
    const token = await ensureStravaToken();
    const history = S.chat.slice(0,-1).slice(-8).filter(m => m.who === 'u' || m.who === 'c')
      .map(m => ({ role: m.who === 'u' ? 'user' : 'assistant', text: String(m.text || '').slice(0, 500) }));
    const response = await fetch(workerBase() + '/coach', {
      method: 'POST', headers: { 'Content-Type':'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ message:text.slice(0,700), context:coachDataContext(), history }),
    });
    let result = {};
    try { result = await response.json(); } catch (_) { throw new Error('El Worker no devolvió JSON. Revisa la publicación.'); }
    if (!response.ok) throw new Error(result.error || ('El Worker respondió ' + response.status));
    if (!result.reply || typeof result.reply !== 'string') throw new Error('No se recibió respuesta del modelo.');
    return result.reply.slice(0,4000);
  }
  async function maybeAutoSync() {
    const st = S.strava;
    if (!st.worker || !st.tokens || ui.busy || !navigator.onLine || document.visibilityState === 'hidden') return;
    const now = Date.now();
    if (now - (Date.parse(st.lastSync) || 0) < 15 * 60000) return;
    if (now - (Date.parse(st.lastAutoAttempt) || 0) < 30 * 60000) return;
    st.lastAutoAttempt = new Date(now).toISOString(); save();
    await stravaSync(true); // en primer plano, sin interrumpir con el informe de cada importación
  }

  function parsePack(txt) {
    const m = /strava=([A-Za-z0-9_\-%]+)/.exec(txt), raw = decodeURIComponent((m ? m[1] : txt).trim());
    const t = JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/')));
    if (!t.access_token || !t.refresh_token || !t.expires_at) throw new Error('incompleto');
    return t;
  }
  function handleHash() {
    if (!/[#&]strava=/.test(location.hash)) return;
    try { S.strava.tokens = parsePack(location.hash); save(); ui.stravaMsg = 'Strava conectado.'; setTimeout(() => toast('Strava conectado'), 300); }
    catch (e) { toast('No pude leer la autorización de Strava'); }
    history.replaceState(null, '', location.pathname + location.search);
  }

  /* ---------------- Eventos ---------------- */
  function openWk(id) { ui.modal = { type: 'wk', id }; }
  const ACTIONS = {
    tab: d => { ui.tab = d.k; ui.modal = null; window.scrollTo(0, 0); },
    close: () => { ui.modal = null; },
    'cal-mode': d => { ui.calMode = d.m; },
    'cal-prev': () => { ui.calAnchor = ui.calMode === 'week' ? R.addDays(ui.calAnchor, -7) : R.fmtDate(new Date(R.parseDate(ui.calAnchor).getFullYear(), R.parseDate(ui.calAnchor).getMonth() - 1, 1)); },
    'cal-next': () => { ui.calAnchor = ui.calMode === 'week' ? R.addDays(ui.calAnchor, 7) : R.fmtDate(new Date(R.parseDate(ui.calAnchor).getFullYear(), R.parseDate(ui.calAnchor).getMonth() + 1, 1)); },
    'cal-sel': d => { ui.calSel = d.d; },
    'wk-open': d => openWk(d.id),
    'intervals-send': d => intervalsSend(d.id),
    'intervals-remove': d => {
      if (!confirm('¿Retirar esta sesión de Intervals.icu? No borra tu plan de Running Coach.')) return;
      return intervalsRemove([d.id]);
    },
    'intervals-clean': () => {
      const ids=intervalsObsoleteIds();
      if (!ids.length) return;
      if (!confirm(`¿Retirar ${ids.length} sesión(es) antiguas de Intervals.icu? Solo se eliminarán las creadas por Running Coach.`)) return;
      return intervalsRemove(ids.slice(0,30));
    },
    'toggle-unavail': d => {
      const msgs = setUnavailable(d.d, !S.unavailable.includes(d.d));
      if (msgs.length) ui.modal = { type: 'msg', title: 'Cambios en el plan', body: msgs.join('\n\n') };
    },
    'extra-open': d => { ui.modal = { type: 'extra', date: d.d }; },
    'extra-save': d => {
      S.extras.push({ id: R.uid(), date: d.d, title: $('#xTitle').value || 'Actividad', durationMin: +$('#xMin').value || 60, intense: $('#xInt').checked });
      save(); ui.modal = null;
    },
    'extra-del': d => { S.extras = S.extras.filter(e => e.id !== d.id); save(); },
    'move-open': d => { ui.modal = { type: 'move', id: d.id }; },
    'move-do': d => {
      const w = wkById(d.id);
      if (R.violatesIntensity(snap(), w, d.d) && !confirm('Quedaría pegada a otra sesión intensa. ¿Mover igualmente?')) return;
      w.date = d.d; w.explanation = 'Movida por ti al ' + R.longDate(d.d) + '.'; save(); openWk(w.id);
    },
    'wk-skip': d => { const w = wkById(d.id); w.status = 'skipped'; w.explanation = 'Marcada por ti como no realizada.'; save(); ui.modal = null; },
    'wk-dup': d => {
      const w = JSON.parse(JSON.stringify(wkById(d.id))); w.id = R.uid(); w.status = 'planned'; w.runId = null; delete w.completedOn; w.explanation = 'Copia de otra sesión.'; w.manual = true; w.date = R.today(); if (w.kind === 'carreraObjetivo') w.kind = 'carreraContinua';
      S.workouts.push(w); save(); toast('Duplicada en hoy; muévela donde quieras'); openWk(w.id);
    },
    'wk-edit': d => { const w = wkById(d.id); ui.modal = { type: 'ed', id: w.id, draft: JSON.parse(JSON.stringify({ title: w.title, kind: w.kind, objective: w.objective, notes: w.notes, items: w.items })) }; },
    'ed-add': d => { getP(ui.modal.draft, d.p).push(newBlock()); },
    'ed-addrep': () => { ui.modal.draft.items.push(R.mkRepeat(3, [R.mkBlock('carrera', 2, S.profile.easyPace), R.mkBlock('caminar', 2, R.WALK_PACE)])); },
    'ed-del': d => { const parts = d.p.split('.'), idx = +parts.pop(); getP(ui.modal.draft, parts.join('.')).splice(idx, 1); },
    'ed-save': () => {
      const dr = ui.modal.draft, w = wkById(ui.modal.id);
      if (!R.flatten(dr.items).length) { toast('La sesión necesita al menos un bloque'); return; }
      Object.assign(w, { title: dr.title || w.title, kind: dr.kind, objective: dr.objective, notes: dr.notes, items: dr.items, explanation: 'Editada por ti.', manual: true }); save(); openWk(w.id);
    },
    tpl: d => { const t = TEMPLATES[+d.i]; ui.create.text = t[2]; ui.create.kind = t[1]; ui.create.preview = R.parseSession(t[2], S.profile.easyPace); },
    'create-preview': () => { ui.create.preview = R.parseSession(ui.create.text, S.profile.easyPace); },
    'create-save': () => {
      const c = ui.create, p = R.parseSession(c.text, S.profile.easyPace);
      if (!p.items.length || p.errors.length) { ui.create.preview = p; toast('Revisa la frase'); return; }
      const w = { id: R.uid(), date: c.date || R.today(), kind: c.kind, status: 'planned', title: `${R.KINDS[c.kind]} ${Math.round(R.totalMin(p.items))} min`, objective: '', notes: '', items: p.items, explanation: 'Creada por ti.', runId: null, manual: true };
      S.workouts.push(w); save(); ui.create = { text: '', kind: 'rodajeSuave', date: R.today(), preview: null }; toast('Sesión guardada'); openWk(w.id);
    },
    'run-open': d => { ui.modal = { type: 'run', id: d.id }; },
    'run-add-open': () => { ui.modal = { type: 'runadd' }; },
    'run-add-save': () => {
      const km = parseFloat($('#rKm').value.replace(',', '.')), txt = $('#rDur').value.trim(), date = $('#rDate').value;
      const dur = /^\d+:\d{2}$/.test(txt) ? (+txt.split(':')[0] * 60 + +txt.split(':')[1]) : parseFloat(txt.replace(',', '.')) * 60;
      if (!(km > 0) || !(dur > 0) || !date) { toast('Pon fecha, distancia y duración'); return; }
      const hr = parseFloat($('#rHR').value) || null;
      const run = { id: R.uid(), stravaId: null, source: 'manual', name: '', date, start: new Date(date + 'T08:00:00').toISOString(), distanceM: km * 1000, durationS: dur, avgHR: hr, maxHR: null, cadence: null, elevation: null, splits: [], feeling: null, evaluation: null, adviceFactor: null, adviceRecovery: null, adviceHandled: false, workoutId: null };
      S.runs.push(run); linkRun(run); applyFitness(); ui.modal = { type: 'run', id: run.id };
    },
    'feel-save': d => {
      const r = runById(d.id);
      r.feeling = { rpe: +$('#fRpe').value, breathing: +$('#fBr').value, fatigue: +$('#fFa').value, pain: $('#fPain').value.trim(), canContinue: $('#fCan').checked };
      const hist = S.runs.filter(x => x.id !== r.id && Date.parse(x.start) <= Date.parse(r.start));
      const a = R.evaluate(r, [...hist, r], S.profile);
      r.evaluation = a.summary; r.adviceFactor = a.factor; r.adviceRecovery = a.recovery; r.adviceHandled = false; applyFitness();
    },
    'advice-apply': d => { const r = runById(d.id), w = nextPlannedAfter(r.date); if (w) { applyAdvice(w, r.adviceFactor, r.adviceRecovery, r.evaluation); r.coachAdviceApplied = { workoutId: w.id, title: w.title }; } r.adviceHandled = true; save(); if (w) toast('Aplicado a «' + w.title + '»'); },
    'advice-no': d => { runById(d.id).adviceHandled = true; save(); },
    'run-del': d => { if (!confirm('¿Borrar esta carrera?')) return; const r = runById(d.id); if (r) restoreRunPlan(r); S.runs = S.runs.filter(x => x.id !== d.id); ui.modal = null; applyFitness(); },
    'load-splits': async d => {
      const r = runById(d.id); ui.busy = true;
      try { const det = await stravaFetch('/activities/' + r.stravaId); r.splits = R.stravaToRun(det, det).splits; save(); } catch (e) { toast(e.message); }
      ui.busy = false; render();
    },
    period: d => { ui.period = +d.n; },
    pseg: d => { ui.pseg = d.k; },
    'wt-save': () => {
      const kg = parseFloat(($('#wKg').value || '').replace(',', '.')), date = $('#wDate').value;
      if (!(kg >= 30 && kg <= 300) || !date) { toast('Pon un peso entre 30 y 300 kg y una fecha'); return; }
      S.weights = S.weights.filter(w => w.date !== date); S.weights.push({ date, kg });
      const last = S.weights.slice().sort((a, b) => a.date.localeCompare(b.date)).pop(); S.profile.weightKg = last.kg; save(); toast('Peso guardado');
    },
    'wt-del': d => { S.weights = S.weights.filter(w => w.date !== d.d); save(); },
    'goals-open': () => { ui.modal = { type: 'goals' }; },
    'goal-seen': d => { const g = S.goals.find(x => x.id === d.id); if (g) { g.seen = true; save(); } },
    'goal-pick': d => {
      const x = goalsHtml.sug[+d.i], t = R.today(); if (!x) return;
      applyFitness();
      const g = { title: x.title, kind: x.kind, distanceKm: x.distanceKm, date: x.kind === 'maintain' ? R.MAINTAIN_DATE : R.targetDate(x.weeks, t), targetTimeSec: x.targetTimeSec };
      const notes = activateGoal(g); ui.modal = { type: 'msg', title: 'Objetivo cambiado', body: 'Nuevo objetivo: ' + x.title + '.\n\n' + (notes.join('\n\n') || 'He regenerado las sesiones futuras.') };
    },
    'goal-custom': () => {
      const f = ui.gform, t = R.today(), km = parseFloat(String(f.km).replace(',', '.'));
      let g;
      if (f.kind === 'maintain') g = { title: 'Mantener y mejorar la forma', kind: 'maintain', distanceKm: 0, date: R.MAINTAIN_DATE, targetTimeSec: null };
      else {
        if (!(km >= 1 && km <= 60)) { toast('Distancia entre 1 y 60 km'); return; }
        if (!f.date || f.date <= t) { toast('Elige una fecha futura'); return; }
        let tt = null; if (f.kind === 'time') { tt = R.parsePace(f.time); if (!tt) { toast('Pon el tiempo como min:seg, p. ej. 27:30'); return; } }
        g = { title: f.kind === 'time' ? `${R.fmtKm(km)} km en menos de ${R.fmtDur(tt)}` : `Completar ${R.fmtKm(km)} km`, kind: f.kind, distanceKm: km, date: f.date, targetTimeSec: tt };
      }
      applyFitness();
      const notes = activateGoal(g); ui.modal = { type: 'msg', title: 'Objetivo creado', body: notes.join('\n\n') || 'Listo. He regenerado las sesiones futuras.' };
    },
    'replan-ok': () => { applyFitness(); S.profile.lastReplan = R.today(); const n = regenerate(); ui.modal = { type: 'msg', title: 'Plan replanificado', body: fitNow().note + '\n\n' + (n.join('\n\n') || 'Sesiones futuras regeneradas; las que creaste tú se mantienen.') }; },
    'replan-no': () => { S.profile.lastReplan = R.today(); save(); },
    'week-report': () => { ui.modal = { type:'weekly' }; },
    'weekly-accept': () => { if (applyWeekDecision(true)) toast('Propuesta aceptada'); },
    'weekly-decline': () => { if (applyWeekDecision(false)) toast('Mantengo tu plan'); },
    'chat-send': async () => {
      if (ui.aiBusy) return;
      const inp = $('#chatIn'), text = (inp?.value || '').trim().slice(0,700); if (!text) return;
      S.chat.push({ who: 'u', text }); save();
      ui.aiBusy = true; render();
      try {
        if (S.strava.worker && S.strava.tokens) {
          const reply = await generativeCoach(text);
          S.chat.push({ who: 'c', text: 'IA: ' + reply });
        } else {
          const r = R.chat(text, snap());
          S.chat.push({ who: 'c', text: 'Modo reglas (sin Strava): ' + r.text, proposal: r.proposal || null, state: r.proposal ? 'pending' : null });
        }
      } catch(e) {
        // Fallback claro; no se finge que la IA ha respondido.
        const r = R.chat(text, snap());
        S.chat.push({who:'c', text: 'IA no disponible: ' + e.message + '\n\nRespuesta por reglas: ' + r.text, proposal: r.proposal || null, state:r.proposal ? 'pending' : null});
      }
      S.chat = S.chat.slice(-60); save(); ui.aiBusy = false; render();
    },
    'prop-ok': d => {
      const m = S.chat[+d.i], p = m.proposal, w = wkById(p.workoutId);
      if (!w || w.status !== 'planned') { toast('Esa sesión ya no está pendiente'); m.state = 'no'; save(); return; }
      if (p.moveTo) { w.date = p.moveTo; w.explanation = 'Movida a petición tuya en el chat: ' + p.reason; save(); }
      else applyAdvice(w, p.factor, p.recovery, p.reason);
      m.state = 'ok'; save();
    },
    'prop-no': d => { S.chat[+d.i].state = 'no'; save(); },
    'strava-connect': () => {
      if (!S.strava.worker) { toast('Primero pon la dirección del Worker en Ajustes'); return; }
      location.href = workerBase() + '/auth?return=' + encodeURIComponent(location.origin + location.pathname);
    },
    'strava-manual': () => {
      if (!S.strava.worker) { toast('Primero pon la dirección del Worker en Ajustes'); return; }
      window.open(workerBase() + '/auth?return=manual', '_blank');
    },
    'strava-code': () => {
      const v = ($('#stCode') || {}).value || '';
      try { S.strava.tokens = parsePack(v); save(); ui.stravaMsg = 'Strava conectado.'; toast('Strava conectado'); }
      catch (e) { toast('Ese código no es válido. Cópialo entero.'); }
    },
    'strava-sync': () => { stravaSync(); },
    'strava-athlete-id': async () => {
      try {
        const athlete = await stravaFetch('/athlete');
        if (!athlete.id) throw new Error('Strava no devolvió el ID.');
        ui.modal = {type:'msg', title:'Tu ID de atleta de Strava', body:'ID: ' + athlete.id + '\n\nEscribe ese número en la variable ALLOWED_STRAVA_ATHLETE_ID de Cloudflare para activar la IA.'};
      } catch(e) {toast(e.message);}
    },
    'strava-disc': () => { S.strava.tokens = null; save(); },
    regen: () => { const notes = regenerate(); ui.modal = { type: 'msg', title: 'Plan regenerado', body: notes.length ? notes.join('\n\n') : 'Listo. Las sesiones futuras pendientes se han sustituido; el histórico no cambia.' }; },
    export: () => {
      const blob = new Blob([JSON.stringify(S, null, 1)], { type: 'application/json' }), a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'running-coach-' + R.today() + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    },
    import: () => { $('#file').click(); },
    reset: () => { if (confirm('Se borrarán perfil, plan y carreras de este dispositivo. ¿Seguro?')) { S = freshState(); save(); ui.modal = null; } },
    overlay: () => {},
  };
  document.addEventListener('click', e => {
    const sheet = e.target.closest('[data-sheet]'), el = e.target.closest('[data-act]');
    if (!el) return;
    if (el.dataset.act === 'overlay') { if (!sheet) { ui.modal = null; render(); } return; }
    const fn = ACTIONS[el.dataset.act]; if (!fn) return;
    const res = fn(el.dataset, el);
    const re = () => render();
    if (res && res.then) res.then(re); else re();
  });
  document.addEventListener('change', e => {
    const el = e.target;
    if (el.id === 'file') {
      const f = el.files[0]; if (!f) return;
      f.text().then(t => { try { const o = JSON.parse(t); if (o.v !== 1) throw 0; S = ensureShape(o); reconcileExistingRuns(); applyFitness(); lifecycle(); save(); toast('Copia importada'); } catch (x) { toast('Archivo no válido'); } render(); }); return;
    }
    if (el.dataset.ui) {   // estado de la interfaz (sin re-render para no perder el foco)
      const [a, b] = el.dataset.ui.split('.');
      if (b) ui[a][b] = el.value; else { ui[a] = el.value; render(); }
      return;
    }
    if (el.dataset.s) {    // ajustes
      const path = el.dataset.s.split('.'), key = path.pop(), obj = getP(S, path.join('.')), t = el.dataset.t;
      if (t === 'pace') { const v = R.parsePace(el.value); if (v && v >= 240 && v <= 1200) obj[key] = v; else toast('Usa el formato min:seg, p. ej. 8:00'); }
      else if (t === 'nullnum') obj[key] = el.value === '' ? null : +el.value;
      else if (t === 'url') obj[key] = el.value.trim();
      else if (el.type === 'number') { const v = parseFloat(el.value); if (isFinite(v) && v > 0) obj[key] = v; }
      else obj[key] = el.value;
      save(); render(); return;
    }
    if (el.dataset.wd != null) {
      const d = +el.dataset.wd, p = S.profile;
      p.preferred = p.preferred.filter(x => x !== d); p.joker = p.joker.filter(x => x !== d); p.noRun = p.noRun.filter(x => x !== d);
      (el.value === 'p' ? p.preferred : el.value === 'j' ? p.joker : p.noRun).push(d); save(); toast('Pulsa «Regenerar plan» para aplicarlo'); return;
    }
    if (el.hasAttribute && el.hasAttribute('data-padel')) { S.profile.padel = el.checked ? [1] : []; save(); toast('Pulsa «Regenerar plan» para aplicarlo'); return; }
    if (el.dataset.f != null && ui.modal && ui.modal.type === 'ed') {   // editor de sesión
      const path = el.dataset.f.split('.'), key = path.pop(), obj = path.length ? getP(ui.modal.draft, path.join('.')) : ui.modal.draft;
      if (key === 'min') { const v = parseFloat(el.value.replace(',', '.')); if (v > 0) obj.min = v; else toast('Duración no válida'); }
      else if (key === 'reps') { const v = parseInt(el.value, 10); if (v >= 1 && v <= 50) obj.reps = v; }
      else if (key === 'val') {
        if (obj.unit === 'kmh') { const v = parseFloat(el.value.replace(',', '.')); if (v >= 2 && v <= 30) obj.kmh = v; else toast('Velocidad no válida (2–30 km/h)'); }
        else { const p = R.parsePace(el.value); if (p && p >= 120 && p <= 1500) obj.kmh = R.kmhFromPace(p); else toast('Ritmo no válido; usa min:seg, p. ej. 8:00'); }
      } else obj[key] = el.value;
      render();
    }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'chatIn') { ACTIONS['chat-send'](); render(); } });

  /* ---------------- Arranque ---------------- */
  handleHash();
  reconcileExistingRuns();
  applyFitness(); // al actualizar la app, recalcula con los entrenos ya guardados
  lifecycle();
  handleMissed();
  render();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
  // Automático al abrir y al regresar a primer plano; no es sincronización en segundo plano.
  setTimeout(maybeAutoSync, 450);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') maybeAutoSync(); });
  window.__rca = { get S() { return S; }, ui, render, R };   // para pruebas
})();

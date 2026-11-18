/* Running Coach AI (web) — lógica pura, sin DOM. Funciona en navegador y en Node (tests). */
(function (root) {
  'use strict';
  const C = {};
  const pad = n => String(n).padStart(2, '0');
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  C.uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

  /* ---------- Fechas ('YYYY-MM-DD', día local; weekday: 0 = domingo … 6 = sábado) ---------- */
  C.fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  C.parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  C.addDays = (s, n) => { const d = C.parseDate(s); d.setDate(d.getDate() + n); return C.fmtDate(d); };
  C.today = () => C.fmtDate(new Date());
  C.weekday = s => C.parseDate(s).getDay();
  C.mondayOf = s => C.addDays(s, -((C.weekday(s) + 6) % 7));
  C.diffDays = (a, b) => Math.round((C.parseDate(b) - C.parseDate(a)) / 86400000);
  C.WEEKDAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  C.MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  C.longDate = s => { const d = C.parseDate(s); return `${C.WEEKDAYS[d.getDay()].toLowerCase()} ${d.getDate()} de ${C.MONTHS[d.getMonth()]}`; };

  /* ---------- Ritmo ↔ velocidad ---------- */
  C.paceFromKmh = v => (v > 0 ? 3600 / v : 0);
  C.kmhFromPace = p => (p > 0 ? 3600 / p : 0);
  C.fmtPace = s => { if (!isFinite(s) || s <= 0) return '–'; const t = Math.round(s); return `${Math.floor(t / 60)}:${pad(t % 60)}`; };
  C.fmtKmh = v => v.toFixed(1).replace('.', ',');
  C.fmtDur = s => { if (!isFinite(s) || s < 0) return '–'; const t = Math.round(s); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = t % 60; return h ? `${h}:${pad(m)}:${pad(x)}` : `${m}:${pad(x)}`; };
  C.fmtKm = k => k.toFixed(2).replace('.', ',');
  C.both = kmh => `${C.fmtPace(C.paceFromKmh(kmh))} min/km · ${C.fmtKmh(kmh)} km/h`;
  C.parsePace = t => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t).trim()); return m ? (+m[1]) * 60 + (+m[2]) : null; };

  /* ---------- Tipos ---------- */
  C.KINDS = { rodajeSuave: 'Rodaje suave', intervalos: 'Intervalos', carreraContinua: 'Carrera continua', recuperacion: 'Recuperación', prueba: 'Prueba de rendimiento', carreraObjetivo: 'Carrera objetivo' };
  C.INTENSE = new Set(['intervalos', 'prueba', 'carreraObjetivo']);
  C.INTENSITY = { recuperacion: 'Muy baja', rodajeSuave: 'Baja', carreraContinua: 'Moderada', intervalos: 'Moderada-alta', prueba: 'Alta', carreraObjetivo: 'Alta' };
  C.BLOCKS = { calentamiento: 'Calentamiento', progresion: 'Progresión', carrera: 'Carrera', caminar: 'Caminar', recuperacion: 'Recuperación', enfriamiento: 'Enfriamiento' };
  const EFFORT = new Set(['carrera', 'progresion']);
  C.WALK_PACE = 720; // 5 km/h

  /* ---------- Bloques: {t:'b',kind,min,kmh,unit} y grupos {t:'r',reps,items:[bloques]} ---------- */
  C.mkBlock = (kind, min, paceSec, unit = 'minkm') => ({ t: 'b', kind, min, kmh: C.kmhFromPace(paceSec), unit });
  C.mkRepeat = (reps, items) => ({ t: 'r', reps, items });
  C.flatten = items => items.flatMap(i => (i.t === 'r' ? Array.from({ length: i.reps }, () => i.items).flat() : [i]));
  C.totalMin = items => C.flatten(items).reduce((s, b) => s + b.min, 0);
  C.distKm = items => C.flatten(items).reduce((s, b) => s + b.kmh * b.min / 60, 0);

  /* ---------- Plan ---------- */
  C.defaultProfile = () => ({
    name: '', age: 33, heightCm: 195, weightKg: 110, level: 'Principiante',
    easyPace: 480, continuousMin: 5, weeklySessions: 3, maxHROverride: null,
    preferred: [2, 4], joker: [5, 6, 0], noRun: [1, 3], padel: [1],
  });
  C.defaultGoal = () => ({ id: 'g1', title: 'Mi primera carrera de 5 km', kind: 'finish', distanceKm: 5, date: '2026-12-13', targetTimeSec: null, status: 'active', resultSec: null, achievedRunId: null });
  C.MAINTAIN_DATE = '2099-12-31';
  C.maxHR = p => p.maxHROverride || Math.round(208 - 0.7 * p.age);

  function pickDays(cands, profile, count) {
    const chosen = [];
    const adj = d => chosen.some(c => Math.abs(C.diffDays(c, d)) <= 1);
    cands.filter(d => profile.preferred.includes(C.weekday(d))).forEach(d => { if (chosen.length < count) chosen.push(d); });
    const joker = cands.filter(d => profile.joker.includes(C.weekday(d)) && !chosen.includes(d));
    joker.forEach(d => { if (chosen.length < count && !adj(d)) chosen.push(d); });
    // Sin «último recurso»: nunca se pegan dos días de carrera seguidos; si no hay hueco, esa semana tiene menos sesiones.
    return chosen.sort();
  }

  C.makeWorkout = function (kind, date, L, week, pace, taper) {
    const W = C.WALK_PACE;
    const items = [C.mkBlock('calentamiento', 5, W)];
    let title = C.KINDS[kind], objective = '', notes = '';
    if (kind === 'intervalos') {
      const r = Math.max(2, Math.min(8, Math.round(L * 0.4)));
      const w = Math.max(1, Math.round(r / 2));
      const total = Math.min(30, 16 + 2 * week);
      const reps = Math.max(3, Math.floor(total / (r + w)));
      items.push(C.mkRepeat(reps, [C.mkBlock('carrera', r, pace), C.mkBlock('caminar', w, W)]));
      title = `Correr y caminar: ${reps} × ${r} min`;
      objective = 'Acumular tiempo corriendo con pausas que controlen la fatiga.';
      notes = 'Corre a un ritmo en el que puedas hablar frases cortas. Camina de verdad en las pausas, sin trotar.';
    } else if (kind === 'rodajeSuave') {
      const e = taper ? 12 : Math.max(5, Math.round(L * 0.7));
      if (e > 12) {
        const h = Math.round(e / 2);
        items.push(C.mkBlock('carrera', h, pace), C.mkBlock('caminar', 2, W), C.mkBlock('carrera', h, pace));
      } else items.push(C.mkBlock('carrera', e, pace));
      title = taper ? 'Rodaje corto previo a la carrera' : `Rodaje suave ${e} min`;
      objective = taper ? 'Mantener sensaciones sin acumular fatiga antes de la carrera.' : 'Construir base aeróbica a baja intensidad.';
      notes = 'Si no puedes mantener una conversación, reduce el ritmo o camina un minuto.';
    } else if (kind === 'prueba') {
      items.length = 0;
      items.push(C.mkBlock('calentamiento', 10, pace + 40), C.mkBlock('carrera', 12, Math.max(pace - 25, 180)), C.mkBlock('enfriamiento', 8, W));
      title = 'Prueba de 12 min';
      objective = 'Medir tu forma: correr 12 min a un esfuerzo fuerte pero constante.';
      notes = 'Sal con calma y mantén un ritmo parejo: la distancia que cubras en esos 12 min te sirve para compararla con la próxima prueba.';
    } else {
      items.push(C.mkBlock('carrera', L, pace));
      title = `Carrera continua ${L} min`;
      objective = 'Alargar poco a poco el tiempo que puedes correr seguido.';
      notes = 'Es la sesión más larga de la semana: empieza más lento de lo que te pida el cuerpo.';
    }
    if (kind !== 'prueba') items.push(C.mkBlock('enfriamiento', 5, W));
    return { id: C.uid(), date, kind, status: 'planned', title, objective, notes, items, explanation: null, runId: null };
  };

  C.raceWorkout = function (goal, longMin, pace) {
    const W = C.WALK_PACE, runKmh = C.kmhFromPace(pace), walkKmh = C.kmhFromPace(W);
    const runSeg = Math.max(3, Math.round(longMin * 0.5));
    const items = [C.mkBlock('calentamiento', 8, W)];
    let covered = 0;
    while (covered < goal.distanceKm - 0.001) {
      const remaining = goal.distanceKm - covered;
      const runDist = runKmh * runSeg / 60;
      if (runDist >= remaining) { items.push(C.mkBlock('carrera', Math.round(remaining / runKmh * 60 * 2) / 2, pace)); covered = goal.distanceKm; }
      else { items.push(C.mkBlock('carrera', runSeg, pace), C.mkBlock('caminar', 1, W)); covered += runDist + walkKmh / 60; }
    }
    return {
      id: C.uid(), date: goal.date, kind: 'carreraObjetivo', status: 'planned', title: goal.title,
      objective: `Completar ${C.fmtKm(goal.distanceKm)} km disfrutando del proceso.`,
      notes: 'Estrategia sugerida: tramos corriendo y 1 min caminando. Sal por debajo de tu ritmo cómodo; si vas bien, aprieta en el último kilómetro.',
      items, explanation: null, runId: null,
    };
  };

  /** Sesión de calidad para objetivos de tiempo: repeticiones al ritmo objetivo con recuperación suave. */
  C.qualityWorkout = function (date, week, targetPace, easyPace) {
    const reps = Math.min(6, 3 + Math.floor(week / 2));
    const items = [C.mkBlock('calentamiento', 10, easyPace + 40),
      C.mkRepeat(reps, [C.mkBlock('carrera', 3, targetPace), C.mkBlock('recuperacion', 2, easyPace + 60)]),
      C.mkBlock('enfriamiento', 5, C.WALK_PACE)];
    return {
      id: C.uid(), date, kind: 'intervalos', status: 'planned', title: `Ritmo objetivo: ${reps} × 3 min`,
      objective: `Acostumbrar al cuerpo al ritmo de carrera (${C.fmtPace(targetPace)} min/km).`,
      notes: 'Las repeticiones deben ser duras pero controladas; la recuperación es muy suave. Si no aguantas el ritmo en las últimas, avísalo en las sensaciones: mejor ajustar que forzar.',
      items, explanation: null, runId: null,
    };
  };

  C.timeRaceWorkout = function (goal, targetPace, easyPace) {
    return {
      id: C.uid(), date: goal.date, kind: 'carreraObjetivo', status: 'planned', title: goal.title,
      objective: `${C.fmtKm(goal.distanceKm)} km en menos de ${C.fmtDur(goal.targetTimeSec)}.`,
      notes: `Estrategia: sal 5-10 s/km por debajo del ritmo objetivo los primeros 2 km y deja lo que quede para el final. Ritmo objetivo: ${C.fmtPace(targetPace)} min/km.`,
      items: [C.mkBlock('calentamiento', 10, easyPace + 60), C.mkBlock('carrera', goal.targetTimeSec / 60, targetPace), C.mkBlock('enfriamiento', 5, C.WALK_PACE)],
      explanation: null, runId: null,
    };
  };

  const padelExtras = (profile, from, to) => {
    const out = [];
    for (let d = from; d <= to; d = C.addDays(d, 1)) {
      if (profile.padel.includes(C.weekday(d))) out.push({ id: C.uid(), date: d, title: 'Pádel', durationMin: 60, intense: true, auto: true });
    }
    return out;
  };
  const nearPadel = (d, profile) => [-1, 0, 1].some(k => profile.padel.includes(C.weekday(C.addDays(d, k))));
  const firstQualityIdx = (chosen, profile) => (chosen.length < 2 ? -1 : chosen.findIndex((d, idx) => idx < chosen.length - 1 && !nearPadel(d, profile)));

  /**
   * Plan hacia una carrera (objetivo de distancia o de tiempo) o modo mantenimiento.
   * `fitness` = {easyPace, baseMin}: tu forma real si hay datos; si no, los valores del perfil.
   */
  C.generatePlan = function (profile, goal, unavailable, now, fitness) {
    fitness = fitness || { easyPace: profile.easyPace, baseMin: profile.continuousMin };
    if (goal.kind === 'maintain') return C.generateMaintenance(profile, unavailable, now, fitness, 4);
    const res = { workouts: [], extras: [], notes: [] };
    const race = goal.date;
    const start = now.hour < 18 ? now.date : C.addDays(now.date, 1);
    if (C.diffDays(start, race) <= 0) { res.notes.push('La fecha del objetivo ya ha pasado o es hoy: no se ha generado plan.'); return res; }
    const pace = fitness.easyPace, base = clamp(Math.round(fitness.baseMin), 1, 60);
    const coverMin = goal.distanceKm * pace / 60;           // minutos para cubrir la distancia a ritmo cómodo
    const cap = Math.min(coverMin * 0.9, 90);
    const weekStarts = [];
    for (let w = C.mondayOf(start); w <= race; w = C.addDays(w, 7)) weekStarts.push(w);
    const prepWeeks = Math.max(weekStarts.length - 1, 1), raceIdx = weekStarts.length - 1;
    // Progresión de la salida más larga: +25 % semanal con poca base, +12 % con más base.
    const longs = []; let prev = base;
    weekStarts.forEach((_, i) => {
      const ramp = base + (cap - base) * (i + 1) / prepWeeks;
      const growth = prev < 20 ? 1.25 : 1.12;
      const v = Math.max(prev, Math.min(Math.max(cap, base), Math.round(Math.min(ramp, prev * growth))));
      longs.push(v); prev = v;
    });
    const isDeload = i => prepWeeks >= 5 && i % 4 === 3 && i < raceIdx - 1;
    const tp = C.targetPace(goal);
    weekStarts.forEach((ws, i) => {
      const isRaceWeek = i === raceIdx;
      const cands = Array.from({ length: 7 }, (_, k) => C.addDays(ws, k)).filter(d =>
        d >= start && d < race && !unavailable.has(d) && !profile.noRun.includes(C.weekday(d)) &&
        (!isRaceWeek || C.diffDays(d, race) >= 2));
      const count = isRaceWeek ? Math.min(2, profile.weeklySessions) : profile.weeklySessions;
      const chosen = pickDays(cands, profile, count);
      const baseLong = longs[Math.max(0, isRaceWeek ? i - 1 : i)];
      const L = isDeload(i) ? Math.round(baseLong * 0.8) : baseLong;
      const qIdx = isRaceWeek ? -1 : firstQualityIdx(chosen, profile);
      chosen.forEach((d, idx) => {
        if (isRaceWeek) res.workouts.push(C.makeWorkout('rodajeSuave', d, L, i, pace, true));
        else if (chosen.length === 1) res.workouts.push(C.makeWorkout('carreraContinua', d, L, i, pace, false));
        else if (idx === qIdx) res.workouts.push(tp ? C.qualityWorkout(d, i, tp, pace) : C.makeWorkout('intervalos', d, L, i, pace, false));
        else if (idx === chosen.length - 1) res.workouts.push(C.makeWorkout('carreraContinua', d, L, i, pace, false));
        else res.workouts.push(C.makeWorkout('rodajeSuave', d, L, i, pace, false));
      });
    });
    const finalLong = longs[Math.max(0, raceIdx - 1)];
    if (tp) {
      res.workouts.push(C.timeRaceWorkout(goal, tp, pace));
      if (tp < pace * 0.85) res.notes.push(`Este objetivo exige correr un ${Math.round((1 - tp / pace) * 100)} % más rápido que tu ritmo actual (${C.fmtPace(pace)} → ${C.fmtPace(tp)} min/km) en ${weekStarts.length - 1} semanas. Es poco realista: valora una fecha más lejana o un tiempo menos exigente.`);
    } else res.workouts.push(C.raceWorkout(goal, finalLong, pace));
    res.extras = padelExtras(profile, start, race);
    if (goal.kind === 'finish' && finalLong < coverMin * 0.85) {
      res.notes.push(`Con ${base} min seguidos hoy y ${weekStarts.length - 1} semanas de preparación, llegarás a unos ${finalLong} min corriendo seguidos. El plan prepara completar los ${C.fmtKm(goal.distanceKm)} km alternando correr y caminar, no corriendo sin parar. Si ya corres más, actualízalo en Ajustes y regenera el plan.`);
    }
    return res;
  };

  /** Modo mantenimiento: semanas variadas; la 4.ª es más suave y lleva una prueba de 12 min. */
  C.generateMaintenance = function (profile, unavailable, now, fitness, weeks = 4) {
    const res = { workouts: [], extras: [], notes: [] };
    fitness = fitness || { easyPace: profile.easyPace, baseMin: profile.continuousMin };
    const start = now.hour < 18 ? now.date : C.addDays(now.date, 1);
    const end = C.addDays(start, weeks * 7 - 1), pace = fitness.easyPace, base = Math.max(5, Math.round(fitness.baseMin));
    let i = 0;
    for (let ws = C.mondayOf(start); ws <= end; ws = C.addDays(ws, 7), i++) {
      const cands = Array.from({ length: 7 }, (_, k) => C.addDays(ws, k)).filter(d =>
        d >= start && d <= end && !unavailable.has(d) && !profile.noRun.includes(C.weekday(d)));
      const chosen = pickDays(cands, profile, profile.weeklySessions);
      const cycle = i % 4, L = Math.round(cycle === 3 ? base * 0.8 : base * (1 + 0.05 * cycle));
      const qIdx = firstQualityIdx(chosen, profile);
      chosen.forEach((d, idx) => {
        if (idx === qIdx) res.workouts.push(C.makeWorkout(cycle === 3 ? 'prueba' : 'intervalos', d, L, i, pace, false));
        else if (idx === chosen.length - 1) res.workouts.push(C.makeWorkout('carreraContinua', d, L, i, pace, false));
        else res.workouts.push(C.makeWorkout('rodajeSuave', d, L, i, pace, false));
      });
    }
    res.extras = padelExtras(profile, start, end);
    return res;
  };

  /* ---------- Calendario / reglas ---------- */
  const active = w => w.status === 'planned' || w.status === 'completed';
  C.isIntenseOn = (S, date, exceptId) =>
    S.workouts.some(w => w.date === date && w.id !== exceptId && active(w) && C.INTENSE.has(w.kind)) ||
    S.extras.some(e => e.date === date && e.intense);
  C.violatesIntensity = (S, w, date) =>
    C.INTENSE.has(w.kind) && (C.isIntenseOn(S, C.addDays(date, -1), w.id) || C.isIntenseOn(S, C.addDays(date, 1), w.id));
  C.canAutoPlace = (S, w, date) => {
    if (S.unavailable.includes(date)) return false;
    if (S.profile.noRun.includes(C.weekday(date))) return false;
    if (S.goal.kind !== 'maintain' && date >= S.goal.date) return false;
    if (S.workouts.some(o => o.date === date && o.id !== w.id && active(o))) return false;
    if (S.extras.some(e => e.date === date && e.intense)) return false;
    return !C.violatesIntensity(S, w, date);
  };
  C.nextSlot = (S, w, after, horizon = 3) => {
    for (let n = 1; n <= horizon; n++) { const d = C.addDays(after, n); if (C.canAutoPlace(S, w, d)) return d; }
    return null;
  };
  C.reschedule = (S, w, from) => {
    const slot = C.nextSlot(S, w, from);
    if (slot) return { moved: slot, why: `Movida al ${C.WEEKDAYS[C.weekday(slot)].toLowerCase()} porque es el primer día libre cercano que no junta dos sesiones intensas.` };
    return { moved: null, why: 'No hay un hueco cercano sin juntar sesiones intensas o sobrecargar la semana, así que no recupero esta sesión: es mejor llegar fresco a la siguiente que acumular carga.' };
  };

  /* ---------- Coach por reglas ---------- */
  C.minutesBetween = (runs, fromTs, toTs) => runs.filter(r => { const t = Date.parse(r.start); return t >= fromTs && t < toTs; }).reduce((s, r) => s + r.durationS / 60, 0);

  C.increaseCheck = (runs, profile, nowTs = Date.now()) => {
    if (runs.length < 3) return { ok: false, reasons: [`Todavía tengo pocos datos (${runs.length} carreras registradas); necesito al menos 3 antes de subir la carga.`] };
    const W = 7 * 86400000;
    const last7 = C.minutesBetween(runs, nowTs - W, nowTs + 1000);
    const prior = C.minutesBetween(runs, nowTs - 4 * W, nowTs - W) / 3;
    if (prior > 0 && last7 > prior * 1.1)
      return { ok: false, reasons: [`Esta semana ya llevas ${Math.round(last7)} min, más de un 10 % por encima de tu media reciente (${Math.round(prior)} min/semana); subir más aumentaría el riesgo de sobrecarga.`] };
    const reasons = [];
    const latest = runs.slice().sort((a, b) => Date.parse(b.start) - Date.parse(a.start))[0];
    const mx = C.maxHR(profile);
    if (latest && latest.avgHR) {
      const pct = latest.avgHR / mx;
      if (pct > 0.88) return { ok: false, reasons: [`Tu última carrera tuvo la frecuencia cardíaca media alta (${Math.round(pct * 100)} % de tu máximo${profile.maxHROverride ? '' : ' estimado'}), aunque te sintieras bien.`] };
      reasons.push(`Tu frecuencia cardíaca media fue ${Math.round(pct * 100)} % de tu máximo${profile.maxHROverride ? '' : ' estimado'}.`);
    }
    reasons.push(`La carga de los últimos 7 días (${Math.round(last7)} min) está dentro de un aumento razonable.`);
    return { ok: true, reasons };
  };

  C.evaluate = (run, history, profile, nowTs = Date.now()) => {
    const f = run.feeling;
    const mk = (action, factor, rec, reasons) => ({ action, factor, recovery: rec, reasons, summary: reasons.join(' ') });
    if (!f) return mk('mantener', 1, 0, ['Aún no has registrado cómo te sentiste, así que no cambio nada del plan.']);
    const pain = (f.pain || '').trim();
    if (pain) return mk('reducir', 0.8, 1, [`Has anotado molestias ("${pain}"). Reduzco la próxima sesión un 20 % y añado un día de descanso.`, 'Si el dolor persiste o aumenta, consulta con un profesional sanitario.']);
    const hard = [];
    if (f.rpe >= 8) hard.push(`esfuerzo percibido ${f.rpe}/10`);
    if (f.breathing >= 4) hard.push('respiración muy exigida');
    if (f.fatigue >= 4) hard.push('piernas muy cargadas');
    if (!f.canContinue && f.rpe >= 7) hard.push('no habrías podido seguir');
    if (run.avgHR && run.avgHR > 0.9 * C.maxHR(profile)) hard.push(`pulsaciones medias del ${Math.round(run.avgHR / C.maxHR(profile) * 100)} % de tu máximo`);
    if (hard.length >= 2) return mk('recuperacion', 0.9, 1, [`La sesión fue muy exigente (${hard.join(', ')}). Recorto un 10 % la próxima y dejo un día extra de recuperación.`]);
    if (hard.length === 1) return mk('mantener', 1, 0, [`Hubo una señal de exigencia (${hard[0]}). Mantengo la próxima sesión sin subir carga.`]);
    const easy = f.rpe <= 5 && f.breathing <= 2 && f.fatigue <= 2 && f.canContinue;
    if (!easy) return mk('mantener', 1, 0, [`Sensaciones intermedias (esfuerzo ${f.rpe}/10): ni sobrada ni al límite. Mantengo el plan.`]);
    const chk = C.increaseCheck(history, profile, nowTs);
    if (!chk.ok) return mk('mantener', 1, 0, ['Te has sentido cómodo, pero no subo la carga todavía.', ...chk.reasons]);
    const factor = profile.weightKg > 100 ? 1.05 : 1.08;
    return mk('aumentar', factor, 0, [`Sesión cómoda (esfuerzo ${f.rpe}/10, respiración y piernas bien) y datos coherentes: propongo subir un ${Math.round((factor - 1) * 100)} % el tiempo de esfuerzo de la próxima sesión.`, ...chk.reasons]);
  };

  C.recovery = (runs, nowTs = Date.now()) => {
    if (!runs.length) return { level: 'Sin datos', detail: 'Aún no hay carreras registradas.' };
    const last = runs.slice().sort((a, b) => Date.parse(b.start) - Date.parse(a.start))[0];
    const hours = (nowTs - (Date.parse(last.start) + last.durationS * 1000)) / 3600000;
    let score = hours < 24 ? 1 : hours < 48 ? 2 : 3, why = `Última carrera hace ${Math.max(0, Math.round(hours))} h.`;
    const f = last.feeling;
    if (f) {
      if (f.rpe >= 8) { score--; why += ' Fue muy exigente.'; }
      if (f.pain) { score--; why += ' Anotaste molestias.'; }
      if (f.fatigue >= 4) { score--; why += ' Piernas cargadas.'; }
    }
    return { level: score >= 3 ? 'Alta' : score === 2 ? 'Media' : 'Baja', detail: why + ' (Estimación por reglas; no es una medición.)' };
  };

  const effortMin = items => C.flatten(items).filter(b => EFFORT.has(b.kind)).reduce((s, b) => s + b.min, 0);
  /** Escala la duración de bloques de esfuerzo: máx. +10 %, mín. −30 %. Redondea a 0,5 min (los aumentos, hacia abajo
   *  para no pasarse del tope). Devuelve true si la sesión cambió de verdad. */
  C.scale = (w, factor, explanation) => {
    const f = clamp(factor, 0.7, 1.1), e0 = effortMin(w.items);
    const sc = b => (EFFORT.has(b.kind)
      ? { ...b, min: Math.max(1, f > 1 ? Math.max(b.min, Math.floor(b.min * f * 2) / 2) : Math.round(b.min * f * 2) / 2) } : b);
    w.items = w.items.map(i => (i.t === 'r' ? { ...i, items: i.items.map(sc) } : sc(i)));
    const e1 = effortMin(w.items);
    if (Math.abs(e1 - e0) < 0.01) {
      w.explanation = `Sin cambio efectivo: ${explanation} El ajuste propuesto es demasiado pequeño para notarse en bloques tan cortos; se mantiene la sesión.`;
      return false;
    }
    const pct = Math.round((e1 - e0) / e0 * 100);
    w.explanation = `Ajuste del coach (${pct >= 0 ? '+' : ''}${pct} % real en bloques de esfuerzo, de ${Math.round(e0)} a ${Math.round(e1 * 2) / 2} min): ${explanation}`;
    return true;
  };

  /* ---------- Sesiones por frase: "5x2 min a 7:30 con 2 min caminando, 5 min enfriando" ---------- */
  const num = s => parseFloat(String(s).replace(',', '.'));
  function paceOf(txt, fallback) {
    const m = /(\d{1,2}):(\d{2})/.exec(txt || '');
    if (m) return +m[1] * 60 + +m[2];
    const k = /(\d+(?:[.,]\d+)?)\s*km\/h/i.exec(txt || '');
    if (k) return C.paceFromKmh(num(k[1]));
    return fallback;
  }
  function kindOf(txt) {
    const t = txt.toLowerCase();
    if (/calent/.test(t)) return 'calentamiento';
    if (/enfri/.test(t)) return 'enfriamiento';
    if (/camin|and(ando|ar)/.test(t)) return 'caminar';
    if (/recup|trot/.test(t)) return 'recuperacion';
    if (/progres/.test(t)) return 'progresion';
    return 'carrera';
  }
  /** Duración en minutos de «2 min», «90 s», «30 seg». */
  function dur(txt) {
    const m = /(\d+(?:[.,]\d+)?)\s*(min\w*|seg\w*|s\b)/i.exec(txt || '');
    if (!m) return null;
    return /^min/i.test(m[2]) ? num(m[1]) : Math.round(num(m[1]) / 60 * 100) / 100;
  }
  C.parseSession = (text, easyPace) => {
    const items = [], errors = [];
    const defaults = { calentamiento: 600, enfriamiento: 720, caminar: 720, recuperacion: 720, progresion: easyPace + 30, carrera: easyPace };
    const segs = text.split(/[;,\n]|\s+y\s+(?=\d)/).map(s => s.trim()).filter(Boolean);
    for (const seg of segs) {
      const rep = /^(\d+)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(min\w*|seg\w*|s\b)?\s*(.*)$/i.exec(seg);
      if (rep) {
        const reps = +rep[1], runMin = /^s/i.test(rep[3] || '') ? Math.round(num(rep[2]) / 60 * 100) / 100 : num(rep[2]);
        const [first, second] = rep[4].split(/\s+con\s+/i);
        const runKind = kindOf(first || '');
        const items2 = [C.mkBlock(runKind, runMin, paceOf(first, defaults[runKind]))];
        if (second) {
          const mm = dur(second);
          if (mm != null) { const k = kindOf(second); items2.push(C.mkBlock(k === 'carrera' ? 'caminar' : k, mm, paceOf(second, defaults[k === 'carrera' ? 'caminar' : k]))); }
          else errors.push(`No entiendo la pausa: «${second}»`);
        }
        items.push(C.mkRepeat(reps, items2));
        continue;
      }
      const one = dur(seg);
      if (one != null) { const k = kindOf(seg); items.push(C.mkBlock(k, one, paceOf(seg, defaults[k]))); }
      else errors.push(`No entiendo: «${seg}»`);
    }
    return { items, errors };
  };

  /* ---------- Strava → carrera ---------- */
  C.stravaToRun = (a, detail) => {
    const d = detail || a;
    const splits = (d.splits_metric || []).map((s, i) => ({
      km: i + 1, paceSec: s.moving_time && s.distance ? s.moving_time / (s.distance / 1000) : 0,
      hr: s.average_heartrate || null, partial: s.distance < 950,
    })).filter(s => s.paceSec > 0);
    return {
      id: C.uid(), stravaId: a.id, source: 'strava', name: a.name,
      date: (a.start_date_local || a.start_date).slice(0, 10), start: a.start_date,
      distanceM: a.distance, durationS: a.moving_time,
      avgHR: a.average_heartrate || null, maxHR: a.max_heartrate || null,
      cadence: a.average_cadence ? Math.round(a.average_cadence * 2) : null,   // Strava da pasos de una pierna
      elevation: a.total_elevation_gain ?? null, splits,
      feeling: null, evaluation: null, adviceFactor: null, adviceRecovery: null, adviceHandled: false, workoutId: null,
    };
  };
  C.isRunType = a => ['Run', 'TrailRun', 'VirtualRun'].includes(a.sport_type || a.type);
  C.isDuplicateRun = (runs, r) => runs.some(o => (r.stravaId && o.stravaId === r.stravaId) ||
    (Math.abs(Date.parse(o.start) - Date.parse(r.start)) < 120000 && r.distanceM > 0 && Math.abs(o.distanceM - r.distanceM) / r.distanceM < 0.05));
  C.avgPace = r => (r.distanceM > 0 ? r.durationS / (r.distanceM / 1000) : 0);

  /* ---------- Forma real, previsión, comparación, objetivos ---------- */
  const med = a => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  C.isMostlyContinuous = (r, medianPace) => {
    const full = (r.splits || []).filter(s => !s.partial);
    if (full.length >= 3) {
      const ps = full.map(s => s.paceSec), mx = Math.max(...ps), mn = Math.min(...ps);
      if (mn > 0) return mx / mn < 1.30;
    }
    return C.avgPace(r) <= medianPace * 1.10;
  };
  /** Perfil de entrenamiento estimado con datos RECENTES (42 dias).
   * Independiente de los valores previos del perfil: nunca se limita a 1,5 veces
   * un parametro antiguo ni utiliza carreras de hace meses para valorar la forma.
   * IMPORTANTISIMO: Strava moving_time no demuestra minutos sin caminar.
   * baseMin es una PROXY CONSERVADORA para el plan, no un record verificado.
   */
  C.estimateFitness = (runs, profile, nowTs = Date.now()) => {
    const DAY = 86400000;
    const recent = (runs || []).filter(r => {
      const ts = Date.parse(r.start || (r.date ? r.date + 'T12:00:00Z' : ''));
      return Number.isFinite(ts) && ts >= nowTs - 42 * DAY && ts <= nowTs + DAY &&
        r.distanceM >= 800 && r.durationS >= 300 && r.durationS <= 5 * 3600 &&
        C.avgPace(r) >= 240 && C.avgPace(r) <= 1500;
    }).sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
    const weeklyMinutes = recent.filter(r => Date.parse(r.start) >= nowTs - 28 * DAY)
      .reduce((a, r) => a + r.durationS / 60, 0) / 4;
    const sample = recent.slice(0, 8);
    const longestMovingMin = sample.length ? Math.max(...sample.map(r => r.durationS / 60)) : 0;
    if (recent.length < 2) return {
      easyPace: profile.easyPace, baseMin: profile.continuousMin, weeklyMinutes,
      runsConsidered: recent.length, fromData: false, longestMovingMin,
      confidence: 'insuficiente', windowDays: 42,
      note: `Solo ${recent.length} carrera(s) en los últimos 42 días: conservo el último perfil provisional y no uso salidas antiguas como referencia actual.`
    };
    const paces = sample.map(C.avgPace);
    const easyEfforts = sample.filter(r => r.feeling &&
      Number(r.feeling.rpe) <= 6 && Number(r.feeling.breathing) <= 3 &&
      !(r.feeling.pain || '').trim());
    // Con sensaciones suficientemente numerosas usamos esas salidas; si no,
    // suavizamos el ritmo medio observado para no prescribir como facil un intervalo.
    const paceSample = easyEfforts.length >= 2 ? easyEfforts.slice(0, 5).map(C.avgPace) : paces.slice(0, 6);
    const easyPace = Math.round(clamp(med(paceSample) + (easyEfforts.length >= 2 ? 0 : 15), 260, 1200));
    let baseMin = 5;
    for (const run of sample) {
      const splits = (run.splits || []).filter(x => !x.partial && x.paceSec > 0);
      const uniform = splits.length >= 3 && Math.max(...splits.map(x => x.paceSec)) / Math.min(...splits.map(x => x.paceSec)) <= 1.28;
      // Una duracion en movimiento de 40 min puede incluir caminar o pausas.
      // Estimamos entre 70-82 % como referencia prudente; NO certifica continuidad.
      const factor = uniform ? 0.82 : 0.70;
      baseMin = Math.max(baseMin, Math.round(run.durationS / 60 * factor));
    }
    baseMin = Math.max(5, Math.min(baseMin, 60));
    const confidence = recent.length >= 5 && easyEfforts.length >= 2 ? 'media' : 'baja';
    return {
      easyPace, baseMin, weeklyMinutes, runsConsidered: recent.length,
      fromData: true, longestMovingMin, confidence, windowDays: 42,
      latestRunDate: recent[0].date,
      note: `Perfil calculado con ${recent.length} carreras de los últimos 42 días: ritmo cómodo orientativo ${C.fmtPace(easyPace)} min/km y base de resistencia estimada ${baseMin} min. Salida más larga: ${Math.round(longestMovingMin)} min en movimiento. No se puede verificar que todo ese tiempo fuera sin caminar.`
    };
  };

  /** Previsión con fórmula de Riegel. No inventa: si faltan datos devuelve {ok:false, reason}. */
  C.predictRace = (distanceKm, runs, nowTs = Date.now()) => {
    const DAY = 86400000;
    const ef = runs.filter(r => { const t = Date.parse(r.start); return t >= nowTs - 56 * DAY && t <= nowTs && r.distanceM >= 2000 && r.durationS >= 600; });
    if (ef.length < 3) return { ok: false, reason: `Necesito al menos 3 carreras de 2 km o más en las últimas 8 semanas; ahora tengo ${ef.length}.` };
    const longest = Math.max(...ef.map(r => r.distanceM / 1000));
    if (longest < distanceKm * 0.5) return { ok: false, reason: `Tu salida más larga reciente es de ${C.fmtKm(longest)} km; para estimar ${C.fmtKm(distanceKm)} km necesito al menos ${C.fmtKm(distanceKm / 2)} km en una sola salida.` };
    const proj = ef.map(r => r.durationS * Math.pow(distanceKm / (r.distanceM / 1000), 1.06)).sort((a, b) => a - b).slice(0, 3);
    const mid = proj.reduce((s, x) => s + x, 0) / proj.length, extrap = Math.max(1, distanceKm / longest);
    const low = mid * Math.max(0.80, 0.90 - 0.03 * (extrap - 1)), high = mid * Math.min(1.30, 1.06 + 0.05 * (extrap - 1));
    const confidence = ef.length >= 6 && longest >= distanceKm * 0.9 ? 'Alta' : ef.length >= 4 && longest >= distanceKm * 0.7 ? 'Media' : 'Baja';
    return { ok: true, distanceKm, low, mid, high, confidence,
      basis: `Calculado con tus ${proj.length} mejores carreras recientes (fórmula de Riegel). Parte de entrenamientos, no de una carrera a tope: el día de la carrera puedes ir más rápido. La horquilla refleja esa incertidumbre${extrap > 1 ? ` y que ${C.fmtKm(distanceKm)} km es más de lo que has corrido de una vez` : ''}.` };
  };

  C.compareRuns = (old, nw) => {
    const ratio = old.distanceM > 0 ? nw.distanceM / old.distanceM : 0, dp = C.avgPace(nw) - C.avgPace(old);
    const lines = [`Distancia: ${C.fmtKm(old.distanceM / 1000)} km → ${C.fmtKm(nw.distanceM / 1000)} km`,
      `Ritmo: ${C.fmtPace(C.avgPace(old))} → ${C.fmtPace(C.avgPace(nw))} min/km (${dp <= 0 ? '' : '+'}${Math.round(dp)} s/km)`];
    const faster = dp < -3, slower = dp > 3;
    let verdict, dh = null;
    if (old.avgHR && nw.avgHR) {
      dh = nw.avgHR - old.avgHR;
      lines.push(`FC media: ${Math.round(old.avgHR)} → ${Math.round(nw.avgHR)} lpm (${dh <= 0 ? '' : '+'}${Math.round(dh)})`);
      if (faster && dh <= 2) verdict = 'Mejora: más rápido con pulsaciones iguales o menores.';
      else if (faster && dh > 4) verdict = 'Más rápido, pero a más esfuerzo cardíaco: no es una mejora clara.';
      else if (slower && dh < -4) verdict = 'Más lento y con menos pulsaciones: sesión más suave.';
      else if (slower && dh >= 0) verdict = 'Más lento con pulsaciones iguales o mayores: puede ser fatiga o calor.';
      else verdict = 'Muy parecidas: sin cambio apreciable.';
    } else {
      lines.push('FC media: sin datos en alguna de las dos.');
      verdict = faster ? 'Más rápido (sin pulsaciones para saber a qué coste).' : slower ? 'Más lento (sin pulsaciones para interpretarlo).' : 'Muy parecidas.';
    }
    if (!(ratio > 0.8 && ratio < 1.25)) verdict += ' Ojo: las distancias son bastante distintas, así que la comparación es orientativa.';
    return { verdict, lines };
  };

  C.nextSunday = s => C.addDays(s, (7 - C.weekday(s)) % 7);
  C.targetDate = (weeks, todayStr) => C.nextSunday(C.addDays(todayStr, weeks * 7));
  C.targetPace = g => (g.kind === 'time' && g.targetTimeSec && g.distanceKm > 0 ? g.targetTimeSec / g.distanceKm : null);

  /** Objetivos razonables según lo que ya has corrido. No propone nada que los datos no respalden. */
  C.suggestGoals = (lastClosed, runs, fitness, todayStr, nowTs = Date.now()) => {
    const out = [], DAY = 86400000;
    const longest = Math.max(0, ...runs.filter(r => Date.parse(r.start) >= nowTs - 42 * DAY).map(r => r.distanceM / 1000));
    if (longest < 4.8) out.push({ title: 'Completar 5 km', detail: `Tu salida más larga reciente es de ${C.fmtKm(longest)} km. Un plan de unas 6 semanas te lleva a los 5 km.`, kind: 'finish', distanceKm: 5, weeks: 6, targetTimeSec: null });
    if (longest >= 4.8) {
      const p = C.predictRace(5, runs, nowTs);
      let cur = p.ok ? p.mid : null;
      if (cur == null && lastClosed && lastClosed.status === 'achieved' && Math.abs(lastClosed.distanceKm - 5) < 0.6) cur = lastClosed.resultSec;
      if (cur) {
        const target = Math.floor(cur * 0.95 / 30) * 30;
        if (target >= 900) out.push({ title: `5 km en menos de ${C.fmtDur(target)}`, detail: `Ahora rondas los ${C.fmtDur(cur)} (estimado). Mejorar un 5 % en 8 semanas es exigente pero razonable.`, kind: 'time', distanceKm: 5, weeks: 8, targetTimeSec: target });
      }
    }
    if (longest >= 5 && fitness.baseMin >= 25) out.push({ title: 'Completar 10 km', detail: `Ya corres más de 5 km y unos ${Math.round(fitness.baseMin)} min seguidos. Un plan de unas 12 semanas es prudente.`, kind: 'finish', distanceKm: 10, weeks: 12, targetTimeSec: null });
    out.push({ title: 'Mantener y mejorar la forma', detail: 'Sin carrera: la app prepara semanas variadas y se adapta a lo que hagas, con una semana más suave cada cuatro.', kind: 'maintain', distanceKm: 0, weeks: 12, targetTimeSec: null });
    return out;
  };

  /** ¿Se ha cumplido (o fallado) el objetivo? null = todavía no se puede decir. */
  C.evaluateGoal = (g, runs, today) => {
    if (g.status !== 'active' || g.kind === 'maintain' || g.date > today) return null;
    const need = g.distanceKm * 1000 * 0.95;
    const r = runs.filter(x => Math.abs(C.diffDays(x.date, g.date)) <= 1 && x.distanceM >= need)
      .sort((a, b) => Math.abs(C.diffDays(a.date, g.date)) - Math.abs(C.diffDays(b.date, g.date)) || b.distanceM - a.distanceM)[0];
    if (r) {
      const resultSec = r.durationS * (g.distanceKm * 1000 / r.distanceM);   // proporcional si corriste algo más de la distancia
      const ok = g.kind !== 'time' || (g.targetTimeSec && resultSec <= g.targetTimeSec);
      return { status: ok ? 'achieved' : 'missed', run: r, resultSec, noRun: false };
    }
    if (C.diffDays(g.date, today) > 1) return { status: 'missed', run: null, resultSec: null, noRun: true };
    return null;   // aún puede llegar la carrera (se sincroniza más tarde)
  };

  /* ---------- Otras actividades de Strava (pádel, bici…) → carga ---------- */
  C.SPORT_NAMES = { Walk: 'Caminata', Hike: 'Senderismo', Ride: 'Bicicleta', VirtualRide: 'Bicicleta', EBikeRide: 'Bicicleta eléctrica', Swim: 'Natación', Yoga: 'Yoga', WeightTraining: 'Fuerza', Workout: 'Entrenamiento', HighIntensityIntervalTraining: 'HIIT', Crossfit: 'Crossfit', Tennis: 'Tenis', Padel: 'Pádel', Pickleball: 'Pickleball', Squash: 'Squash', Racquetball: 'Raquetball', Soccer: 'Fútbol', Basketball: 'Baloncesto', Elliptical: 'Elíptica', Rowing: 'Remo', Pilates: 'Pilates' };
  const INTENSE_SPORTS = new Set(['Tennis', 'Padel', 'Pickleball', 'Squash', 'Racquetball', 'Soccer', 'Basketball', 'HighIntensityIntervalTraining', 'Crossfit']);
  C.stravaToExtra = (a, maxHR) => {
    const sport = a.sport_type || a.type || 'Workout', min = (a.moving_time || a.elapsed_time || 0) / 60;
    const hrHigh = !!(a.average_heartrate && maxHR && a.average_heartrate > 0.85 * maxHR);
    return { id: C.uid(), stravaId: a.id, date: (a.start_date_local || a.start_date).slice(0, 10), title: C.SPORT_NAMES[sport] || sport,
      durationMin: Math.round(min), intense: INTENSE_SPORTS.has(sport) ? min >= 20 : hrHigh, sport };
  };

  /* ---------- Peso ---------- */
  C.weightStats = (weights, todayStr) => {
    const w = weights.slice().sort((a, b) => a.date.localeCompare(b.date));
    if (!w.length) return null;
    const last = w[w.length - 1];
    const at = days => { const t = C.addDays(todayStr, -days); const older = w.filter(x => x.date <= t); return older.length ? older[older.length - 1].kg : null; };
    const d30 = at(30), d90 = at(90);
    return { current: last.kg, date: last.date, change30: d30 != null ? last.kg - d30 : null, change90: d90 != null ? last.kg - d90 : null,
      min: Math.min(...w.map(x => x.kg)), max: Math.max(...w.map(x => x.kg)) };
  };

  /* ---------- Chat por reglas ---------- */
  const fold = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  C.chat = (text, S, nowTs = Date.now()) => {
    const t = fold(text), has = ws => ws.some(w => t.includes(w));
    const today = C.fmtDate(new Date(nowTs));
    const next = S.workouts.filter(w => w.status === 'planned' && w.date >= today && w.kind !== 'carreraObjetivo').sort((a, b) => a.date.localeCompare(b.date))[0];
    const nn = next ? `«${next.title}» (${C.longDate(next.date)})` : 'ninguna sesión pendiente';
    const plain = text => ({ text });
    if (has(['dolor', 'molest', 'lesion', 'pinchazo', 'me duele'])) {
      if (!next) return plain('Siento lo de las molestias. No tienes sesiones pendientes; descansa y, si el dolor persiste, consulta con un profesional sanitario.');
      return { text: `Con molestias no conviene subir ni mantener la carga. Te propongo recortar ${nn} un 20 % y dejar un día más de descanso. Si el dolor persiste, consulta con un profesional sanitario.`, proposal: { title: `Reducir «${next.title}» un 20 % y dar un día extra`, workoutId: next.id, factor: 0.8, recovery: 1, reason: 'Has mencionado molestias o dolor; prefiero bajar la carga y esperar a ver cómo evolucionan.' } };
    }
    if (has(['cansad', 'fatiga', 'agotad', 'pesad', 'cargad'])) {
      if (!next) return plain('Entiendo. No tienes sesiones pendientes, así que descansa lo que necesites.');
      return { text: `Si vas cargado, lo mejor es recuperar. Propongo recortar ${nn} un 10 % y retrasarla un día si hay hueco.`, proposal: { title: `Reducir «${next.title}» un 10 % y retrasarla un día`, workoutId: next.id, factor: 0.9, recovery: 1, reason: 'Has comentado cansancio; recorto un poco la próxima sesión y dejo un día más de recuperación.' } };
    }
    if (has(['comodo', 'facil', 'sobrado', 'sobrada', 'aument', 'subir', 'mas duro', 'mas intens'])) {
      if (!next) return plain('No tienes sesiones pendientes que modificar.');
      const chk = C.increaseCheck(S.runs, S.profile, nowTs);
      if (!chk.ok) return plain('Me alegra que fuera cómodo, pero de momento no subiría la carga. ' + chk.reasons.join(' '));
      const factor = S.profile.weightKg > 100 ? 1.05 : 1.08, pct = Math.round((factor - 1) * 100);
      return { text: `Los datos lo permiten. ${chk.reasons.join(' ')} Te propongo subir un ${pct} % el tiempo de esfuerzo de ${nn}. ¿Lo aplico?`, proposal: { title: `Subir «${next.title}» un ${pct} %`, workoutId: next.id, factor, recovery: 0, reason: 'Te sientes cómodo y los datos lo respaldan. ' + chk.reasons.join(' ') } };
    }
    if (has(['no puedo', 'no voy a poder', 'hoy no', 'mover', 'cambiar de dia', 'no llego'])) {
      if (!next) return plain('No tienes sesiones pendientes que mover.');
      const r = C.reschedule(S, next, next.date);
      if (r.moved) return { text: `Puedo mover ${nn} al ${C.longDate(r.moved)}. ${r.why}`, proposal: { title: `Mover «${next.title}» al ${C.longDate(r.moved)}`, workoutId: next.id, factor: 1, recovery: 0, moveTo: r.moved, reason: r.why } };
      return plain(r.why + ' Si quieres, puedes moverla tú a otro día desde el calendario.');
    }
    if (has(['prediccion', 'previsio', 'cuanto haria', 'en cuanto', 'tiempo estimado'])) {
      const parts = [5, 10].map(k => { const p = C.predictRace(k, S.runs, nowTs); return p.ok ? `${k} km: entre ${C.fmtDur(p.low)} y ${C.fmtDur(p.high)} (central ${C.fmtDur(p.mid)}, confianza ${p.confidence.toLowerCase()})` : `${k} km: ${p.reason}`; });
      return plain(parts.join('\n') + '\nSon estimaciones a partir de tus entrenamientos, no promesas.');
    }
    if (has(['siguiente objetivo', 'nuevo objetivo', 'que objetivo', 'proximo objetivo'])) {
      const fit = C.estimateFitness(S.runs, S.profile, nowTs);
      const sug = C.suggestGoals(null, S.runs, fit, today, nowTs);
      return plain('Con lo que has corrido te propondría:\n' + sug.map(x => '· ' + x.title).join('\n') + '\nPuedes elegir uno en Inicio → Objetivos.');
    }
    if (has(['cuanto falta', 'dias para', 'dias quedan', 'cuando es la carrera'])) {
      if (S.goal.kind === 'maintain') return plain('Ahora mismo estás en modo mantenimiento: no hay fecha de carrera. Puedes fijar un nuevo objetivo en Inicio → Objetivos.');
      const d = C.diffDays(today, S.goal.date);
      return plain(`Faltan ${Math.max(d, 0)} días para «${S.goal.title}» (${C.longDate(S.goal.date)}).`);
    }
    if (has(['resumen', 'semana', 'como voy', 'progreso'])) {
      const ws = C.mondayOf(today), we = C.addDays(ws, 7);
      const wr = S.runs.filter(r => r.date >= ws && r.date < we);
      return plain(`Esta semana: ${wr.length} carrera(s), ${C.fmtKm(wr.reduce((s, r) => s + r.distanceM / 1000, 0))} km y ${Math.round(wr.reduce((s, r) => s + r.durationS / 60, 0))} min. Próxima sesión: ${nn}.`);
    }
    return plain('De momento entiendo cosas como: «el entrenamiento me resultó cómodo, ¿lo aumentamos?», «me duele…», «estoy cansado», «hoy no puedo entrenar», «¿cuánto falta para la carrera?», «resumen de la semana», «¿en cuánto haría 5 km?» o «siguiente objetivo». Soy un coach basado en reglas, no un modelo de lenguaje.');
  };

  root.RCA = C;
  if (typeof module !== 'undefined' && module.exports) module.exports = C;
})(typeof window !== 'undefined' ? window : globalThis);

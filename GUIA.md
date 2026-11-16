# Running Coach AI (web) — Guía: qué haces en el ordenador y qué en el iPhone

Sin Xcode, sin pagar nada. Es una web instalable (PWA) que se publica gratis en GitHub Pages. **Lo pesado se hace una sola vez desde el ordenador (más cómodo); en el iPhone solo instalas y usas.**

> Estado honesto: la lógica y la interfaz están probadas en un navegador de pruebas (Chrome móvil simulado), **no en tu iPhone**. La conexión con Strava se probó con un servidor simulado; **no con Strava real**. Si algo falla, dime qué ves y lo arreglo.

## Reparto de tareas

| Tarea | Dónde | Cuándo |
|---|---|---|
| Crear cuenta de GitHub y repositorio `running-coach` (público) | 💻 Ordenador | Una vez |
| Subir los archivos del zip (arrastrar y soltar) y activar Pages | 💻 Ordenador | Una vez (y al actualizar) |
| Crear la app de Strava (strava.com/settings/api) | 💻 Ordenador | Una vez |
| Crear el Worker en Cloudflare (pegar `worker.js`, 3 variables) | 💻 Ordenador | Una vez |
| Obtener el código de Strava y pasártelo al iPhone (Notas/WhatsApp/correo) | 💻 Ordenador *(o iPhone)* | Una vez |
| **Abrir la URL en Safari → Compartir → Añadir a pantalla de inicio** | 📱 **iPhone (obligatorio)** | Una vez |
| Pegar la dirección del Worker y el código en Ajustes → Strava | 📱 **iPhone (obligatorio)** | Una vez |
| Poner tus datos reales en Ajustes (minutos seguidos, ritmo cómodo) | 📱 iPhone | Una vez |
| Sincronizar, sensaciones, peso, mover sesiones, usar el coach | 📱 iPhone | A diario |
| Exportar copia de seguridad | 📱 iPhone | De vez en cuando |
| Actualizar la app a una versión nueva (volver a subir archivos) | 💻 Ordenador | Cuando haya cambios |

**Por qué el iPhone es obligatorio en dos pasos:** los datos (plan, carreras, peso) viven en el almacenamiento del icono instalado en *ese* iPhone. Lo que hagas en el navegador del ordenador es otra copia distinta. Usa siempre el icono.

---

## Parte 1 — Publicar la web (💻 ordenador, ≈ 10 min)

1. Descomprime `RunningCoachAI-Web.zip` (todos los archivos van sueltos, sin carpetas).
2. En **github.com** crea tu cuenta con tu correo.
3. **New repository** → nombre `running-coach` → **Public** (necesario para Pages gratis; la web no contiene claves ni datos tuyos) → Create.
4. **Add file → Upload files** → arrastra **todos** los archivos descomprimidos → **Commit changes**.
5. **Settings → Pages** → *Deploy from a branch* → rama `main`, carpeta `/ (root)` → Save.
6. En 1–2 min tendrás `https://TUNOMBRE.github.io/running-coach/`.

**Para actualizar más adelante:** repite el paso 4 con los archivos nuevos (sobrescribe). En el iPhone cierra y reabre el icono; si no cambia, ábrelo una vez en Safari y vuelve.

## Parte 2 — Instalar en el iPhone (📱, 1 min)

Abre la dirección en **Safari** → Compartir → **Añadir a pantalla de inicio**. A partir de ahora, solo el icono.

**Primer uso:** Ajustes → pon *minutos que corres seguidos* y *ritmo cómodo* reales → **Regenerar plan**. Más adelante la app te propone ajustarlos sola con tus carreras (tarjeta «Revisión semanal»).

## Parte 3 — Conectar Strava (≈ 25 min, casi todo 💻)

Strava no permite poner su «clave secreta» en una web, así que usamos un puente gratuito de Cloudflare (no guarda nada).

**A) App de Strava (💻).** strava.com/settings/api → crea la aplicación (nombre `Running Coach`; sitio web: tu dirección de GitHub Pages). *Authorization Callback Domain*: tras el paso B. Apunta **Client ID** y **Client Secret** (privado: no lo pegues en GitHub ni en chats).

**B) Worker de Cloudflare (💻).**
1. dash.cloudflare.com → cuenta gratuita → **Workers & Pages → Create → Create Worker** → Deploy.
2. **Edit code** → borra todo → pega el contenido de `worker.js` → Deploy.
3. **Settings → Variables and Secrets**: `STRAVA_CLIENT_ID` (texto), `STRAVA_CLIENT_SECRET` (secreto), `APP_ORIGIN` = `https://TUNOMBRE.github.io` (sin barra final ni ruta). Despliega de nuevo.
4. Apunta la dirección del Worker (`https://…workers.dev`).

**C) Cerrar el círculo.**
1. (💻) En strava.com/settings/api, *Authorization Callback Domain* = dominio del Worker sin `https://`.
2. (💻) Abre `DIRECCION_DEL_WORKER/auth?return=manual`, autoriza, pulsa **Copiar código** y mándatelo al iPhone (Notas, WhatsApp, correo).
3. (📱) En la app: Ajustes → Strava → pega la dirección del Worker → pega el código en *Código* → **Usar código**.
4. (📱) Inicio → **Sincronizar ahora**.

Cada vez que corras: abre la app y pulsa **Sincronizar** (no hay importación en segundo plano). Trae también pádel, bici, etc. como «otras actividades» (últimos 120 días).

---

## Qué hace la app

| | |
|---|---|
| Plan hasta tu objetivo, con semana suave cada 4 y puesta a punto; lunes sin correr (pádel), martes/jueves preferentes | ✔ |
| Calendario semana/mes, mover sesiones, días no disponibles, otras actividades; nunca dos sesiones intensas seguidas | ✔ |
| Sesiones por bloques con repeticiones, km/h ↔ min/km | ✔ |
| **Crear sesión escribiendo una frase** («5x2 min a 7:30 con 2 min caminando») y plantillas. Las que creas o editas tú **no se borran** al regenerar | ✔ |
| Carreras desde Strava (distancia, tiempo, FC, parciales/km) | ✔ (no probado con Strava real) |
| Sensaciones + evaluación por reglas + propuesta que aceptas o rechazas | ✔ |
| **Después de la carrera:** detecta si la conseguiste, pasa a modo mantenimiento (plan de 4 semanas que se renueva solo) y te sugiere el siguiente objetivo (completar distancia, bajar tiempo, 10 km, mantener) o te deja crear el tuyo | ✔ |
| **Revisión semanal:** estima tu forma real con tus últimas carreras y propone replanificar (tú aceptas) | ✔ |
| **Peso** manual con gráfica y variación 30/90 días | ✔ |
| **Actividad:** minutos semanales de correr + otras actividades | ✔ |
| **Previsión** de 5 y 10 km (fórmula de Riegel, con horquilla; si faltan datos, no se inventa) y **comparar dos carreras** | ✔ |
| Coach por reglas (no es un modelo de lenguaje; entiende pocas frases) | ✔ |
| Apple Salud (peso automático, pasos, FC reposo, VO₂ máx.) | ✘ una web no puede leerlo |
| Mapa GPS, zonas de FC | ✘ |
| Notificaciones, Apple Watch / AirPods, importación en segundo plano | ✘ |
| Sincronizar entre varios dispositivos | ✘ (cada dispositivo tiene sus datos; usa Exportar/Importar copia) |

**Haz copias:** Ajustes → *Exportar copia*. Si borras datos del sitio o desinstalas el icono, se pierden.

### Aviso
Es una ayuda de entrenamiento, no una pauta médica. Con 110 kg y poco historial, no subas la carga más rápido de lo que te proponga la app y consulta con un profesional sanitario si notas dolor que no cede.

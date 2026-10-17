# DESIGN.md · M3.1-S05 · React Auth State + rutas protegidas

Alcance de este documento: pantalla de registro, pantalla de login (con «Recordarme»), estados de sesión (cargando, error de red/servidor, sesión expirada), menú de usuario del header con «Salir» y «Cerrar sesión en todos lados» (y su variante en modo Development), confirmación de «Cerrar sesión en todos lados» y el contenedor protegido para futuras páginas de cuenta. Fuera de alcance: «Olvidé mi contraseña» y verificación de email (S08), página de perfil (S07). No se muestra ningún enlace ni texto que remita a esas funciones.

No hay marca propia para auth: todo reutiliza el lenguaje visual existente (`frontend/src/index.css`, `frontend/src/App.css`, `frontend/src/components/projects/projects.css`, `ProjectActionsMenu`, `ProjectDialog`, `StatusPill`/`ServiceCard`). Solo se agregan los tokens imprescindibles para cumplir WCAG 2.2 AA donde los existentes no llegan (ver «Tokens de color»).

Stack: React 19 + TypeScript + Vite existentes en `frontend/`. Sin react-router (ruteo a mano por query string, extendiendo `frontend/src/lib/workspaceLocation.ts`), sin dependencias nuevas de UI, CSS plano (sin Tailwind). Texto en español rioplatense con voseo, igual que el resto de la app («Subí», «Intentá», «Revisá»).

Archivo de estilos propuesto: `frontend/src/components/auth/auth.css` (prefijos de clase `auth-` y `user-menu`), importado por el módulo de auth.

---

## 1. Arquetipo y objetivo de conversión

**Arquetipo: app de una sola página (SPA de herramienta) — pantallas de autenticación con formulario de una sola tarea**, embebidas en la SPA existente (Mis proyectos + Workspace/Editor). Densidad baja, una columna, una acción primaria por pantalla, navegación mínima (sin menú global en las pantallas anónimas).

Objetivos de conversión, por pantalla:

| Pantalla | Qué debe hacer el visitante | Elemento que lo consigue |
|---|---|---|
| Login | Entrar y volver exactamente a donde quería ir (deep link restaurado) | Botón primario de ancho completo «Iniciar sesión» |
| Registro | Crear la cuenta y pasar al login | Botón primario «Crear cuenta», luego «Ir a iniciar sesión» en el panel de registro recibido |
| Error de sesión | Recuperarse de un fallo de red sin perder la sesión | Botón primario «Reintentar» |
| Menú de usuario | Salir de forma explícita y segura | Ítems «Salir» y «Cerrar sesión en todos lados» |

Objetivo secundario transversal: **nunca** mostrar contenido privado mientras la sesión no está resuelta, y nunca confundir un error de red con «sesión cerrada».

---

## 2. Tokens de color

### 2.1 Tokens existentes que se reutilizan tal cual (definidos en `index.css`)

| Token | Claro | Oscuro | Uso en auth |
|---|---|---|---|
| `--bg` (superficie nivel 0, página y tarjetas) | `#ffffff` | `#16171d` | Fondo de página, tarjeta de auth, inputs, popover del menú |
| `--code-bg` (superficie nivel 1, panel) | `#f4f3ec` | `#1f2028` | Hover de ítems de menú, inputs en solo lectura, botón deshabilitado |
| Superficie nivel 2 (popover/diálogo) | `--bg` + borde `--border` + sombra `0 6px 20px rgba(0,0,0,0.18)` | `--bg` + borde `--border` + misma sombra | Lista del menú de usuario, diálogo de confirmación (patrón `.project-menu__list` y `.projects-dialog`) |
| `--text-h` (texto primario) | `#08060d` | `#f3f4f6` | Títulos, labels, texto de banners, valor de inputs |
| `--text` (texto secundario) | `#6b6375` | `#9ca3af` | Intro, hints, texto auxiliar, texto de elemento deshabilitado |
| `--border` (borde decorativo) | `#e5e4e7` | `#2e303a` | Borde de la tarjeta, del trigger del menú, separadores. **No** se usa como borde de input (no llega a 3:1) |
| `--accent` (anillo de foco) | `#aa3bff` | `#c084fc` | Solo el `:focus-visible` global existente (outline 2 px, offset 2 px). No se usa como color de texto ni de fondo de botón en auth |
| `--ok` / `--ok-bg` (éxito) | `#1a9e5a` / `rgba(26,158,90,0.1)` → `#e8f5ef` compuesto | `#4ade80` / `rgba(74,222,128,0.15)` → `#1e352c` | Borde izquierdo + fondo del banner de éxito |
| `--warn` / `--warn-bg` (advertencia) | `#b3760f` / `rgba(179,118,15,0.12)` → `#f6efe2` | `#fbbf24` / `rgba(251,191,36,0.15)` → `#38301e` | Banner «sesión terminada» |
| `--error` / `--error-bg` (error) | `#d1373f` / `rgba(209,55,63,0.1)` → `#faebec` | `#f87171` / `rgba(248,113,113,0.15)` → `#382529` | Texto de error de campo, borde de input inválido, borde + fondo de alerta |
| `--neutral` / `--neutral-bg` (info) | `#6b6375` / `rgba(107,99,117,0.1)` → `#f0eff1` | `#9ca3af` / `rgba(156,163,175,0.15)` → `#2a2c33` | Banner informativo, pastilla «Modo desarrollo» |

### 2.2 Tokens nuevos (solo los que hacen falta para AA), definidos en `auth.css` a nivel `:root` con su variante `@media (prefers-color-scheme: dark)`

Motivo: medido, `#ffffff` sobre `--accent #aa3bff` da **4.39:1** (no llega a 4.5:1 para el texto de 13–16 px de un botón) y `--accent #aa3bff` como color de enlace sobre blanco también da **4.39:1**. En oscuro, el patrón existente `color: #fff` sobre `#c084fc` da **2.64:1**. Y `--border #e5e4e7` sobre blanco da **1.27:1**, insuficiente como borde identificador de un input (WCAG 1.4.11 pide 3:1). No se tocan los tokens globales (cambiaría toda la app, fuera de alcance): se agregan tokens con nombre propio, misma familia de tono violeta.

| Token nuevo | Claro | Oscuro | Uso |
|---|---|---|---|
| `--auth-accent` (acento base) | `#9333ea` | `#c084fc` | Fondo del botón primario, color de enlaces de auth, borde de input en foco, `accent-color` del checkbox |
| `--auth-accent-hover` | `#7e22ce` | `#d8b4fe` | Hover del botón primario y de enlaces |
| `--auth-accent-active` | `#6b21a8` | `#e9d5ff` | Estado presionado (`:active`) del botón primario y de enlaces |
| `--auth-on-accent` (texto sobre acento) | `#ffffff` | `#16171d` | Texto del botón primario |
| `--auth-input-border` (borde de input) | `#8b8594` | `#6b7280` | Borde por defecto de inputs de texto |
| `--auth-avatar-bg` | `color-mix(in srgb, var(--accent) 15%, var(--bg))` → `#f2e2ff` | mismo cálculo → `#2f273e` | Círculo con la inicial en el trigger del menú |

### 2.3 Pares texto/fondo y elementos de interfaz, con ratio calculado (fórmula de luminancia relativa WCAG 2.x)

Modo claro:

| Par | Ratio | Requisito | Resultado |
|---|---|---|---|
| `--text-h #08060d` / `--bg #ffffff` | 20.2:1 | 4.5:1 | Pasa |
| `--text #6b6375` / `--bg #ffffff` | 5.73:1 | 4.5:1 | Pasa |
| `--text #6b6375` / `--code-bg #f4f3ec` (deshabilitado, solo lectura) | 5.15:1 | 4.5:1 | Pasa |
| `--text-h #08060d` / `--code-bg #f4f3ec` (hover ítem de menú, input en solo lectura) | 18.1:1 | 4.5:1 | Pasa |
| `--auth-accent #9333ea` / `--bg #ffffff` (enlaces) | 5.38:1 | 4.5:1 | Pasa |
| `--auth-accent-hover #7e22ce` / `#ffffff` (enlace en hover) | 6.98:1 | 4.5:1 | Pasa |
| `--auth-accent-active #6b21a8` / `#ffffff` (enlace presionado) | 8.72:1 | 4.5:1 | Pasa |
| `--auth-on-accent #ffffff` / `--auth-accent #9333ea` (botón) | 5.38:1 | 4.5:1 | Pasa |
| `#ffffff` / `--auth-accent-hover #7e22ce` | 6.98:1 | 4.5:1 | Pasa |
| `#ffffff` / `--auth-accent-active #6b21a8` | 8.72:1 | 4.5:1 | Pasa |
| `--auth-accent #9333ea` / `--code-bg #f4f3ec` (ítem de menú presionado) | 4.84:1 | 4.5:1 | Pasa |
| `--error #d1373f` / `--bg #ffffff` (error de campo) | 4.85:1 | 4.5:1 | Pasa |
| `--text-h #08060d` / error-bg compuesto `#faebec` (alerta) | 17.4:1 | 4.5:1 | Pasa |
| `--text-h #08060d` / ok-bg compuesto `#e8f5ef` | 18.0:1 | 4.5:1 | Pasa |
| `--text-h #08060d` / warn-bg compuesto `#f6efe2` | 17.6:1 | 4.5:1 | Pasa |
| `--neutral #6b6375` / neutral-bg compuesto `#f0eff1` (pastilla) | 5.00:1 | 4.5:1 | Pasa |
| `--text-h #08060d` / `--auth-avatar-bg #f2e2ff` | 16.4:1 | 4.5:1 | Pasa |
| Borde input `--auth-input-border #8b8594` / `#ffffff` | 3.57:1 | 3:1 | Pasa |
| Borde input inválido `--error #d1373f` / `#ffffff` | 4.85:1 | 3:1 | Pasa |
| Anillo de foco `--accent #aa3bff` / `#ffffff` | 4.39:1 | 3:1 | Pasa |
| Borde izquierdo de alerta `--error` / `#faebec` | 4.19:1 | 3:1 | Pasa |
| Borde izquierdo éxito `--ok #1a9e5a` / `#e8f5ef` | 3.08:1 | 3:1 | Pasa |
| Borde izquierdo advertencia `--warn #b3760f` / `#f6efe2` | 3.33:1 | 3:1 | Pasa |
| Borde izquierdo info `--neutral #6b6375` / `#ffffff` | 5.73:1 | 3:1 | Pasa |
| Spinner (currentColor `#ffffff`) / `#9333ea` | 5.38:1 | 3:1 | Pasa |
| Spinner del trigger (currentColor `--text-h`) / `--bg #ffffff` | 20.2:1 | 3:1 | Pasa |

Modo oscuro:

| Par | Ratio | Requisito | Resultado |
|---|---|---|---|
| `--text-h #f3f4f6` / `--bg #16171d` | 16.3:1 | 4.5:1 | Pasa |
| `--text #9ca3af` / `--bg #16171d` | 7.04:1 | 4.5:1 | Pasa |
| `--text #9ca3af` / `--code-bg #1f2028` | 6.38:1 | 4.5:1 | Pasa |
| `--text-h #f3f4f6` / `--code-bg #1f2028` | 14.7:1 | 4.5:1 | Pasa |
| `--auth-accent #c084fc` / `--bg #16171d` (enlaces) | 6.77:1 | 4.5:1 | Pasa |
| `--auth-accent-hover #d8b4fe` / `#16171d` (enlace en hover) | 10.1:1 | 4.5:1 | Pasa |
| `--auth-accent-active #e9d5ff` / `#16171d` (enlace presionado) | 13.1:1 | 4.5:1 | Pasa |
| `--auth-on-accent #16171d` / `#c084fc` (botón) | 6.77:1 | 4.5:1 | Pasa |
| `#16171d` / `--auth-accent-hover #d8b4fe` | 10.1:1 | 4.5:1 | Pasa |
| `#16171d` / `--auth-accent-active #e9d5ff` | 13.1:1 | 4.5:1 | Pasa |
| `--auth-accent #c084fc` / `--code-bg #1f2028` (ítem de menú presionado) | 6.13:1 | 4.5:1 | Pasa |
| `--error #f87171` / `--bg #16171d` | 6.46:1 | 4.5:1 | Pasa |
| `--text-h #f3f4f6` / error-bg compuesto `#382529` | 13.0:1 | 4.5:1 | Pasa |
| `--text-h #f3f4f6` / ok-bg compuesto `#1e352c` | 11.9:1 | 4.5:1 | Pasa |
| `--text-h #f3f4f6` / warn-bg compuesto `#38301e` | 11.9:1 | 4.5:1 | Pasa |
| `--neutral #9ca3af` / neutral-bg compuesto `#2a2c33` | 5.49:1 | 4.5:1 | Pasa |
| `--text-h #f3f4f6` / `--auth-avatar-bg #2f273e` | 12.9:1 | 4.5:1 | Pasa |
| Borde input `--auth-input-border #6b7280` / `#16171d` | 3.70:1 | 3:1 | Pasa |
| Borde input inválido `#f87171` / `#16171d` | 6.46:1 | 3:1 | Pasa |
| Anillo de foco `#c084fc` / `#16171d` | 6.77:1 | 3:1 | Pasa |
| Borde izquierdo alerta `#f87171` / `#382529` | 5.18:1 | 3:1 | Pasa |
| Borde izquierdo éxito `#4ade80` / `#1e352c` | 7.5:1 | 3:1 | Pasa |
| Borde izquierdo advertencia `#fbbf24` / `#38301e` | 7.8:1 | 3:1 | Pasa |
| Borde izquierdo info `#9ca3af` / `#16171d` | 7.04:1 | 3:1 | Pasa |
| Spinner (currentColor `#16171d`) / `#c084fc` | 6.77:1 | 3:1 | Pasa |
| Spinner del trigger (currentColor `--text-h`) / `--bg #16171d` | 16.3:1 | 3:1 | Pasa |

Pares existentes que **no** se usan en auth porque no llegan a AA (para que el implementador no los copie por inercia): `--error` sobre `--error-bg` como texto (`.upload-panel__error`, `.projects-dialog__error`: 4.19:1 claro), `--warn` sobre `--warn-bg` como texto (3.33:1), `#fff` sobre `--accent` (`.upload-actions__button--primary`: 4.39:1 claro, 2.64:1 oscuro), `#fff` sobre `--error` en oscuro (`.projects-dialog__danger`: 2.77:1), enlace global `a { color: var(--accent) }` (4.39:1 claro). Dentro de auth todo enlace usa `--auth-accent` y todo texto de alerta usa `--text-h`.

---

## 3. Tipografía

- **Familia:** la existente, sin cambios: `--sans: system-ui, 'Segoe UI', Roboto, sans-serif` (cuerpo y títulos); `--mono` no se usa en auth.
- **Estrategia de carga:** no hay fuentes web. Al ser pila de sistema no hay `@font-face`, ni `font-display`, ni subsetting, ni preload: cero bytes de fuente y cero FOIT/FOUT. Se declara explícitamente para que el implementador no agregue una fuente.
- **Base:** `:root { font: 16px/145% var(--sans); letter-spacing: 0.18px; }` (existente). 1 rem = 16 px.

Escala (relación aproximada 1.125 en la zona de UI, con los valores que ya usa la app):

| Nivel | Uso | Móvil (≤ 400 px) | Desktop (> 400 px) | Peso | Altura de línea | `letter-spacing` |
|---|---|---|---|---|---|---|
| Marca | «VECTORiZE» en el header de auth (párrafo, no encabezado) | 1.125rem (18 px) | 1.25rem (20 px) | 700 | 1.2 | 1px (igual que `.projects-header__brand`) |
| H1 | Título de pantalla («Iniciar sesión») | 1.375rem (22 px, regla existente `≤ 400px`) | 1.75rem (28 px, existente) | 600 | 1.2 | -0.4px (existente) |
| H2 | Título del diálogo de confirmación | 1.125rem (18 px) | 1.125rem (18 px) | 600 | 1.18 (existente) | -0.2px (existente) |
| Cuerpo | Intro de la tarjeta, banners, texto del panel de registro recibido | 0.875rem (14 px) | 0.875rem (14 px) | 400 | 1.45 | 0.18px |
| Label | Etiqueta de campo, texto del checkbox | 0.875rem (14 px) | 0.875rem (14 px) | 600 (label) / 400 (checkbox) | 1.3 | 0.18px |
| Input | Valor tecleado | 1rem (16 px) | 1rem (16 px) | 400 | 1.4 | 0.18px |
| Botón primario de auth | «Iniciar sesión», «Crear cuenta», «Reintentar» | 1rem (16 px) | 1rem (16 px) | 600 | 1.2 | 0.18px |
| Hint / error de campo | Ayuda bajo el label, mensaje de error del campo | 0.8125rem (13 px) | 0.8125rem (13 px) | 400 (hint) / 600 (error) | 1.4 | 0.18px |
| Menú | Trigger e ítems del menú de usuario | 0.8125rem (13 px) | 0.8125rem (13 px) | 600 (trigger) / 400 (ítems) | 1.3 | 0.18px |

Regla: el valor de los inputs es **16 px** (no los 14 px de `.projects-dialog__input`) para evitar el zoom automático de iOS Safari al enfocar; es la única desviación tipográfica respecto del resto de la app.

---

## 4. Grilla y espaciado

- **Contenedor:** el existente `#root` (`max-width: 720px; margin: 0 auto; padding: 32px 20px 24px;` y `padding: 20px 14px 16px` en `≤ 400px`). Las pantallas de auth **no** usan el truco de ancho completo de `.projects-dashboard`/`.editor-shell`.
- **Tarjeta de auth:** `width: min(400px, 100%)`, centrada con `margin-inline: auto`. Una sola columna en todos los breakpoints (formulario de una tarea: más ancho no mejora nada).
- **Columnas y canaleta por breakpoint (pantallas de auth):** 1 columna en 360/768/1280/1920; canaleta no aplica (una columna). Márgenes laterales efectivos: 14 px (360); en el resto, la tarjeta queda centrada dentro de `#root`.
- **Header de producto** (donde vive el menú de usuario): sin cambios de grilla; se usa el flex existente de `.projects-header`, `.editor-header__actions` y la `nav` del flujo clásico.

**Escala de espaciado única** (la misma que ya usan `--projects-space-*` y `--editor-space-*`), declarada en `auth.css` como `--auth-space-*`:

| Token | Valor | Uso |
|---|---|---|
| `--auth-space-1` | 0.25rem (4 px) | Label → input, input → hint/error |
| `--auth-space-2` | 0.5rem (8 px) | Separación dentro del banner, avatar → nombre, padding horizontal del trigger, gap del botón con spinner |
| `--auth-space-3` | 0.75rem (12 px) | Padding horizontal del input y de los ítems del menú, gap del grupo «New Project» + menú |
| `--auth-space-4` | 1rem (16 px) | Entre campos, padding de la tarjeta en 360, gap de la tarjeta |
| `--auth-space-5` | 1.5rem (24 px) | Padding de la tarjeta ≥ 401 px, separación header → main |
| `--auth-space-6` | 2rem (32 px) | Separación superior de la tarjeta en ≥ 768 px |

No se usan valores sueltos fuera de esta escala, salvo los ya existentes que se heredan (radio 8 px de inputs/botones, radio 10 px de tarjeta, padding 14 px 16 px y borde izquierdo de 4 px de `.status-banner`, alto mínimo 44 px de objetivos táctiles, alto visual 32 px del trigger como `.project-menu__trigger`).

**Ritmo vertical de la tarjeta (de arriba a abajo):** h1 → 4 px → intro → 16 px → banner (si hay) → 16 px → alerta de formulario (si hay) → 16 px → campo 1 → 16 px → campo 2 → 16 px → (campo 3 / checkbox) → 24 px → botón primario → 16 px → línea de cambio de pantalla. Se implementa con `display: flex; flex-direction: column; gap: var(--auth-space-4)` en tarjeta y formulario, más `margin-top: var(--auth-space-2)` en el botón primario (16 + 8 = 24 px). El h1 y la intro van juntos en un `div` con gap 4 px.

---

## 5. Inventario de componentes

Estados obligatorios: por defecto, hover, foco visible, activo, deshabilitado; más carga/vacío/error cuando aplica. El foco visible es siempre el `:focus-visible` global existente (`outline: 2px solid var(--accent); outline-offset: 2px;`); **nunca** `outline: none` sin reemplazo. Para componentes no interactivos se indica «no interactivo» en lugar de inventar estados.

### 5.1 `AuthLayout` (shell de las pantallas anónimas)
- **Propósito:** marco común de login, registro y error de sesión; garantiza landmarks y un único `h1`.
- **Anatomía:** `<div class="auth-layout">` → `<header class="auth-header">` con `<p class="auth-brand">VECTORiZE</p>` → `<main class="auth-main">` que contiene una `AuthCard`.
- **Variantes:** ninguna.
- **Estados:** no interactivo (la marca no es enlace: un usuario anónimo sería redirigido al login de nuevo).
- **Estilo:** `auth-header` con la misma alineación que `.projects-header` (flex, `align-items: center`); `auth-main` con `padding-top: var(--auth-space-5)` (≤ 767 px) / `var(--auth-space-6)` (≥ 768 px).

### 5.2 `AuthCard`
- **Propósito:** contenedor visual de cada formulario o panel.
- **Anatomía:** `<section class="auth-card" aria-labelledby="auth-title">` → `<h1 id="auth-title" tabIndex={-1}>` → `<p class="auth-card__intro">` → contenido (banner, alerta, formulario o panel) → `<p class="auth-card__switch">` (solo login y registro).
- **Variantes:** `login`, `register`, `register-received`, `session-error`.
- **Estados:** no interactivo. El `h1` es enfocable por programa (`tabIndex=-1`) para el manejo de foco; su foco visible usa el outline global con `outline-offset: 4px` (como `.projects-section > h2:focus-visible`).
- **Estilo:** borde 1 px `--border`, radio 10 px (patrón `.service-card`), fondo `--bg`, padding 24 px (16 px en ≤ 400 px), gap 16 px, `text-align: left`. Intro: 14 px, `--text`.

### 5.3 `AuthBanner` (aviso contextual de la pantalla)
- **Propósito:** explicar por qué el usuario está en el login (sesión terminada, cerró sesión, registro recibido, deep link).
- **Anatomía:** reutiliza las clases existentes: `class="status-banner <modificador> auth-banner"` + `<p>` con el texto; el elemento lleva `tabIndex=-1` para recibir foco por programa. `auth-banner` solo fija `color: var(--text-h)` y `font-size: 0.875rem`.
- **Variantes:** `expired` → `status-banner--degraded` (advertencia); `signed-out`, `signed-out-all`, `registered` → `status-banner--online` (éxito); `return-info` → `status-banner auth-banner--info` (borde izquierdo `--neutral`, sin fondo).
- **Estados:** por defecto (visible), oculto (no se renderiza). Hover, activo y deshabilitado: no aplican (no interactivo). Foco visible: outline global cuando recibe foco por programa.
- **Rol:** `role="status"` (información, no error). Máximo **un** banner a la vez, prioridad: `expired` > `signed-out-all` > `signed-out` > `registered` > `return-info`.

### 5.4 `AuthAlert` (error a nivel formulario)
- **Propósito:** errores del servidor o de red al enviar (credenciales, red, 5xx, 403, datos rechazados) y errores de las acciones de salida.
- **Anatomía:** `<div class="status-banner status-banner--error auth-alert" role="alert">` + `<p>` con el texto. Texto `--text-h` sobre `--error-bg`, borde izquierdo 4 px `--error`.
- **Variantes:** `credentials`, `network`, `server`, `forbidden`, `rate-limited`, `register-rejected` (solo cambia el texto; ver §11). Variante `dismissible` (solo en el menú de usuario): añade un `AuthButton` secondary «Cerrar aviso».
- **Estados:** por defecto (visible) / ausente. Se **desmonta al iniciar cada envío** y se vuelve a montar si el envío falla, para que el lector de pantalla lo anuncie de nuevo aunque el texto sea idéntico. No interactivo salvo el botón de la variante `dismissible` (estados de §5.7); no recibe foco.

### 5.5 `TextField` (correo y contraseñas)
- **Propósito:** entrada de texto con label, hint y error asociados.
- **Anatomía:** `<div class="auth-field">` → `<label for>` (`.auth-field__label`, 14 px / 600, `--text-h`) → `<p class="auth-field__hint" id>` opcional (13 px, `--text`) → `<input class="auth-field__input">` → `<p class="auth-field__error" id>` condicional. `aria-describedby` = ids de hint y error presentes (en ese orden). Gap interno 4 px.
- **Variantes:** `email` (`type="email"`, `autocomplete="email"`, `autocapitalize="none"`, `spellcheck="false"`); `current-password` (`type="password"`, `autocomplete="current-password"`); `new-password` (`type="password"`, `autocomplete="new-password"`, `minLength={12}`, `maxLength={128}`). Todos con `required` y `name` (`email`, `password`, `passwordConfirmation`).
- **Estilo base:** `min-height: 44px`, `padding: 0 var(--auth-space-3)`, radio 8 px, borde 1 px `--auth-input-border`, fondo `--bg`, texto `--text-h`, `font: inherit; font-size: 1rem`, `width: 100%`.
- **Estados:**
  - Por defecto: como arriba.
  - Hover: borde `--text`.
  - Foco visible: outline global (2 px `--accent`, offset 2 px) + borde `--auth-accent`. Los inputs de texto disparan `:focus-visible` con teclado y con ratón.
  - Activo: igual que foco (los inputs no tienen estado presionado distinto).
  - Deshabilitado (`disabled`, no usado en este alcance pero definido): fondo `--code-bg`, texto `--text`, borde `--border`, `cursor: not-allowed`.
  - Solo lectura durante el envío (`readOnly`): fondo `--code-bg`, texto `--text-h`, borde `--auth-input-border`, `cursor: progress`. Sigue siendo enfocable y legible.
  - Error: `aria-invalid="true"`, borde `--error`, mensaje en `.auth-field__error` (color `--error`, 13 px, peso 600). El error se limpia cuando el usuario modifica ese campo.
  - Carga / vacío: no aplican.
- **Nunca** se bloquea pegar ni se desactiva el autocompletado (WCAG 3.3.8, gestores de contraseñas).

### 5.6 `CheckboxField` («Recordarme»)
- **Propósito:** pedir sesión persistente (`rememberMe: true`).
- **Anatomía:** `<div class="auth-checkbox">` → `<label class="auth-checkbox__label">` que envuelve `<input type="checkbox" name="rememberMe">` + texto (14 px / 400, `--text-h`) → `<p class="auth-field__hint" id>` enlazado por `aria-describedby` del input.
- **Variantes:** ninguna. Desmarcado por defecto.
- **Estilo:** label `display: flex; align-items: center; gap: var(--auth-space-2); min-height: 44px; cursor: pointer` (toda la fila es área táctil); checkbox nativo 18 × 18 px con `accent-color: var(--auth-accent)`.
- **Estados:**
  - Por defecto: desmarcado, apariencia nativa.
  - Hover: cursor `pointer` en toda la fila; el checkbox conserva su hover nativo; el texto no cambia.
  - Foco visible: outline global sobre el checkbox.
  - Activo / marcado: relleno `--auth-accent` (nativo vía `accent-color`).
  - Deshabilitado: no se usa; durante el envío el checkbox sigue habilitado y el valor se toma en el momento de enviar. Definición si se deshabilitara: texto `--text`, `cursor: not-allowed`.

### 5.7 `AuthButton`
- **Propósito:** acción primaria de cada pantalla y acciones secundarias.
- **Anatomía:** `<button type="submit|button" class="auth-button auth-button--primary|auth-button--secondary">` → `<span class="auth-button__spinner" aria-hidden="true">` (solo en carga; 16 px, borde 2 px `currentColor` con el lado derecho transparente) → `<span>` etiqueta. Cuando la acción es navegar («Ir a iniciar sesión») se renderiza como `<a class="auth-button auth-button--primary" href>` con la misma apariencia y estados.
- **Variantes:**
  - `primary`: fondo `--auth-accent`, texto `--auth-on-accent`, borde 1 px `--auth-accent`, `width: 100%`, `min-height: 44px`, radio 8 px, 16 px / 600, contenido centrado con gap 8 px. Se usa en los formularios, en «Reintentar» y en «Ir a iniciar sesión». En el diálogo, `width: auto` con `padding: 0 var(--auth-space-4)`.
  - `secondary`: reutiliza `.upload-actions__button` (borde `--border`, fondo `--bg`, texto `--text-h`) con `min-height: 44px` añadido. Se usa en «Cancelar» del diálogo y «Cerrar aviso».
- **Estados (primary):**
  - Por defecto: como arriba.
  - Hover: fondo y borde `--auth-accent-hover`.
  - Foco visible: outline global.
  - Activo: fondo y borde `--auth-accent-active`.
  - Deshabilitado (definido, no usado en los formularios): fondo `--code-bg`, borde `--border`, texto `--text`, `cursor: not-allowed`. Sin `opacity` (así mantiene 5.15:1 / 6.38:1).
  - Carga (enviando): **no** usa `disabled`; usa `aria-disabled="true"`, mantiene los colores del estado por defecto, muestra el spinner y cambia la etiqueta («Iniciando sesión…», «Creando cuenta…», «Reintentando…», «Cerrando sesiones…»); `cursor: progress`; los clics y Enter adicionales se ignoran. Motivo: un `<button disabled>` enfocado pierde el foco en varios navegadores.
- **Estados (secondary):** hover borde `--text`; foco outline global; activo fondo `--code-bg`; deshabilitado fondo `--code-bg`, texto `--text`, `cursor: not-allowed`, sin `opacity`.

### 5.8 `TextLink` (cambio entre login y registro, vuelta a Mis proyectos)
- **Propósito:** pasar de login a registro y viceversa conservando `returnUrl`; volver a Mis proyectos desde el contenedor de cuenta.
- **Anatomía:** `<a class="auth-link" href="?view=register&returnUrl=…">` dentro de `<p class="auth-card__switch">` (14 px, `--text`). Es un enlace real con `href` (abrir en pestaña nueva funciona) e intercepción de clic para navegar sin recarga (mismo patrón que «Mis proyectos» en `App.tsx`).
- **Estilo:** color `--auth-accent`, peso 600, subrayado siempre visible (`text-decoration-thickness: 1px; text-underline-offset: 2px`), `display: inline-flex; align-items: center; min-height: 44px`.
- **Estados:** por defecto (subrayado, `--auth-accent`); hover `--auth-accent-hover` y subrayado 2 px; foco visible outline global; activo `--auth-accent-active`; deshabilitado no aplica (durante un envío sigue activo: navegar aborta el envío en curso con su `AbortController`).

### 5.9 `LoginForm`
- **Propósito:** iniciar sesión.
- **Anatomía:** `<form class="auth-form" noValidate aria-busy>` → `AuthAlert` (condicional) → `TextField` email → `TextField` current-password → `CheckboxField` «Recordarme» → `AuthButton` primary → `<p role="status" class="auth-visually-hidden">` (texto de progreso para lectores de pantalla; existe siempre en el DOM y solo cambia su contenido).
- **Estados:**
  - Por defecto: campos vacíos (o correo precargado si viene del registro recibido; nunca la contraseña).
  - Validación cliente: al enviar, si hay errores, se marcan los campos y el foco va al **primer campo inválido**. No se valida al perder el foco ni mientras se escribe.
  - Enviando: `aria-busy="true"` en el form, inputs `readOnly`, botón en carga, el `role="status"` oculto dice «Iniciando sesión…».
  - Error del servidor/red: `AuthAlert` visible, `aria-busy="false"`, inputs editables, **la contraseña se conserva** y el foco **se queda donde estaba** (en el botón o en el campo desde el que se pulsó Enter).
  - Éxito: navegación a `returnUrl` validado o a Mis proyectos (ver §9.3 para el foco).
  - Vacío: no aplica.

### 5.10 `RegisterForm`
- **Propósito:** crear una cuenta.
- **Anatomía:** `<form class="auth-form" noValidate aria-busy>` → `AuthAlert` (condicional) → `TextField` email → `TextField` new-password con hint → `TextField` new-password de confirmación → `AuthButton` primary → `<p role="status" class="auth-visually-hidden">`.
- **Estados:** idénticos a `LoginForm`, con «Creando cuenta…». Errores 400 del servidor con `code` `invalid_email` o `weak_password` se muestran **como error del campo correspondiente** (texto `message` del servidor tal cual, ya está en español) y el foco va a ese campo; `invalid_request` y el resto van al `AuthAlert`.
- Éxito (202): el formulario se reemplaza por `RegisterReceivedPanel`.

### 5.11 `RegisterReceivedPanel`
- **Propósito:** confirmar la recepción del registro con respuesta uniforme, **sin** prometer ningún correo ni confirmar que la cuenta sea nueva.
- **Anatomía:** dentro de la misma `AuthCard`: el `h1` cambia de texto a «Registro recibido» → `<p>` cuerpo (14 px, `--text-h`) → `<p>` nota (14 px, `--text`) → `AuthButton` primary como enlace «Ir a iniciar sesión» (`href="?view=login&returnUrl=…"`, conserva el `returnUrl` si había).
- **Estados:** por defecto; hover/foco/activo del botón según §5.7; deshabilitado no aplica. Al aparecer, el foco va al `h1` (`tabIndex=-1`).

### 5.12 `SessionPending` (estado Unknown/loading de `AuthBoundary`)
- **Propósito:** esperar a `GET /api/v1/auth/me` sin mostrar ni contenido privado ni el login.
- **Anatomía:** `<main class="auth-pending" aria-busy="true">` → `<p role="status" class="auth-pending__text">Comprobando tu sesión…</p>`. Sin header de producto, sin menú de usuario, sin skeleton de proyectos.
- **Estilo:** `min-height: 60svh; display: grid; place-items: center;` texto 14 px `--text`. El texto aparece con 300 ms de retraso (`animation: auth-fade-in 150ms ease-out 300ms both`, de `opacity: 0` a `1`) para que una respuesta rápida no produzca parpadeo.
- **Estados:** carga (único estado). No interactivo.

### 5.13 `SessionErrorPanel` (estado auth error de `AuthBoundary`)
- **Propósito:** fallo de red o 5xx al consultar la sesión. **No** es «sesión cerrada»: no redirige al login, no borra nada.
- **Anatomía:** `AuthLayout` → `AuthCard` (variante `session-error`) con `h1` «No pudimos comprobar tu sesión» → `<p role="alert">` causa (red o servidor) → `<p>` «Esto no cierra tu sesión.» → `AuthButton` primary «Reintentar».
- **Estados:** error (por defecto); reintentando (botón en carga «Reintentando…»); al volver la red (evento `online` de `window`) se reintenta automáticamente una vez con el mismo estado visual de carga. Si el reintento da 401 → login sin banner de expirada; si da 200 → contenido; si vuelve a fallar → mismo panel, y el `<p role="alert">` de causa se remonta para volver a anunciarse.

### 5.14 `AuthBoundary` / `ProtectedRoute`
- **Propósito:** decidir qué se renderiza según el estado de sesión. Visualmente solo produce `SessionPending`, `SessionErrorPanel`, la redirección al login o el contenido protegido.
- **Estados:** `unknown` → `SessionPending`; `authenticated` → hijos; `unauthenticated` → navegación (reemplazando la entrada del historial) a `?view=login&returnUrl=` + ruta y query actuales codificadas; `error` → `SessionErrorPanel`. Sin estados de interacción.

### 5.15 `UserMenu` (menú de usuario del header)
- **Propósito:** identificar la cuenta y ofrecer «Salir» y «Cerrar sesión en todos lados».
- **Anatomía:** `<div class="user-menu">` (`position: relative`) → `<button class="user-menu__trigger" aria-haspopup="menu" aria-expanded aria-controls>` con: `<span class="user-menu__avatar" aria-hidden="true">A</span>` (inicial en mayúscula de `displayName`) + `<span class="auth-visually-hidden">Menú de cuenta: </span>` + `<span class="user-menu__name">Ana Gómez</span>` (valor dinámico: `displayName` de `/me`) + `<span class="user-menu__caret" aria-hidden="true">▾</span>` → `<div role="menu" aria-label="Cuenta" class="user-menu__list">` con dos `<button role="menuitem" class="user-menu__item">`: «Salir», «Cerrar sesión en todos lados» → `AuthAlert` variante `dismissible` con clase adicional `user-menu__alert`, condicional, para errores de «Salir».
- **Patrón de teclado:** idéntico a `ProjectActionsMenu` (WAI-ARIA menu button): Enter/Espacio/Flecha abajo abren y enfocan el primer ítem; Flecha arriba/abajo, Inicio/Fin navegan; Escape cierra y devuelve el foco al trigger; Tab cierra; clic fuera cierra. Dentro de `role="menu"` solo hay `menuitem` (nada de texto suelto: evita la regla axe `aria-required-children`).
- **Estilo del trigger:** caja visual de 32 px de alto (como `.project-menu__trigger`): borde 1 px `--border`, fondo `--bg`, texto `--text-h` 13 px / 600, radio 8 px, `padding: 0 var(--auth-space-2)`, gap 8 px, `display: inline-flex; align-items: center`, `position: relative`; `.user-menu__name` con `max-width: 16ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap`. **Área táctil de 44 × 44 px como mínimo** con un pseudo-elemento `::after { content: ""; position: absolute; inset: -6px; }` (no agranda el header del Editor). Avatar 24 × 24 px, `border-radius: 999px`, fondo `--auth-avatar-bg`, texto `--text-h` 12 px / 700, centrado.
- **Estilo de la lista:** patrón `.project-menu__list` (superficie nivel 2, `position: absolute; top: calc(100% + 4px); right: 0; z-index: 20; padding: 4px`), `min-width: 240px; max-width: calc(100vw - 28px)`. Ítems: `min-height: 44px`, `padding: 0 var(--auth-space-3)`, radio 6 px, 13 px, texto `--text-h`, alineados a la izquierda, `width: 100%`.
- **Estados del trigger:** por defecto; hover borde `--auth-accent`; foco visible outline global; activo/abierto (`aria-expanded="true"`) borde `--auth-accent` y fondo `--code-bg`; deshabilitado no aplica; **carga** (saliendo): `aria-busy="true"`, `aria-disabled="true"`, el caret se reemplaza por un spinner de 10 px (`currentColor`) en el mismo hueco, el resto del contenido y el ancho no cambian (sin salto de layout) y un `role="status"` oculto dice «Cerrando sesión…».
- **Estados de los ítems:** por defecto (fondo transparente); hover fondo `--code-bg`; foco visible fondo `--code-bg` + outline global con `outline-offset: -2px` (queda dentro de la lista); activo fondo `--code-bg` y texto `--auth-accent`; deshabilitado (mientras otra salida está en curso) texto `--text`, `cursor: not-allowed`, **sin opacity** (5.73:1 / 7.04:1).
- **Estado de error:** la alerta aparece bajo el trigger (misma posición que la lista: `position: absolute; top: calc(100% + 4px); right: 0; min-width: 240px; z-index: 20`), con `<p>` + `AuthButton` secondary «Cerrar aviso» (al cerrarla el foco vuelve al trigger). La sesión **no** se da por cerrada si `logout` falla por red/5xx.
- **Variante `development`:** cuando `/me` indica modo Development no se renderiza ni trigger ni menú. Se renderiza `<div class="user-menu user-menu--dev">` (flex, gap 8 px) con `<span class="status-pill status-pill--neutral">Modo desarrollo</span>` + `<span class="user-menu__name">` con el `displayName` del usuario de desarrollo (13 px / 600, `--text-h`). Se usan las **clases** de la pastilla, no el componente `StatusPill` (que lleva `role="status"` y se anunciaría al montar). No interactivo.
- **Inyección en las pantallas de producto:** `App` construye el `UserMenu` y se lo pasa a las cabeceras como un slot (`ReactNode`); las pantallas de producto no importan nada del módulo de auth.

### 5.16 `LogoutAllDialog`
- **Propósito:** confirmar «Cerrar sesión en todos lados» (afecta a otros dispositivos).
- **Anatomía:** reutiliza el componente existente `ProjectDialog` (`role="alertdialog"`, `aria-modal`, foco atrapado, Escape cierra, foco devuelto al trigger del menú) con: `h2` título, descripción, `AuthAlert` condicional, acciones `.projects-dialog__actions` con `AuthButton` secondary «Cancelar» (foco inicial vía `initialFocusRef`) y `AuthButton` primary «Cerrar sesión en todos lados» (`width: auto`). **No** se usa `.projects-dialog__danger` (2.77:1 en oscuro).
- **Estados:** por defecto; confirmando (`busy` de `ProjectDialog` = true: Escape y clic en el fondo se ignoran; botón primario en carga «Cerrando sesiones…»); error (alerta dentro del diálogo, botones de nuevo operativos, el foco se queda en el botón primario); hover/foco/activo/deshabilitado de los botones según §5.7.

### 5.17 `AccountLayout` (contenedor protegido para páginas de cuenta)
- **Propósito:** marco reutilizable para S07 (perfil) y posteriores; siempre envuelto en `AuthBoundary`.
- **Anatomía:** `<div class="auth-account">` → `<header class="projects-header">` con la marca `<p class="projects-header__brand">VECTORiZE</p>` (mismo estilo que el `h1` del dashboard, pero como párrafo para dejar el `h1` al título de la página) y el slot `UserMenu` → `<main class="auth-account__main">` → `TextLink` «← Volver a Mis proyectos» → `<h1 tabIndex={-1}>` (título recibido por prop) → contenido (`children`).
- **Estilo:** ancho del `#root` (720 px), `main` con `display: flex; flex-direction: column; gap: var(--auth-space-4)`.
- **Estados:** no interactivo salvo el enlace (estados de §5.8) y el menú (§5.15). Carga, error y no autenticado los resuelve `AuthBoundary` antes de montarlo. En S05 **no hay ninguna entrada visible** que lleve a este contenedor (nada de «Mi cuenta» en el menú hasta S07): solo se ejercita en tests.

### 5.18 Utilidad `auth-visually-hidden`
- Mismas reglas que `.projects-visually-hidden` (`position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap;`). No interactiva.

---

## 6. Estructura de la página

Rutas por query string (extendiendo `readAppView`): `?view=login`, `?view=register`, con `returnUrl` opcional (ruta + query interna, validada; si no es válida se descarta en silencio y se usa Mis proyectos). Las rutas privadas existentes (Mis proyectos, `?view=new`, Workspace) quedan envueltas en `AuthBoundary`.

### 6.1 Arranque de cualquier ruta privada (sesión Unknown)
1. `SessionPending` (único contenido; ni header de producto ni login).
2. Según `/me`: contenido privado, redirección al login, o `SessionErrorPanel`.

### 6.2 Error al comprobar la sesión
1. `AuthLayout` → header con marca.
2. `AuthCard` (variante `session-error`) con `SessionErrorPanel`: `h1`, causa (`role="alert"`), aclaración, `AuthButton` «Reintentar».

### 6.3 Login (`?view=login`)
1. `AuthLayout` header: marca «VECTORiZE».
2. `main` → `AuthCard` (variante login):
   1. `h1` «Iniciar sesión» + intro.
   2. `AuthBanner` (como máximo uno, según el motivo de llegada).
   3. `LoginForm`: `AuthAlert` condicional → `TextField` correo → `TextField` contraseña → `CheckboxField` «Recordarme» con hint → `AuthButton` «Iniciar sesión».
   4. Línea de cambio: «¿No tenés cuenta?» + `TextLink` «Creá una».

### 6.4 Registro (`?view=register`)
1. `AuthLayout` header.
2. `main` → `AuthCard` (variante register):
   1. `h1` «Crear cuenta» + intro.
   2. `RegisterForm`: `AuthAlert` condicional → `TextField` correo → `TextField` contraseña nueva con hint → `TextField` repetir contraseña → `AuthButton` «Crear cuenta».
   3. Línea de cambio: «¿Ya tenés cuenta?» + `TextLink` «Iniciá sesión».

### 6.5 Registro recibido (misma URL `?view=register`, estado tras el 202)
1. `AuthLayout` header.
2. `AuthCard` (variante register-received): `RegisterReceivedPanel` (`h1` «Registro recibido», cuerpo, nota, `AuthButton` «Ir a iniciar sesión»). Sin línea de cambio (el botón ya lleva al login).

### 6.6 Pantallas de producto autenticadas (cambio mínimo en sus cabeceras)
- **Mis proyectos:** `.projects-header` → marca (izquierda) | «New Project» + `UserMenu` (derecha, el menú último), agrupados en un `div` con `display: flex; align-items: center; gap: var(--auth-space-3)` (12 px: deja sitio a los 6 px del área táctil extendida del trigger sin solaparse con «New Project»).
- **Workspace/Editor:** `.editor-header__actions` → botones existentes sin cambios + `UserMenu` al final, con `margin-left: var(--auth-space-1)` adicional al gap existente de 8 px (total 12 px).
- **Flujo clásico `?view=new`:** la `nav` «Navegación principal» pasa a `display: flex; justify-content: space-between; align-items: center` con el enlace «Mis proyectos» a la izquierda y `UserMenu` a la derecha.
- En modo Development, en las tres, `UserMenu` en su variante `development`.
- Los errores de «Salir» aparecen en la `AuthAlert` del propio `UserMenu`.

### 6.7 Confirmación «Cerrar sesión en todos lados»
- `LogoutAllDialog` sobre la pantalla actual (backdrop existente `.projects-dialog__backdrop`).

### 6.8 Contenedor de cuenta (sin entrada visible en S05)
- `AuthBoundary` → `AccountLayout` (header con marca + `UserMenu`, `main` con `TextLink` de vuelta, `h1`, contenido).

### 6.9 Transiciones entre estados (resumen para el implementador)

| Evento | Resultado visual | Banner en el login |
|---|---|---|
| Ruta privada sin sesión (deep link o recarga) | Redirección a login con `returnUrl` | `return-info` |
| 401 en un endpoint no-auth con sesión activa (`onSessionExpired`) | Redirección inmediata a login con `returnUrl` de la ruta actual | `expired` |
| «Salir» correcto (o 401 en logout) | Login sin `returnUrl` | `signed-out` |
| «Cerrar sesión en todos lados» correcto | Login sin `returnUrl` | `signed-out-all` |
| 401 en logout-all | Login con `returnUrl` de la ruta actual | `expired` |
| «Ir a iniciar sesión» desde registro recibido | Login, correo precargado | `registered` |
| Login correcto | `returnUrl` validado o Mis proyectos | — |
| `/me` con red caída o 5xx | `SessionErrorPanel` | — |
| 403 en cualquier endpoint | Sin cambio de sesión ni redirección (lo maneja la pantalla como error genérico) | — |
| Usuario autenticado (o modo Development) entra a `?view=login`/`?view=register` | Redirección (reemplazo) a `returnUrl` validado o Mis proyectos | — |

El motivo del banner (`expired`, `signed-out`…) viaja **en memoria** (estado del proveedor de auth), nunca en la URL: así no se puede fabricar un «Tu sesión terminó» con un enlace, y una recarga del login lo descarta. Solo `return-info` se deriva de la URL (presencia de un `returnUrl` válido).

---

## 7. Comportamiento responsive

| Ancho | Pantallas de auth (login, registro, error de sesión) | Menú de usuario | Diálogo |
|---|---|---|---|
| **360 px** | `#root` con padding 20/14/16 (regla existente `≤ 400px`); tarjeta al ancho disponible (332 px) con padding 16 px; `h1` 22 px; marca 18 px; `auth-main` padding-top 24 px. Botón primario a ancho completo. Nada se oculta. | Por debajo de 480 px `.user-menu__name` se oculta visualmente (mismas reglas que `auth-visually-hidden`, vía media query): el trigger muestra avatar + caret. **No se pierde información**: el nombre sigue en el nombre accesible y la inicial lo identifica visualmente. La lista se alinea a la derecha con `max-width: calc(100vw - 28px)` para no salirse de la pantalla. En Mis proyectos, «New Project» y el trigger siguen en la misma fila (el header ya es flex con `space-between`). | `ProjectDialog` existente: `width: min(440px, 100%)`, padding del backdrop 16 px; bajo 400 px los botones pasan a columna (`flex-direction: column-reverse` en `.projects-dialog__actions` dentro del diálogo de auth) y ocupan el ancho completo, con el primario arriba. |
| **768 px** | `#root` 720 px; tarjeta 400 px centrada; padding de tarjeta 24 px; `h1` 28 px; marca 20 px; `auth-main` padding-top 32 px. | Nombre visible, truncado a 16 caracteres con elipsis. | Botones en fila, alineados a la derecha (existente). |
| **1280 px** | Igual que 768 (el formulario no crece: una columna de 400 px es el ancho de lectura correcto). | En Mis proyectos y flujo clásico: nombre visible. En el Editor: el nombre se oculta visualmente por debajo de 1440 px porque la fila de acciones ya tiene 7 botones; se ve avatar + caret (el nombre sigue en el nombre accesible). | Igual que 768. |
| **1920 px** | Igual que 1280; la tarjeta queda centrada dentro del `#root` de 720 px. | Nombre visible en todas las cabeceras (incluido el Editor). | Igual que 768. |

Notas:
- No se reordena ningún elemento de los formularios en ningún breakpoint: el orden visual coincide siempre con el orden DOM y el de tabulación.
- `SessionPending` es idéntico en todos los anchos (texto centrado).
- Zoom al 200 % y reflow a 320 CSS px: la tarjeta es fluida (`min(400px, 100%)`), sin anchos fijos ni scroll horizontal.

---

## 8. Movimiento

| Qué | Duración | Curva | Notas |
|---|---|---|---|
| Color de fondo/borde en hover/activo de botones, enlaces, inputs, ítems | 120 ms | `ease-out` | Solo `background-color`, `border-color`, `color` |
| Aparición del texto de `SessionPending` | 150 ms tras un retraso de 300 ms | `ease-out` | Solo `opacity` 0 → 1 (`animation: auth-fade-in 150ms ease-out 300ms both`) |
| Spinner de botón y del trigger | 800 ms por vuelta, infinito | `linear` | `transform: rotate()` |
| Apertura/cierre del menú | Sin animación | — | Igual que `ProjectActionsMenu` |
| Banners, alertas, errores de campo, cambio a «Registro recibido» | Sin animación | — | Aparecen de inmediato |
| Diálogo | Sin animación | — | Igual que `ProjectDialog` |

No se anima ningún cambio de layout (alto, ancho, posición).

Regla obligatoria en `auth.css`:

```css
@media (prefers-reduced-motion: reduce) {
  .auth-layout *, .auth-pending *, .auth-account *, .user-menu *, .auth-button {
    transition: none !important;
    animation: none !important;
  }
}
```

Con movimiento reducido: el spinner queda estático (un anillo con un segmento abierto) y la etiqueta del botón ya comunica la carga («Iniciando sesión…»); el texto de `SessionPending` se muestra de inmediato, sin fundido ni retraso (al anular la animación queda con su opacidad normal).

---

## 9. Accesibilidad

### 9.1 Landmarks y encabezados
- Pantallas de auth: `<header>` (banner) con la marca como `<p>` → `<main>` → un único `h1` por pantalla («Iniciar sesión», «Crear cuenta», «Registro recibido», «No pudimos comprobar tu sesión»). Sin `h2`.
- `SessionPending`: todo dentro de `<main>` (regla axe `region`).
- Pantallas de producto: sin cambios en su jerarquía (Mis proyectos sigue con `h1` = marca y `h2` «Mis proyectos»). El menú de usuario vive dentro del `<header>` existente.
- Diálogo: `h2` como título (`aria-labelledby`), cuerpo con `aria-describedby` (ya lo hace `ProjectDialog`).
- `AccountLayout`: `header` + `main` + un `h1`.
- `document.title` por vista de auth: «Iniciar sesión — Vectorify», «Crear cuenta — Vectorify», «Registro recibido — Vectorify», «No pudimos comprobar tu sesión — Vectorify»; se restaura el título anterior al salir de la vista.

### 9.2 Orden de foco (Tab)
- Login: (banner si recibió foco por programa) → correo → contraseña → «Recordarme» → «Iniciar sesión» → «Creá una».
- Registro: correo → contraseña → repetir contraseña → «Crear cuenta» → «Iniciá sesión».
- Registro recibido: «Ir a iniciar sesión».
- Error de sesión: «Reintentar».
- Mis proyectos: «New Project» → trigger del menú → resto de la página sin cambios.
- Editor: acciones existentes → trigger del menú.
- Flujo clásico: «Mis proyectos» → trigger del menú → resto sin cambios.
- Menú abierto: ítems con flechas; Tab sale y cierra.
- Diálogo: «Cancelar» (foco inicial) ↔ «Cerrar sesión en todos lados», foco atrapado.
- Ningún `tabIndex` positivo.

### 9.3 Manejo del foco al cambiar de estado

| Cambio | Destino del foco |
|---|---|
| Carga inicial de la página en el login sin motivo en memoria (deep link anónimo o recarga) | No se mueve (comportamiento natural del documento); el banner `return-info` se lee al recorrer |
| Llegada al login con banner `expired`, `signed-out`, `signed-out-all` o `registered` | El banner (`tabIndex=-1`); el siguiente Tab va al correo |
| Navegación interna login ↔ registro | `h1` de la nueva pantalla |
| Envío con errores de validación cliente | Primer campo inválido |
| Envío con error 400 de campo (registro) | Ese campo |
| Envío con error de servidor/red/credenciales | Se queda donde estaba; `AuthAlert` (`role="alert"`) se anuncia |
| Registro aceptado (202) | `h1` «Registro recibido» |
| Login correcto | Primer encabezado dentro del `<main>` de destino con `tabIndex=-1` (en Mis proyectos, el `h2` «Mis proyectos», que ya tiene `headingRef` y `tabIndex=-1`); si el destino no tiene encabezado enfocable, el `<main>` con `tabIndex=-1` |
| `SessionErrorPanel` → reintento correcto | Igual que «Login correcto» |
| Menú: Escape o acción elegida | Trigger (antes de ejecutar la acción, igual que `ProjectActionsMenu`) |
| Diálogo cerrado (Cancelar/Escape) | Trigger del menú |
| Alerta de error del menú cerrada | Trigger |

### 9.4 ARIA (solo donde el HTML no alcanza)
- Formularios: `<form noValidate aria-busy="true|false">`; `<label for>` explícitos en todos los campos; `required` nativo; `aria-invalid="true"` solo con error; `aria-describedby` hacia hint y error.
- Botón en carga: `aria-disabled="true"` (no `disabled`); texto de progreso en un `<p role="status" class="auth-visually-hidden">` que existe siempre en el DOM y cambia de contenido.
- Errores a nivel formulario: `role="alert"` (remontado en cada fallo). Errores de campo: sin rol propio (se leen vía `aria-describedby` al recibir foco).
- Banners informativos: `role="status"`.
- `SessionPending`: `<main aria-busy="true">` + `role="status"`.
- Menú: `aria-haspopup="menu"`, `aria-expanded`, `aria-controls` (solo abierto), `role="menu"` con `aria-label="Cuenta"`, `role="menuitem"`. Nombre accesible del trigger: «Menú de cuenta: Ana Gómez» (incluye el texto visible, WCAG 2.5.3). Trigger en carga: `aria-busy="true"` + `aria-disabled="true"`.
- Diálogo: `role="alertdialog"` + `aria-modal="true"` (ya en `ProjectDialog`).
- Pastilla de modo desarrollo: sin rol.
- Avatar, caret y spinners: `aria-hidden="true"`.
- `autocomplete`: `email` (correo, en login y registro), `current-password` (login), `new-password` (ambos campos de contraseña del registro). Todos válidos para la regla axe `autocomplete-valid`.

### 9.5 Texto alternativo
- No hay imágenes. Los únicos glifos decorativos (avatar con inicial, ▾, spinner, ←) llevan `aria-hidden="true"`; el «←» del enlace «← Volver a Mis proyectos» va en un `<span aria-hidden="true">` para que el nombre accesible sea «Volver a Mis proyectos».

### 9.6 Áreas táctiles
- Mínimo 44 × 44 px en: inputs (alto 44), checkbox (fila completa de 44), botones primarios y secundarios (alto 44), enlaces de cambio y de vuelta (alto 44), ítems de menú (alto 44) y trigger del menú (caja visual de 32 px de alto y al menos 32 px de ancho, ampliada a 44 × 44 o más con el pseudo-elemento `inset: -6px`).
- El área ampliada del trigger no se solapa con el control vecino: separación de 12 px en Mis proyectos y en el Editor (ver §6.6).

### 9.7 Objetivos medibles
- axe-core sobre login, registro, registro recibido, error de sesión, `SessionPending`, menú abierto, menú en modo Development y diálogo abierto, en claro y oscuro: **0 violaciones serious/critical** (en particular `color-contrast`, `label`, `autocomplete-valid`, `aria-required-children`, `button-name`, `landmark-one-main`, `page-has-heading-one`, `region`, `nested-interactive`, `aria-allowed-attr`).
- Todos los pares de §2.3 ≥ 4.5:1 (texto) / ≥ 3:1 (no texto).
- Recorrido completo login → envío → error → corrección → éxito solo con teclado.
- Sin errores de consola.
- Layout sin scroll horizontal a 360, 768, 1280 y 1920 px y con zoom 200 %.

---

## 10. Presupuesto de rendimiento

- **Imagen hero:** no hay. Peso máximo 0 KB; no se agrega ninguna imagen, ilustración ni icono en archivo. `srcset` y formatos AVIF/WebP no aplican.
- **Fuentes:** 0 KB (pila de sistema).
- **JS de cliente añadido por la tarjeta:** ≤ 8 KB gzip en total (proveedor de sesión, `AuthBoundary`, `LoginForm`, `RegisterForm`, paneles, `UserMenu`, `LogoutAllDialog`, validación de `returnUrl`). Cero dependencias nuevas. Se mide comparando el tamaño gzip del bundle de `npm run build` antes y después.
- **CSS añadido:** ≤ 3 KB gzip (`auth.css`).
- **Carga diferida:** nada se difiere. Las pantallas de auth son la primera pintura de un visitante anónimo (diferirlas añadiría una ida y vuelta); `ProjectDialog` ya está en el bundle.
- **Peticiones:** una sola `GET /api/v1/auth/me` por arranque de la SPA (no por cambio de vista); el resultado se guarda en el proveedor.
- **CLS:**
  - `SessionPending` reserva `min-height: 60svh`, y el contenido real lo reemplaza entero (no hay elementos que se desplacen).
  - El header de producto se renderiza solo con la sesión resuelta, así que el menú de usuario está desde la primera pintura de esa pantalla (no aparece después empujando «New Project»).
  - El trigger del menú no cambia de ancho en carga (el spinner de 10 px reemplaza al caret en el mismo hueco).
  - Los botones primarios ocupan el ancho completo: el cambio de etiqueta a «Iniciando sesión…» no mueve nada.
  - Los errores de campo y las alertas aparecen como respuesta directa a una acción del usuario (envío), fuera del cómputo de CLS.
- **Lighthouse:** solo si es viable en local; no es requisito de diseño.

---

## 11. Contenido de ejemplo (copy exacto)

Todo en español rioplatense con voseo. Los valores dinámicos se indican fuera de las comillas.

### 11.1 Marca y títulos de documento
- Marca: «VECTORiZE»
- Títulos: «Iniciar sesión — Vectorify», «Crear cuenta — Vectorify», «Registro recibido — Vectorify», «No pudimos comprobar tu sesión — Vectorify».

### 11.2 Sesión cargando
- «Comprobando tu sesión…»

### 11.3 Error al comprobar la sesión
- `h1`: «No pudimos comprobar tu sesión»
- Causa, red caída o sin respuesta: «No se pudo contactar con el servidor. Revisá tu conexión e intentá de nuevo.» (mismo texto que `NETWORK_ERROR_MESSAGE` de Mis proyectos)
- Causa, 5xx: «El servidor no pudo responder (código 503). Intentá de nuevo en unos minutos.» — el número es el status HTTP real.
- Aclaración: «Esto no cierra tu sesión.»
- Botón: «Reintentar» / en carga «Reintentando…»

### 11.4 Login
- `h1`: «Iniciar sesión»
- Intro: «Entrá con tu correo y tu contraseña para ver tus proyectos.»
- Label correo: «Correo electrónico»
- Label contraseña: «Contraseña»
- Checkbox: «Recordarme en este dispositivo»
- Hint del checkbox: «Mantiene tu sesión abierta aunque cierres el navegador. No lo marques en un equipo compartido.»
- Botón: «Iniciar sesión» / en carga «Iniciando sesión…» (también el texto del `role="status"` oculto)
- Línea de cambio: «¿No tenés cuenta?» + enlace «Creá una»

Banners del login:
- `expired`: «Tu sesión terminó. Iniciá sesión de nuevo para continuar.»
- `signed-out`: «Cerraste sesión.»
- `signed-out-all`: «Cerraste sesión en todos tus dispositivos.»
- `registered`: «Registro recibido. Iniciá sesión con tu correo y tu contraseña.»
- `return-info`: «Iniciá sesión para continuar. Después te llevamos a la página que querías abrir.»

Validación cliente (login):
- Correo vacío: «Ingresá tu correo electrónico.»
- Correo con formato inválido: «Ingresá un correo electrónico válido, por ejemplo nombre@ejemplo.com.»
- Contraseña vacía: «Ingresá tu contraseña.»

Alertas del servidor (login):
- 401 (credenciales inválidas, cuenta inexistente **y cuenta bloqueada**, mismo texto siempre) y también 400: «El correo o la contraseña no son correctos. Si fallaste varias veces seguidas, esperá unos minutos antes de volver a intentar.»
- Red: «No se pudo contactar con el servidor. Revisá tu conexión e intentá de nuevo.»
- 5xx: «El servidor no pudo completar el inicio de sesión. Intentá de nuevo en unos minutos.»
- 403: «No pudimos verificar la solicitud. Recargá la página e intentá de nuevo.»
- 429: «Hiciste demasiados intentos. Esperá unos minutos antes de volver a probar.»

### 11.5 Registro
- `h1`: «Crear cuenta»
- Intro: «Creá tu cuenta con tu correo y una contraseña para guardar tus proyectos.»
- Label correo: «Correo electrónico»
- Label contraseña: «Contraseña»
- Hint contraseña: «Usá al menos 12 caracteres. Una frase larga que te resulte fácil de recordar es una buena opción.»
- Label confirmación: «Repetí la contraseña»
- Botón: «Crear cuenta» / en carga «Creando cuenta…»
- Línea de cambio: «¿Ya tenés cuenta?» + enlace «Iniciá sesión»

Validación cliente (registro):
- Correo vacío: «Ingresá tu correo electrónico.»
- Correo inválido: «Ingresá un correo electrónico válido, por ejemplo nombre@ejemplo.com.»
- Contraseña vacía o corta: «La contraseña debe tener al menos 12 caracteres.»
- Contraseña de más de 128 caracteres (pegada): «La contraseña no puede superar los 128 caracteres.»
- Confirmación vacía: «Repetí la contraseña.»
- Confirmación distinta: «Las contraseñas no coinciden.»

Errores del servidor (registro):
- 400 `invalid_email`: en el campo correo, texto del servidor: «Indicá un correo electrónico válido.»
- 400 `weak_password`: en el campo contraseña, texto del servidor (por ejemplo «La contraseña debe tener al menos 12 caracteres.»; el número lo decide la configuración del servidor).
- 400 `invalid_request` u otro 400: alerta «No pudimos procesar el registro con esos datos. Revisalos e intentá de nuevo.»
- Red: «No se pudo contactar con el servidor. Revisá tu conexión e intentá de nuevo.»
- 5xx: «El servidor no pudo completar el registro. Intentá de nuevo en unos minutos.»
- 403: «No pudimos verificar la solicitud. Recargá la página e intentá de nuevo.»
- 429: «Hiciste demasiados intentos. Esperá unos minutos antes de volver a probar.»

### 11.6 Registro recibido
- `h1`: «Registro recibido»
- Cuerpo: «Ya podés iniciar sesión con tu correo y la contraseña que elegiste.»
- Nota: «Si ya tenías una cuenta con este correo, entrá con la contraseña de siempre.»
- Botón: «Ir a iniciar sesión»

Ninguna mención a correos enviados, verificación ni bandeja de entrada.

### 11.7 Menú de usuario
- Nombre accesible del trigger: «Menú de cuenta: » seguido del `displayName` (ejemplo: «Menú de cuenta: Ana Gómez»)
- Etiqueta de la lista: «Cuenta»
- Ítems: «Salir», «Cerrar sesión en todos lados»
- Estado oculto durante la salida: «Cerrando sesión…»
- Error de «Salir», red: «No pudimos cerrar la sesión: no hay conexión con el servidor. Intentá de nuevo.»
- Error de «Salir», 5xx: «El servidor no pudo cerrar la sesión. Intentá de nuevo en unos minutos.»
- Botón de la alerta: «Cerrar aviso»
- Modo Development: pastilla «Modo desarrollo» + `displayName` del usuario de desarrollo.

### 11.8 Diálogo «Cerrar sesión en todos lados»
- Título: «¿Cerrar sesión en todos lados?»
- Descripción: «Vamos a cerrar tu sesión en este navegador y en todos los dispositivos donde entraste con esta cuenta. Después vas a tener que iniciar sesión de nuevo en cada uno.»
- Botones: «Cancelar» | «Cerrar sesión en todos lados» / en carga «Cerrando sesiones…»
- Error, red: «No pudimos cerrar las sesiones: no hay conexión con el servidor. Intentá de nuevo.»
- Error, 5xx: «El servidor no pudo cerrar las sesiones. Intentá de nuevo en unos minutos.»

### 11.9 Contenedor de cuenta (solo tests en S05)
- Enlace: «← Volver a Mis proyectos» (nombre accesible «Volver a Mis proyectos»)
- `h1` de la página de prueba: «Tu cuenta»
- Párrafo de la página de prueba: «Acá vas a poder ver y editar los datos de tu cuenta.»

---

## 12. Supuestos

- No hay marca para auth: se reutiliza el logotipo tipográfico existente «VECTORiZE» (de Mis proyectos y del Editor) y «Vectorify» en `document.title` (como `index.html`).
- Se agregan tokens con prefijo `--auth-` porque `--accent` (#aa3bff) con texto blanco, el enlace global y `--border` en inputs no llegan a AA; los tokens globales no se modifican en esta tarjeta.
- Las pantallas de auth usan inputs de 16 px y objetivos de 44 px aunque el resto de la app use 13–14 px y 32 px.
- Rutas por query string: `?view=login` y `?view=register`, con el parámetro `returnUrl`.
- El motivo de llegada al login (sesión terminada, salió, registro recibido) viaja en memoria, no en la URL.
- El correo se precarga en el login solo desde la memoria del registro recibido; nunca por URL; la contraseña nunca se precarga.
- Se agrega un campo «Repetí la contraseña» en el registro: sin recuperación de contraseña hasta S08, un error de tipeo dejaría la cuenta inaccesible.
- No se incluye botón «Mostrar contraseña» (se permite pegar y el autocompletado de gestores, suficiente para WCAG 3.3.8).
- El mensaje de credenciales incluye siempre la frase sobre esperar tras varios fallos, para cubrir el bloqueo sin revelarlo.
- 400 en login se trata igual que 401 (mismo mensaje).
- Se incluye el mensaje para 429 por compatibilidad con el rate limiting de S09, aunque hoy no se emite.
- La validación cliente usa 12 caracteres (mínimo permitido por `AuthPasswordOptions`); si el servidor exige más, manda su mensaje.
- «Cerrar sesión en todos lados» pide confirmación en un diálogo (reutilizando `ProjectDialog`); «Salir» no.
- Un error de red o 5xx en `logout` no da la sesión por cerrada; un 401 en `logout` sí (ya no había sesión).
- Un error de red o 5xx en `/me` se reintenta a mano («Reintentar») y automáticamente una vez al evento `online`; nunca se interpreta como «sin sesión».
- Ante sesión expirada en el Workspace la redirección es inmediata; los cambios sin guardar del Editor se pierden (el puntero de recuperación de staging existente sigue funcionando).
- El indicador de modo Development llega en la respuesta de `/me` (decisión de backend que declara el implementador); en ese modo no hay menú, ni «Salir», ni pantallas de login/registro.
- El `UserMenu` se inyecta en las cabeceras de producto como slot desde `App`, para que esas pantallas no importen el módulo de auth.
- En S05 el menú no tiene ítem «Mi cuenta» ni otro enlace al contenedor de cuenta; llega con S07.
- Los 403 en pantallas de producto no tienen UI nueva: siguen con su manejo de error genérico existente.
- El `displayName` de `/me` siempre trae un valor no vacío; si llegara vacío, el trigger usa el `email` y la inicial de este.
- El nombre del usuario en el trigger del Editor se oculta visualmente por debajo de 1440 px por falta de espacio en la fila de acciones.
- Se usa voseo rioplatense, igual que el resto de la app.

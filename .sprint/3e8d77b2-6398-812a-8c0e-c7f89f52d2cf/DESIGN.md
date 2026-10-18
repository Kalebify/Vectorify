# DESIGN.md · M3.1-S07 · Perfil y configuración básica de cuenta («Mi cuenta»)

Alcance: la pantalla «Mi cuenta» (perfil) dentro de `AccountLayout`, el ítem «Mi cuenta» del menú de usuario, la entrada equivalente en modo Development, y todos los estados de carga, edición, guardado y error de esa pantalla.

Fuera de alcance, sin ninguna mención en la UI (ni siquiera como «próximamente»): cambio de contraseña, cambio de correo, recuperación (S08), avatar, locale/preferencias, supresión de cuenta y exportación de datos (pendientes de la decisión P11). Justificación: cualquier «próximamente» promete algo sin fecha ni decisión tomada (la supresión ni siquiera está decidida). La única explicación que se da es la del correo, que se muestra pero no se edita, porque el usuario lo ve y es razonable que se pregunte por qué no puede cambiarlo; esa explicación describe el presente («se gestiona con tu cuenta»), no promete el futuro.

Este documento **no crea un sistema visual nuevo**: extiende el de S05 (`.sprint/3e8d77b2-6398-81e1-ac16-f85c9543a936/DESIGN.md`, `frontend/src/auth/auth.css`, `AuthUi.tsx`, `AccountLayout.tsx`, `UserMenu.tsx`, `authCopy.ts`). Todo lo que no se redefine acá se comporta exactamente como en S05.

Stack: React 19 + TypeScript + Vite existentes en `frontend/`. Sin react-router (ruteo a mano por query string), sin dependencias nuevas de UI, CSS plano. Estilos nuevos en `frontend/src/auth/auth.css`, sección «Perfil», con prefijo de clase `profile-`. Copy nuevo en `frontend/src/auth/authCopy.ts`, objeto `PROFILE`. Español rioplatense con voseo, como el resto de la app.

---

## 1. Arquetipo y objetivo de conversión

**Arquetipo: app de una sola página (SPA de herramienta), pantalla de configuración de cuenta de una sola tarea editable**, dentro del contenedor protegido `AccountLayout` de S05. Densidad baja, una columna, un único formulario con un único campo editable y un bloque de datos de solo lectura.

| Qué debe hacer el visitante | Elemento que lo consigue |
|---|---|
| Llegar a su perfil desde cualquier pantalla de producto | Ítem «Mi cuenta» del menú de usuario (o el enlace de cuenta en modo Development) |
| Cambiar su nombre para mostrar y ver el cambio reflejado en el menú | Campo «Nombre para mostrar» + botón primario «Guardar cambios» |
| Entender qué datos son de VECTORiZE y cuáles son de su cuenta de acceso | Dos secciones separadas: «Perfil» (editable) y «Cuenta de acceso» (solo lectura, con la explicación del correo) |
| Volver a trabajar | Enlace «← Volver a Mis proyectos» |

Objetivo secundario: nunca perder lo que el usuario escribió por un fallo de red, servidor, 403 o validación; y nunca confundir esos fallos con «sesión cerrada» (el 401 lo maneja la frontera global de S05).

---

## 2. Tokens de color

**No se agrega ningún token nuevo.** Se reutilizan los globales de `index.css` y los `--auth-*` de `auth.css` (S05 §2). Se listan solo los pares que aparecen en esta pantalla, con su ratio calculado con la fórmula de luminancia relativa de WCAG 2.x. Los valores compuestos de los fondos semitransparentes son los de S05 §2.1.

### 2.1 Tokens usados

| Rol | Token | Claro | Oscuro |
|---|---|---|---|
| Superficie nivel 0 (página, tarjetas de sección, inputs) | `--bg` | `#ffffff` | `#16171d` |
| Superficie nivel 1 (input en solo lectura mientras se guarda, hover de ítem, botón inactivo) | `--code-bg` | `#f4f3ec` | `#1f2028` |
| Superficie nivel 2 (lista del menú de usuario) | `--bg` + borde `--border` + sombra `0 6px 20px rgba(0,0,0,0.18)` | igual | igual |
| Texto primario | `--text-h` | `#08060d` | `#f3f4f6` |
| Texto secundario (intro, hints, etiquetas `dt`, contador) | `--text` | `#6b6375` | `#9ca3af` |
| Texto deshabilitado / inactivo | `--text` sobre `--code-bg` | `#6b6375` | `#9ca3af` |
| Acento base (botón primario, enlaces, borde de foco del input, marca de página actual) | `--auth-accent` | `#9333ea` | `#c084fc` |
| Acento hover | `--auth-accent-hover` | `#7e22ce` | `#d8b4fe` |
| Acento activo | `--auth-accent-active` | `#6b21a8` | `#e9d5ff` |
| Texto sobre acento | `--auth-on-accent` | `#ffffff` | `#16171d` |
| Borde decorativo (tarjetas de sección, separador del menú, botón secundario) | `--border` | `#e5e4e7` | `#2e303a` |
| Borde identificador de input | `--auth-input-border` | `#8b8594` | `#6b7280` |
| Anillo de foco (global) | `--accent` | `#aa3bff` | `#c084fc` |
| Éxito (banner «Guardamos…») | `--ok` / compuesto `--ok-bg` | `#1a9e5a` / `#e8f5ef` | `#4ade80` / `#1e352c` |
| Advertencia | `--warn` / compuesto `--warn-bg` | `#b3760f` / `#f6efe2` | `#fbbf24` / `#38301e` |
| Error (alertas, error de campo, contador excedido) | `--error` / compuesto `--error-bg` | `#d1373f` / `#faebec` | `#f87171` / `#382529` |
| Info (banner de modo desarrollo, pastilla) | `--neutral` / compuesto `--neutral-bg` | `#6b6375` / `#f0eff1` | `#9ca3af` / `#2a2c33` |

La advertencia no se usa en esta pantalla; se lista porque forma parte del sistema heredado.

### 2.2 Pares texto/fondo y de interfaz de esta pantalla

Modo claro:

| Par | Dónde | Ratio | Requisito | Resultado |
|---|---|---|---|---|
| `--text-h #08060d` / `--bg #ffffff` | h1, h2, label, valor del input, valor del correo y de la fecha | 20.2:1 | 4.5:1 | Pasa |
| `--text #6b6375` / `--bg #ffffff` | Intro, hint, `dt`, contador, nota del correo | 5.73:1 | 4.5:1 | Pasa |
| `--text-h #08060d` / `--code-bg #f4f3ec` | Valor del input en solo lectura durante el guardado; ítem de menú en hover | 18.1:1 | 4.5:1 | Pasa |
| `--text #6b6375` / `--code-bg #f4f3ec` | Botón «Guardar cambios» inactivo (sin cambios) y «Descartar cambios» durante el guardado | 5.15:1 | 4.5:1 | Pasa |
| `--auth-on-accent #ffffff` / `--auth-accent #9333ea` | Botón primario | 5.38:1 | 4.5:1 | Pasa |
| `#ffffff` / `--auth-accent-hover #7e22ce` | Botón primario en hover | 6.98:1 | 4.5:1 | Pasa |
| `#ffffff` / `--auth-accent-active #6b21a8` | Botón primario presionado | 8.72:1 | 4.5:1 | Pasa |
| `--auth-accent #9333ea` / `--bg #ffffff` | Enlace «Volver a Mis proyectos» | 5.38:1 | 4.5:1 | Pasa |
| `--auth-accent-hover #7e22ce` / `#ffffff` | Enlace en hover | 6.98:1 | 4.5:1 | Pasa |
| `--auth-accent-active #6b21a8` / `#ffffff` | Enlace presionado | 8.72:1 | 4.5:1 | Pasa |
| `--auth-accent #9333ea` / `--code-bg #f4f3ec` | Ítem de menú presionado | 4.84:1 | 4.5:1 | Pasa |
| `--error #d1373f` / `--bg #ffffff` | Error de campo, contador excedido | 4.85:1 | 4.5:1 | Pasa |
| `--text-h #08060d` / `#faebec` | Texto de `AuthAlert` | 17.4:1 | 4.5:1 | Pasa |
| `--text-h #08060d` / `#e8f5ef` | Texto del banner «Guardamos tu nombre para mostrar.» | 18.0:1 | 4.5:1 | Pasa |
| `--text-h #08060d` / `--bg #ffffff` | Texto del banner de modo desarrollo (variante info, sin fondo) | 20.2:1 | 4.5:1 | Pasa |
| `--neutral #6b6375` / `#f0eff1` | Pastilla «Modo desarrollo» (12 px / 600) | 5.00:1 | 4.5:1 | Pasa |
| `--text-h #08060d` / `--auth-avatar-bg #f2e2ff` | Inicial del avatar | 16.4:1 | 4.5:1 | Pasa |
| Borde `--auth-input-border #8b8594` / `#ffffff` | Input por defecto | 3.57:1 | 3:1 | Pasa |
| Borde `--auth-input-border #8b8594` / `--code-bg #f4f3ec` | Input en solo lectura durante el guardado | 3.21:1 | 3:1 | Pasa |
| Borde `--error #d1373f` / `#ffffff` | Input inválido | 4.85:1 | 3:1 | Pasa |
| Anillo `--accent #aa3bff` / `#ffffff` | Foco visible | 4.39:1 | 3:1 | Pasa |
| Marca de página actual `--auth-accent #9333ea` / `#ffffff` | Barra izquierda de «Mi cuenta» en el menú y borde del enlace de cuenta en modo Development | 5.38:1 | 3:1 | Pasa |
| Marca de página actual `--auth-accent #9333ea` / `--code-bg #f4f3ec` | Misma barra con el ítem en hover/foco | 4.84:1 | 3:1 | Pasa |
| Borde izquierdo `--ok #1a9e5a` / `#e8f5ef` | Banner de guardado | 3.08:1 | 3:1 | Pasa |
| Borde izquierdo `--error #d1373f` / `#faebec` | Alerta | 4.19:1 | 3:1 | Pasa |
| Borde izquierdo `--neutral #6b6375` / `#ffffff` | Banner de modo desarrollo | 5.73:1 | 3:1 | Pasa |
| Spinner `#ffffff` / `#9333ea` | Botón «Guardando…» | 5.38:1 | 3:1 | Pasa |

Modo oscuro:

| Par | Dónde | Ratio | Requisito | Resultado |
|---|---|---|---|---|
| `--text-h #f3f4f6` / `--bg #16171d` | h1, h2, label, valores | 16.3:1 | 4.5:1 | Pasa |
| `--text #9ca3af` / `--bg #16171d` | Intro, hint, `dt`, contador, nota | 7.04:1 | 4.5:1 | Pasa |
| `--text-h #f3f4f6` / `--code-bg #1f2028` | Input en solo lectura, ítem en hover | 14.7:1 | 4.5:1 | Pasa |
| `--text #9ca3af` / `--code-bg #1f2028` | Botones inactivos | 6.38:1 | 4.5:1 | Pasa |
| `--auth-on-accent #16171d` / `--auth-accent #c084fc` | Botón primario | 6.77:1 | 4.5:1 | Pasa |
| `#16171d` / `#d8b4fe` | Botón primario en hover | 10.1:1 | 4.5:1 | Pasa |
| `#16171d` / `#e9d5ff` | Botón primario presionado | 13.1:1 | 4.5:1 | Pasa |
| `--auth-accent #c084fc` / `--bg #16171d` | Enlace | 6.77:1 | 4.5:1 | Pasa |
| `#d8b4fe` / `#16171d` | Enlace en hover | 10.1:1 | 4.5:1 | Pasa |
| `#e9d5ff` / `#16171d` | Enlace presionado | 13.1:1 | 4.5:1 | Pasa |
| `--auth-accent #c084fc` / `--code-bg #1f2028` | Ítem de menú presionado | 6.13:1 | 4.5:1 | Pasa |
| `--error #f87171` / `--bg #16171d` | Error de campo, contador excedido | 6.46:1 | 4.5:1 | Pasa |
| `--text-h #f3f4f6` / `#382529` | Texto de alerta | 13.0:1 | 4.5:1 | Pasa |
| `--text-h #f3f4f6` / `#1e352c` | Texto del banner de guardado | 11.9:1 | 4.5:1 | Pasa |
| `--text-h #f3f4f6` / `--bg #16171d` | Banner de modo desarrollo | 16.3:1 | 4.5:1 | Pasa |
| `--neutral #9ca3af` / `#2a2c33` | Pastilla «Modo desarrollo» | 5.49:1 | 4.5:1 | Pasa |
| `--text-h #f3f4f6` / `#2f273e` | Inicial del avatar | 12.9:1 | 4.5:1 | Pasa |
| Borde `#6b7280` / `#16171d` | Input por defecto | 3.70:1 | 3:1 | Pasa |
| Borde `#6b7280` / `--code-bg #1f2028` | Input en solo lectura durante el guardado | 3.35:1 | 3:1 | Pasa |
| Borde `#f87171` / `#16171d` | Input inválido | 6.46:1 | 3:1 | Pasa |
| Anillo `#c084fc` / `#16171d` | Foco visible | 6.77:1 | 3:1 | Pasa |
| Marca de página actual `#c084fc` / `#16171d` | Barra de «Mi cuenta», borde del enlace de cuenta en Development | 6.77:1 | 3:1 | Pasa |
| Marca de página actual `#c084fc` / `#1f2028` | Barra con el ítem en hover/foco | 6.13:1 | 3:1 | Pasa |
| Borde izquierdo `#4ade80` / `#1e352c` | Banner de guardado | 7.5:1 | 3:1 | Pasa |
| Borde izquierdo `#f87171` / `#382529` | Alerta | 5.18:1 | 3:1 | Pasa |
| Borde izquierdo `#9ca3af` / `#16171d` | Banner de modo desarrollo | 7.04:1 | 3:1 | Pasa |
| Spinner `#16171d` / `#c084fc` | Botón «Guardando…» | 6.77:1 | 3:1 | Pasa |

Pares prohibidos en esta pantalla (no llegan a AA): `--ok #1a9e5a` como color de texto sobre blanco o sobre `--ok-bg` (3.45:1 y 3.08:1 en claro; por eso la confirmación de guardado usa texto `--text-h`, nunca texto verde y nunca la pastilla `status-pill--ok`); `--error` como texto sobre `--error-bg` (4.19:1); `#fff` sobre `--accent`; `--border` como borde de input. Ningún elemento usa `opacity` para indicar inactividad.

El separador del menú y los bordes de las tarjetas de sección usan `--border` (1.27:1): son decorativos, no identifican ningún control, así que no están sujetos a 1.4.11.

---

## 3. Tipografía

Sin cambios de familia ni de carga: pila de sistema `--sans: system-ui, 'Segoe UI', Roboto, sans-serif`; 0 bytes de fuentes web, sin `@font-face`, sin `font-display`, sin subsetting ni preload (no hay nada que cargar). 1 rem = 16 px. Base `16px/145%`, `letter-spacing: 0.18px` (existente).

| Nivel | Uso en esta pantalla | Móvil (≤ 400 px) | Desktop (≥ 401 px) | Peso | Altura de línea | `letter-spacing` |
|---|---|---|---|---|---|---|
| Marca | «VECTORiZE» en el header de `AccountLayout` (párrafo) | 1.375rem (22 px) **nuevo** | 1.75rem (28 px, existente) | 600 | 1.2 | 1px |
| H1 | «Mi cuenta» (regla global de `index.css`) | 1.375rem (22 px) | 1.75rem (28 px) | 600 | 1.2 | -0.4px |
| H2 | «Perfil», «Cuenta de acceso» (regla global) | 1.125rem (18 px) | 1.125rem (18 px) | 600 | 1.18 | -0.2px |
| Cuerpo | Intro de página y de sección, banners, alertas | 0.875rem (14 px) | 0.875rem (14 px) | 400 | 1.45 | 0.18px |
| Label | «Nombre para mostrar» | 0.875rem (14 px) | 0.875rem (14 px) | 600 | 1.3 | 0.18px |
| Input | Valor del nombre | 1rem (16 px) | 1rem (16 px) | 400 | 1.4 | 0.18px |
| `dt` | «Correo electrónico», «Cuenta creada el» | 0.875rem (14 px) | 0.875rem (14 px) | 600 | 1.3 | 0.18px |
| `dd` | Valor del correo y de la fecha | 1rem (16 px) | 1rem (16 px) | 400 | 1.4 | 0.18px |
| Hint / nota / error de campo / contador | Ayuda del campo, nota del correo, error, «23/80» | 0.8125rem (13 px) | 0.8125rem (13 px) | 400 (hint, nota, contador) / 600 (error) | 1.4 | 0.18px |
| Botón primario | «Guardar cambios», «Reintentar» | 1rem (16 px) | 1rem (16 px) | 600 | 1.2 | 0.18px |
| Botón secundario | «Descartar cambios» | 0.875rem (14 px) | 0.875rem (14 px) | 600 | 1.2 | 0.18px |
| Menú | Ítems «Mi cuenta», «Salir», «Cerrar sesión en todos lados»; enlace de cuenta en Development | 0.8125rem (13 px) | 0.8125rem (13 px) | 400 (ítems) / 600 (página actual y enlace Development) | 1.3 | 0.18px |

Reglas:
- **Nuevo:** `.auth-account__brand` baja a 1.375rem en `max-width: 400px` (igual que el h1 global), para que en 360 px quepan la marca y, en modo Development, la pastilla + el enlace de cuenta en una sola fila.
- **Nuevo:** el `dd` global de `index.css` usa `--mono` 14 px; dentro de `.profile-facts` se sobrescribe a `--sans`, 1rem, `--text-h`, con `overflow-wrap: anywhere` (correos largos sin scroll horizontal).
- El contador usa `font-variant-numeric: tabular-nums` para que no tiemble al escribir.
- La fecha se formatea con `Intl.DateTimeFormat("es", { dateStyle: "long" })` en la zona horaria del navegador: «15 de octubre de 2026».

---

## 4. Grilla y espaciado

- **Contenedor:** el `#root` existente (`max-width: 720px`, padding `32px 20px 24px`; `20px 14px 16px` en ≤ 400 px). `AccountLayout` no usa ancho completo.
- **Columnas:** una sola columna de contenido en 360, 768, 1280 y 1920. La única subgrilla es la lista de datos de solo lectura (`.profile-facts`): 1 columna por debajo de 768 px; 2 columnas (`grid-template-columns: 12rem 1fr`, canaleta `--auth-space-4` = 16 px) desde 768 px.
- **Ancho del input:** `width: 100%; max-width: 30rem` (480 px). Un nombre de 80 caracteres no necesita los 630 px interiores de la tarjeta y un campo más corto se lee mejor; el input sigue siendo fluido por debajo de 30rem.
- **Escala de espaciado:** la única escala es `--auth-space-1..6` de S05 (4, 8, 12, 16, 24, 32 px). No se agrega ningún valor suelto. Valores heredados que no son de la escala y se mantienen: radio 8 px de inputs/botones, 10 px de tarjetas, 6 px de ítems de menú, 44 px de objetivos táctiles, 32 px del alto visual del trigger, padding `14px 16px` de `.status-banner`.

### 4.1 Ritmo vertical (de arriba a abajo)

`AccountLayout` (`.auth-account`, gap 24 px):
1. Header (marca + menú).
2. — 24 px —
3. `main.auth-account__main` (flex columna, gap 16 px):
   1. Enlace «← Volver a Mis proyectos» (alto 44 px).
   2. — 16 px —
   3. Cabecera de página **nueva** `.auth-account__head` (flex columna, gap 4 px): h1 «Mi cuenta» con `margin: 0` (anula el `margin-bottom: 4px` global para no duplicar) + `<p class="auth-card__intro">` intro.
   4. — 16 px —
   5. Banner de modo desarrollo (solo en Development; si no está, no hay hueco).
   6. — 16 px —
   7. Sección «Perfil» (tarjeta).
   8. — 16 px —
   9. Sección «Cuenta de acceso» (tarjeta).

Dentro de cada tarjeta `.profile-section` (flex columna, gap 16 px, padding 16 px en ≤ 400 px y 24 px desde 401 px):
- Cabecera de sección `.profile-section__head` (gap 4 px): h2 + intro.
- — 16 px — formulario (`.profile-form`, flex columna, gap 16 px): alerta (si hay) — 16 px — región de confirmación (si tiene banner) — 16 px — campo (label → 4 px → hint → 4 px → input → 4 px → fila de error/contador) — 16 px + 8 px de `margin-top` = 24 px — fila de acciones `.profile-actions` (flex, gap 12 px = `--auth-space-3`).

Regiones vivas vacías: no dejan hueco. La región de confirmación usa la técnica de §5.6 (margen negativo mientras está vacía); la región oculta de progreso usa `auth-visually-hidden` (posición absoluta, fuera del flujo flex).

---

## 5. Inventario de componentes

Foco visible: siempre el `:focus-visible` global (`outline: 2px solid var(--accent); outline-offset: 2px`). Nunca `outline: none` sin reemplazo. Los componentes marcados «(S05)» se usan tal cual; solo se describen sus diferencias.

### 5.1 `AccountLayout` (S05, con dos cambios)
- **Propósito:** marco de la página de cuenta: header con marca y menú, `main` con enlace de vuelta, h1 y contenido.
- **Anatomía:** `div.auth-account` → `header.auth-account__header` (`p.auth-account__brand` «VECTORiZE» + `UserMenu`) → `main.auth-account__main` → `TextLink` de vuelta → `div.auth-account__head` (h1 `tabIndex=-1` + intro opcional) → `children`.
- **Cambios en S07:**
  1. Prop opcional `intro` (texto) que se renderiza bajo el h1 dentro de `.auth-account__head` (gap 4 px, h1 `margin: 0`).
  2. El enlace de vuelta, antes de navegar, pide foco de llegada (`requestArrivalFocus()`), para que al montar Mis proyectos el foco vaya al h2 «Mis proyectos» (`ArrivalFocus` de S05). Mantiene `href` real a la ruta de la app y la intercepción solo para clic izquierdo sin modificadores (igual que `AuthLink`); hoy intercepta cualquier clic y rompe «abrir en pestaña nueva».
- **Header:** `.auth-account__header` agrega `flex-wrap: wrap; row-gap: var(--auth-space-2)` como red de seguridad a 320 px / zoom 200 %.
- **Estados:** no interactivo salvo el enlace (S05 §5.8) y el menú (§5.2). Sesión desconocida, error de sesión y no autenticado los resuelve `AuthBoundary` antes de montarlo.

### 5.2 `UserMenu` (S05, con el ítem «Mi cuenta»)
- **Propósito:** identificar la cuenta, llevar a «Mi cuenta» y ofrecer las salidas.
- **Anatomía de la lista, en este orden exacto (orden DOM = orden visual = orden de flechas):**
  1. «Mi cuenta» — `<a role="menuitem" class="user-menu__item" href="RUTA_DE_LA_APP?view=account">` (RUTA_DE_LA_APP = `window.location.pathname`). Es un enlace real: clic central o Ctrl/Cmd+clic abren otra pestaña.
  2. «Salir» — `button role="menuitem"` (S05), con la clase adicional `user-menu__item--group-start`.
  3. «Cerrar sesión en todos lados» — `button role="menuitem"` (S05).
- **Separador visual** entre «Mi cuenta» y las salidas: **no** es un elemento (dentro de `role="menu"` solo hay `menuitem`, regla de S05). Se dibuja con `.user-menu__item--group-start`: `margin-top: var(--auth-space-1)`, `position: relative` y un `::before` absoluto de 1 px de alto, color `--border`, con `left: 8px; right: 8px; top: -3px`. Decorativo.
- **Teclado:** el de S05 sin cambios. Flecha abajo / Enter / Espacio en el trigger abren y enfocan «Mi cuenta» (primer ítem). Flechas recorren «Mi cuenta» → «Salir» → «Cerrar sesión en todos lados» en ciclo; Inicio = «Mi cuenta»; Fin = «Cerrar sesión en todos lados»; Escape cierra y vuelve al trigger; Tab cierra. Sobre «Mi cuenta», Enter activa el enlace de forma nativa y **Espacio también lo activa** (manejador explícito: `preventDefault` + `click()`), para que se comporte igual que los otros ítems.
- **Activación de «Mi cuenta»** (clic izquierdo sin modificadores, Enter o Espacio): `preventDefault`, cerrar el menú devolviendo el foco al trigger (igual que los otros ítems), y navegar con `pushState` a `?view=account` pidiendo foco en el encabezado (`focusHeading: true`, la misma clave de historial que usa S05 entre login y registro). Al montar la pantalla, el foco va al h1 «Mi cuenta».
- **En la propia pantalla «Mi cuenta»:** el ítem lleva `aria-current="page"`, peso 600 y una barra interior izquierda de 3 px `box-shadow: inset 3px 0 0 var(--auth-accent)`. Activarlo no navega: cierra el menú y mueve el foco al h1 «Mi cuenta».
- **Estilo del ítem enlace:** mismas reglas que `.user-menu__item` más `display: flex; align-items: center; text-decoration: none; color: var(--text-h)` (anula el `a { color: var(--accent) }` global).
- **Estados del ítem «Mi cuenta»:** por defecto fondo transparente, texto `--text-h`; hover fondo `--code-bg`; foco visible fondo `--code-bg` + outline global con `outline-offset: -2px`; activo fondo `--code-bg` y texto `--auth-accent`; página actual como se describió arriba (se combina con hover/foco); deshabilitado: no aplica (es navegación, siempre disponible; mientras «Salir» está en curso el trigger está `aria-disabled` y el menú no se puede abrir, S05).
- **Trigger, alerta de «Salir», diálogo de «Cerrar sesión en todos lados»:** sin cambios respecto de S05. Tras guardar el perfil, el trigger muestra el nombre nuevo y la inicial nueva sin recargar (§6.4).

### 5.3 `DevAccountLink` (variante `development` del `UserMenu`, cambio de S07)
- **Propósito:** en `Auth:Mode=Development` no hay menú (no hay «Salir»), pero la pantalla «Mi cuenta» tiene que ser alcanzable. El nombre del usuario de desarrollo pasa a ser un enlace a «Mi cuenta».
- **Anatomía:** `div.user-menu.user-menu--dev` (S05) → `span.status-pill.status-pill--neutral` «Modo desarrollo» (sin rol, S05) → `<a class="user-menu__dev-link" href="RUTA_DE_LA_APP?view=account">` con: `span.user-menu__avatar` (`aria-hidden`, inicial) + `span.auth-visually-hidden` «Mi cuenta:» + espacio + `span.user-menu__name` (nombre). Nombre accesible: «Mi cuenta: Dev User» (contiene el texto visible, WCAG 2.5.3). Sin caret (no abre nada).
- **Estilo:** mismo cuerpo visual que `.user-menu__trigger`: `display: inline-flex; align-items: center; gap: var(--auth-space-2); height: 32px; padding: 0 var(--auth-space-2); border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text-h); font-size: 0.8125rem; font-weight: 600; text-decoration: none; position: relative`, con el mismo `::after { inset: -6px }` para un área táctil de 44 × 44 px.
- **Estados:** por defecto (como arriba); hover borde `--auth-accent`; foco visible outline global; activo fondo `--code-bg` y borde `--auth-accent`; página actual (`aria-current="page"` en «Mi cuenta»): borde `--auth-accent` y fondo `--code-bg`, y activarlo mueve el foco al h1 sin navegar; deshabilitado: no aplica.
- **Navegación:** idéntica al ítem «Mi cuenta» (§5.2): intercepta solo el clic izquierdo sin modificadores, `pushState` con `focusHeading`.
- Por debajo de 480 px el nombre se oculta visualmente (regla existente de S05 sobre `.user-menu__name`): queda el avatar con la inicial, y el nombre sigue en el nombre accesible. En el Editor por debajo de 1440 px, igual (regla existente).

### 5.4 `ProfileScreen` (pantalla «Mi cuenta»)
- **Propósito:** cargar `GET /api/v1/me`, mostrar el perfil y orquestar los estados de toda la pantalla.
- **Anatomía:** `AccountLayout` (título «Mi cuenta», intro) → según el estado de carga: `ProfileLoading` | `ProfileLoadError` | (`DevModeNotice` si Development) + `ProfileForm` dentro de la sección «Perfil» + `AccountFacts` dentro de la sección «Cuenta de acceso».
- **Estados de la pantalla:**
  - **Cargando el perfil:** `ProfileLoading`. La cabecera de página (enlace de vuelta, h1, intro) se pinta de inmediato.
  - **Error al cargar (red, 5xx, 403, otro 4xx distinto de 401):** `ProfileLoadError`.
  - **401 al cargar:** no hay UI propia. El cliente HTTP dispara «sesión expirada» (S04/S05) y `AuthProvider` lleva al login con el banner «Tu sesión terminó…» y `returnUrl=/?view=account` (válido para `sanitizeReturnUrl`). Tras volver a iniciar sesión, `ArrivalFocus` enfoca el h1 «Mi cuenta».
  - **Listo:** secciones «Perfil» y «Cuenta de acceso».
- **Nunca se muestra** el `id` interno del usuario, ni proveedor, ni subject. La UI ignora cualquier campo de la respuesta que no sea `displayName`, `email`, `createdAt` y el indicador de campos gestionados.
- `document.title`: «Mi cuenta — Vectorify» (con `useDocumentTitle` de S05, restaura el anterior al salir).
- Al desmontar (navegar a otra vista) se abortan con `AbortController` la carga y un guardado en curso.

### 5.5 `ProfileSection` (tarjeta de sección)
- **Propósito:** separar visualmente los datos de VECTORiZE (editables) de los datos de la cuenta de acceso (solo lectura): es el corazón de la «separación» que pide la tarjeta.
- **Anatomía:** `<section class="profile-section" aria-labelledby="ID_DEL_H2">` → `div.profile-section__head` (h2 + `p.auth-card__intro`) → contenido.
- **Estilo:** igual que `.auth-card` pero a ancho completo: `width: 100%; border: 1px solid var(--border); border-radius: 10px; background: var(--bg); padding: var(--auth-space-4)` (≤ 400 px) / `var(--auth-space-5)` (≥ 401 px); `display: flex; flex-direction: column; gap: var(--auth-space-4)`.
- **Variantes:** `perfil` (contiene `ProfileForm`), `cuenta-de-acceso` (contiene `AccountFacts`).
- **Estados:** no interactivo. Los h2 no son enfocables por programa (no hay ningún flujo que los necesite).

### 5.6 `ProfileForm` (nombre para mostrar)
- **Propósito:** editar `displayName` y guardarlo con `PATCH /api/v1/me`, enviando **solo** `{ displayName }`.
- **Anatomía (orden DOM):** `<form class="profile-form" noValidate aria-busy>` →
  1. `AuthAlert` condicional (S05), con `key` = número de fallo para que se remonte y se anuncie aunque el texto se repita.
  2. Región de confirmación `<div class="profile-status" role="status" aria-live="polite">`, **siempre presente en el DOM**. Contiene el banner de guardado solo cuando corresponde: `<div class="status-banner status-banner--online auth-banner"><p>Guardamos tu nombre para mostrar.</p></div>`. El banner interior **no** lleva rol propio: el rol lo tiene el contenedor persistente, así el anuncio es fiable (una región viva que se monta junto con su texto no siempre se anuncia). Mientras está vacía no tiene alto, pero sigue siendo hijo del flex y sumaría un hueco de 16 px; para evitarlo: `.profile-status:empty { margin-bottom: calc(-1 * var(--auth-space-4)); }`. **No** se usa `display: none` (la saca del árbol de accesibilidad) ni `display: contents` (rompe la semántica del rol en algunos navegadores).
  3. `TextField` «Nombre para mostrar» (S05, extendido, §5.7).
  4. `div.profile-actions`: `AuthButton` primario «Guardar cambios» (`type="submit"`) + `AuthButton` secundario «Descartar cambios» (`type="button"`, solo cuando hay cambios sin guardar o durante el guardado). `margin-top: var(--auth-space-2)`.
  5. `<p role="status" class="auth-visually-hidden">` siempre presente: dice «Guardando…» mientras se guarda, «Descartaste los cambios.» tras descartar, y vacío en el resto.
- **Modelo de datos del formulario:** `guardado` (último `displayName` confirmado por el servidor) y `borrador` (lo que hay en el input). «Hay cambios» = `borrador.trim() !== guardado`. Agregar o quitar solo espacios en los extremos **no** cuenta como cambio.
- **Estados:**
  - **Listo, sin cambios:** input editable con el valor guardado. «Guardar cambios» inactivo (§5.9). «Descartar cambios» no se renderiza. Enter en el input no hace nada (el `onSubmit` ignora el envío sin cambios).
  - **Editando con cambios sin guardar:** «Guardar cambios» activo; aparece «Descartar cambios» a su derecha. Si había banner de guardado o alerta, **se quitan al primer cambio del input** (el contenido de `.profile-status` se vacía; la alerta se desmonta). El error de campo se quita al modificar el campo (S05).
  - **Validación cliente (al enviar, nunca mientras se escribe):** valor recortado vacío, más de 80 caracteres, o con caracteres de control (U+0000–U+001F, U+007F–U+009F). Se marca el campo (`aria-invalid`, mensaje en `.auth-field__error`), el foco va al input, no se hace la petición.
  - **Guardando:** `aria-busy="true"` en el form; input `readOnly` (estilo S05: fondo `--code-bg`, `cursor: progress`, sigue enfocable y legible); «Guardar cambios» en carga: spinner + «Guardando…», `aria-disabled="true"`, clics y Enter adicionales ignorados; «Descartar cambios» con `aria-disabled="true"` y estilo inactivo (sigue enfocable, sus clics se ignoran); región oculta «Guardando…».
  - **Guardado (200):** `guardado` y `borrador` pasan a ser el `displayName` **devuelto por el servidor** (ya recortado: si el usuario escribió «  Ana  », el input muestra «Ana»). Se actualiza el usuario en `AuthProvider` con ese nombre, así el trigger del menú (o el enlace de Development) muestra el nombre y la inicial nuevos sin pedir `GET /api/v1/auth/me`. Aparece el banner «Guardamos tu nombre para mostrar.» en la región `aria-live="polite"`. «Guardar cambios» vuelve a inactivo (sigue enfocable); «Descartar cambios» desaparece. Región oculta vacía. **El foco no se mueve.** Si el foco estaba en «Descartar cambios» (que desaparece), pasa al input.
  - **Error de validación del servidor (400 con `code` de validación del nombre, p. ej. `invalid_display_name`):** se muestra como error del campo con el `message` del servidor tal cual (ya viene en español); foco al input; lo escrito se conserva.
  - **Otro 400 / 4xx no clasificado:** `AuthAlert` «No pudimos guardar el nombre con esos datos. Revisalo e intentá de nuevo.»
  - **Error de red, 5xx, 403, 429:** `AuthAlert` con el texto correspondiente (§11.3). `aria-busy="false"`, input editable, **lo escrito se conserva exactamente** (no se recorta ni se repone el valor guardado), sigue habiendo cambios sin guardar, «Guardar cambios» activo para reintentar. **El foco se queda donde estaba** (botón o input). Un 403 **no** cierra la sesión ni redirige (S05).
  - **401 al guardar:** lo maneja la frontera global (redirección al login con «Tu sesión terminó…» y `returnUrl` de esta pantalla). Lo escrito y no guardado se pierde (ver Supuestos).
  - **Descartar:** el borrador vuelve al valor guardado, se quitan error de campo y alerta, el foco va al input, la región oculta dice «Descartaste los cambios.».
  - Vacío: no aplica (siempre hay un nombre guardado). Carga: la resuelve `ProfileLoading`.

### 5.7 `TextField` (S05, extendido para el nombre)
- **Extensiones necesarias (sin cambiar el comportamiento de email/contraseña):** `type="text"`; props opcionales `autoCapitalize` y `spellCheck`; slot opcional `counter` que se pinta a la derecha de la fila inferior.
- **Configuración en esta pantalla:** `name="displayName"`, `type="text"`, `autoComplete="nickname"`, `autoCapitalize="words"`, `spellCheck={false}`, `required`, **sin** `maxLength` (pegar 100 caracteres no se trunca en silencio: se ve el texto completo y la validación explica el límite), hint «Entre 1 y 80 caracteres. Puede ser tu nombre o un apodo.».
- **Contenedor del input:** `max-width: 30rem`.
- **Fila inferior** `div.profile-field__meta` (flex, `justify-content: space-between`, `align-items: flex-start`, gap 12 px, mismo `max-width: 30rem`): a la izquierda el error (si hay), a la derecha el contador.
- **Contador** `p.profile-field__count` con `aria-hidden="true"` (el límite ya está en el hint, que sí está en `aria-describedby`; un contador vivo sería ruido para el lector): «N/80», donde N es la longitud del valor recortado. 13 px, `--text`, `tabular-nums`, `margin-left: auto`. Si N > 80: color `--error`, peso 600.
- **Estados (S05):** por defecto borde `--auth-input-border`; hover borde `--text`; foco visible outline global + borde `--auth-accent`; activo igual que foco; deshabilitado (definido, no usado) fondo `--code-bg`, texto `--text`, borde `--border`; solo lectura durante el guardado como en S05; error `aria-invalid="true"`, borde `--error`, mensaje 13 px / 600 `--error`.

### 5.8 `AccountFacts` (datos de la cuenta de acceso, solo lectura)
- **Propósito:** mostrar el correo y la fecha de alta como **información**, no como controles: no hay ningún input, ni siquiera de solo lectura, para no sugerir que se pueden editar ni sumar paradas de tabulación inútiles.
- **Anatomía:** `<dl class="profile-facts">` →
  - Par correo: `<dt>Correo electrónico</dt>` + `<dd>` con `<span class="profile-facts__value">ana.gomez@ejemplo.com</span>` + `<p class="auth-field__hint profile-facts__note">` con la explicación. Si el `email` es nulo: valor «Sin correo asociado» en `--text`.
  - Par fecha (**opcional**: solo si `createdAt` llega y es una fecha válida; si no, el par entero no se renderiza): `<dt>Cuenta creada el</dt>` + `<dd><time dateTime="2026-10-15T14:32:00Z">15 de octubre de 2026</time></dd>`.
- **Estilo:** `display: grid; gap: var(--auth-space-4)`; cada `dt` 14 px / 600 `--text`, `margin: 0`; cada `dd` sobrescribe el global (ver §3), `margin: 0`; dentro del `dd`, el valor y la nota en columna con gap 4 px. Por debajo de 768 px, cada `dt` va pegado a su `dd` (`dt + dd { margin-top: calc(-1 * var(--auth-space-3)) }`, que deja 4 px entre etiqueta y valor). Desde 768 px: `grid-template-columns: 12rem 1fr; column-gap: var(--auth-space-4); row-gap: var(--auth-space-4)`, `dt` y `dd` alineados arriba, sin margen negativo.
- **Reglas de solo lectura:** el correo se muestra siempre como solo lectura, porque `PATCH` solo acepta `displayName`. El indicador de campos gestionados que envía la API (que marca `email`) se usa para elegir la nota «se gestiona con tu cuenta»; ningún otro campo visible depende de él.
- **Estados:** no interactivo. Sin hover, foco, activo ni deshabilitado. El texto es seleccionable y copiable.

### 5.9 `AuthButton` (S05, con un estado nuevo `inactive`)
- **Variantes en esta pantalla:** primario «Guardar cambios» y «Reintentar»; secundario «Descartar cambios».
- **Ancho:** dentro de `.profile-actions` y `.profile-load-error`, el primario es `width: auto; min-width: 11rem` (176 px, así «Guardar cambios» y «Guardando…» con spinner ocupan el mismo ancho y «Descartar cambios» no se desplaza). En ≤ 400 px, ambos `width: 100%` (§7).
- **Estado nuevo `inactive`** (prop `inactive`, para «Guardar cambios» sin cambios y «Descartar cambios» durante el guardado): `aria-disabled="true"`, **sin** `disabled` (sigue enfocable; el foco no se pierde tras guardar), clic y Enter ignorados, estilo del deshabilitado de S05: fondo `--code-bg`, borde `--border`, texto `--text`, `cursor: not-allowed`, sin `opacity`, sin spinner. Hover y activo no cambian nada en este estado.
- **Resto de estados (S05):** primario por defecto `--auth-accent`; hover `--auth-accent-hover`; foco visible outline global; activo `--auth-accent-active`; carga: spinner + etiqueta de carga, `aria-disabled="true"`, `cursor: progress`. Secundario: hover borde `--text`; foco outline global; activo fondo `--code-bg`; deshabilitado/inactivo como arriba.

### 5.10 `AuthAlert` (S05)
- Errores a nivel formulario y de carga. `role="alert"`, texto `--text-h` sobre `--error-bg`, borde izquierdo `--error`. Se desmonta al iniciar cada envío o reintento y se remonta (con `key` nuevo) si vuelve a fallar. No recibe foco. Sin variante descartable en esta pantalla.

### 5.11 `DevModeNotice` (banner de modo desarrollo)
- **Propósito:** en Development, dejar claro que no hay inicio de sesión real y que lo que se cambie afecta al usuario de desarrollo compartido del entorno.
- **Anatomía:** `<div class="status-banner auth-banner auth-banner--info">` + `<p>` con el texto (§11.4). **Sin** `role` (es contenido estático presente desde el primer render de la pantalla lista: se lee en orden, no hace falta anunciarlo). Sin `tabIndex`.
- **Estados:** visible solo en modo Development; no interactivo.

### 5.12 `ProfileLoading`
- **Propósito:** esperar `GET /api/v1/me` sin mostrar datos a medias.
- **Anatomía:** `<div class="profile-loading" aria-busy="true">` → `<p role="status" class="auth-pending__text">Cargando tu perfil…</p>` (reutiliza el fundido con 300 ms de retraso de S05: una respuesta rápida no produce parpadeo).
- **Estilo:** `padding: var(--auth-space-6) 0; text-align: center` (se muestra en el lugar de las dos tarjetas).
- **Estados:** carga (único). No interactivo.

### 5.13 `ProfileLoadError`
- **Propósito:** fallo al cargar el perfil (red, 5xx, 403, otro 4xx distinto de 401). No es «sesión cerrada».
- **Anatomía:** `<div class="profile-load-error">` (flex columna, gap 16 px, `align-items: flex-start`) → `AuthAlert` con la causa (§11.5) → `<p class="auth-card__intro">Esto no cierra tu sesión.</p>` → `AuthButton` primario «Reintentar».
- **Estados:** error (por defecto); reintentando (botón en carga «Reintentando…», alerta desmontada); reintento correcto → pantalla lista y el foco va al h1 «Mi cuenta» (el botón «Reintentar» desaparece y el foco no puede quedar en el `body`); reintento fallido → alerta remontada, el foco se queda en «Reintentar»; reintento con 401 → frontera global. Además, si el navegador vuelve a estar en línea (evento `online` de `window`) estando en este estado, se reintenta automáticamente una vez (igual que `SessionErrorPanel` de S05).

### 5.14 `TextLink` «← Volver a Mis proyectos» (S05)
- Sin cambios visuales. Estados de S05 §5.8. Cambio de comportamiento descrito en §5.1.

### 5.15 Utilidad `auth-visually-hidden` (S05)
- Para el prefijo «Mi cuenta:» del enlace de Development, el prefijo «Menú de cuenta:» del trigger y la región oculta de progreso del formulario.

---

## 6. Estructura de la página

### 6.1 Ruta
- `?view=account` (solo ese parámetro; los enlaces nunca generan otros). `AppRoot` la resuelve **antes** que las vistas de producto: `?view=account` → `AuthBoundary` → `ProfileScreen` + `ArrivalFocus`. Las pantallas de producto (`App`) no se enteran de la ruta nueva ni importan nada de auth.
- Sin sesión (deep link o recarga): S05 redirige a `?view=login&returnUrl=%2F%3Fview%3Daccount` con el banner «Iniciá sesión para continuar…»; tras el login vuelve a «Mi cuenta» con el foco en el h1.

### 6.2 Pantalla «Mi cuenta», de arriba a abajo (estado listo, modo Authenticated)
1. **Header** (`AccountLayout`): marca «VECTORiZE» a la izquierda; `UserMenu` a la derecha (trigger con avatar, nombre y caret; en la lista, «Mi cuenta» marcado como página actual).
2. **`main`**:
   1. `TextLink` «← Volver a Mis proyectos».
   2. Cabecera de página: h1 «Mi cuenta» + intro.
   3. **Sección «Perfil»** (`ProfileSection` variante perfil): h2 «Perfil» + intro → `ProfileForm` (`AuthAlert` condicional → región de confirmación → `TextField` «Nombre para mostrar» con hint, error y contador → acciones con `AuthButton` «Guardar cambios» | «Descartar cambios»).
   4. **Sección «Cuenta de acceso»** (`ProfileSection` variante cuenta-de-acceso): h2 «Cuenta de acceso» + intro → `AccountFacts` (correo con nota; fecha de alta si existe).

### 6.3 Variantes de la misma estructura
- **Cargando:** puntos 1, 2.1, 2.2 iguales; en lugar de 2.3 y 2.4, `ProfileLoading`.
- **Error de carga:** puntos 1, 2.1, 2.2 iguales; en lugar de 2.3 y 2.4, `ProfileLoadError`.
- **Modo Development:** en el header, `UserMenu` en su variante `development` = pastilla «Modo desarrollo» + `DevAccountLink` (con `aria-current="page"`). En `main`, entre la cabecera de página y la sección «Perfil», `DevModeNotice`. La sección «Perfil» funciona igual (el usuario de desarrollo puede cambiar su nombre). La sección «Cuenta de acceso» cambia su intro y la nota del correo (§11.4). No hay «Salir» ni «Cerrar sesión en todos lados» (S05).

### 6.4 Efectos fuera de la pantalla
- Tras un guardado correcto, el trigger del menú (o `DevAccountLink`) muestra el nombre nuevo y su inicial en la misma pantalla, y también en Mis proyectos, en el flujo clásico y en el Editor al volver, porque todos leen el usuario de `AuthProvider`.
- En las tres cabeceras de producto, la lista del menú gana «Mi cuenta» como primer ítem; en modo Development, el nombre pasa a ser `DevAccountLink`.

### 6.5 Tabla de transiciones

| Evento | Resultado | Foco |
|---|---|---|
| «Mi cuenta» desde el menú o desde `DevAccountLink` en otra pantalla | Push a `?view=account` | h1 «Mi cuenta» |
| «Mi cuenta» estando ya en la pantalla | Sin navegación, menú cerrado | h1 «Mi cuenta» |
| Carga directa / recarga de `?view=account` con sesión | Pantalla con `ProfileLoading` y luego lista | Natural del documento (no se mueve) |
| Llegada tras login con `returnUrl` | Pantalla | h1 (vía `ArrivalFocus`) |
| `GET /api/v1/me` falla (red, 5xx, 403, 4xx) | `ProfileLoadError` | No se mueve |
| Reintento correcto | Pantalla lista | h1 |
| 401 en `GET` o `PATCH` | Login con banner «Tu sesión terminó…» y `returnUrl` | Banner del login (S05) |
| Envío con error de validación cliente o 400 de campo | Error en el campo | Input |
| Envío con red/5xx/403/429/otro 400 | `AuthAlert`, lo escrito se conserva | Se queda donde estaba |
| Guardado correcto | Banner de confirmación, nombre nuevo en el menú | Se queda donde estaba (input si estaba en «Descartar cambios») |
| «Descartar cambios» | Valor guardado repuesto | Input |
| «← Volver a Mis proyectos» | Push a Mis proyectos | h2 «Mis proyectos» (vía `ArrivalFocus`) |
| «Salir» / «Cerrar sesión en todos lados» desde esta pantalla | Igual que S05 | Igual que S05 |

---

## 7. Comportamiento responsive

| Ancho | Header | Cabecera de página y secciones | Formulario | `AccountFacts` |
|---|---|---|---|---|
| **360 px** | `#root` padding 20/14/16 (existente). Marca 22 px (**nuevo**, §3). Trigger: avatar + caret, nombre oculto visualmente (regla S05 por debajo de 480 px; sigue en el nombre accesible y la inicial lo identifica). Development: pastilla «Modo desarrollo» + `DevAccountLink` solo con avatar. Ancho ocupado en Development ≈ 135 + 16 + 112 + 8 + 42 = 313 px de 332 disponibles; si no cupiera (zoom), el header envuelve (`flex-wrap`) y el menú baja a una segunda fila. | h1 22 px. Tarjetas a ancho completo (332 px), padding 16 px. | Input al ancho de la tarjeta (300 px). Acciones en columna, ambos botones `width: 100%`, primario arriba (orden DOM, sin `column-reverse`), gap 12 px. | Una columna: etiqueta, valor y nota apilados. Correos largos cortan con `overflow-wrap: anywhere`. |
| **768 px** | Marca 28 px. Nombre visible en el trigger (truncado a 16 caracteres con elipsis; el nombre completo está en el input de la página). | `#root` 720 px de ancho máximo (680 px útiles). h1 28 px. Tarjetas padding 24 px. | Input `max-width: 30rem` (480 px), alineado a la izquierda. Acciones en fila, alineadas a la izquierda, primario `min-width: 11rem`. | Dos columnas: `dt` de 12rem a la izquierda, `dd` a la derecha. |
| **1280 px** | Igual que 768. | Igual que 768: el contenedor no crece (720 px es el ancho de lectura de la app, y una pantalla de un campo no gana nada con más ancho). | Igual que 768. | Igual que 768. |
| **1920 px** | Igual que 768. | Igual que 768, centrado. | Igual que 768. | Igual que 768. |

Entre 401 y 767 px: tipografía, padding y botones como en 768; `AccountFacts` todavía en una columna. Entre 401 y 479 px el nombre del trigger sigue oculto visualmente.

Qué se oculta y por qué no se pierde información: solo el nombre del trigger / `DevAccountLink` por debajo de 480 px (y en el Editor por debajo de 1440 px, regla de S05). El nombre está en el nombre accesible, la inicial lo identifica visualmente, y en esta misma pantalla se lee completo en el campo «Nombre para mostrar».

No se reordena nada: el orden visual coincide con el DOM y con el de tabulación en todos los anchos. Zoom 200 % y reflow a 320 CSS px: todo es fluido (`max-width`, sin anchos fijos), sin scroll horizontal.

---

## 8. Movimiento

| Qué | Duración | Curva | Notas |
|---|---|---|---|
| Color de fondo/borde/texto en hover/activo de botones, enlaces, input, ítems de menú, `DevAccountLink` | 120 ms | `ease-out` | Solo `background-color`, `border-color`, `color` (S05) |
| Spinner de «Guardando…» y «Reintentando…» | 800 ms por vuelta, infinito | `linear` | `transform: rotate()` (S05) |
| Texto «Cargando tu perfil…» | 150 ms tras 300 ms de retraso | `ease-out` | Solo `opacity` (animación `auth-fade-in` de S05) |
| Banner de guardado, alertas, errores de campo, aparición de «Descartar cambios», cambio de carga a lista | Sin animación | — | Aparecen de inmediato |
| Apertura del menú | Sin animación | — | S05 |

No se anima ningún cambio de layout (alto, ancho, posición) ni se hace scroll animado.

`prefers-reduced-motion`: la regla de S05 ya cubre esta pantalla porque todo vive dentro de `.auth-account` o `.user-menu`:

```css
@media (prefers-reduced-motion: reduce) {
  .auth-layout *, .auth-pending *, .auth-account *, .user-menu *, .auth-button {
    transition: none !important;
    animation: none !important;
  }
}
```

Con movimiento reducido el spinner queda estático (la etiqueta «Guardando…» comunica la carga) y «Cargando tu perfil…» aparece sin fundido ni retraso. No hace falta ninguna regla nueva; el implementador debe comprobar que `ProfileLoading`, `ProfileLoadError` y todo `.profile-*` se renderizan dentro de `.auth-account`.

---

## 9. Accesibilidad

### 9.1 Landmarks y encabezados
- `header` (banner) con la marca como `<p>` y el menú → `main` con todo el contenido. Un único `h1`: «Mi cuenta».
- `h2` «Perfil» y `h2` «Cuenta de acceso», cada uno nombrando su `<section aria-labelledby>` (así las secciones son regiones con nombre y navegables).
- Sin `h3`.
- `document.title`: «Mi cuenta — Vectorify».

### 9.2 Orden de foco (Tab), estado listo
- Authenticated: trigger del menú → «← Volver a Mis proyectos» → input «Nombre para mostrar» → «Guardar cambios» → «Descartar cambios» (solo con cambios) → fin. Las secciones de solo lectura no tienen paradas. El h1 solo recibe foco por programa (`tabIndex=-1`).
- Development: `DevAccountLink` → «← Volver a Mis proyectos» → input → «Guardar cambios» → «Descartar cambios» (solo con cambios).
- Error de carga: trigger → volver → «Reintentar».
- Menú abierto: «Mi cuenta» → «Salir» → «Cerrar sesión en todos lados» con flechas; Tab sale y cierra.
- Ningún `tabIndex` positivo.
- El header va primero en el DOM (igual que S05 y Mis proyectos), por eso el trigger precede al enlace de vuelta.

### 9.3 Manejo del foco
Ver la tabla de §6.5. Reglas que no se pueden saltear:
- Al entrar por navegación interna («Mi cuenta» o `DevAccountLink`): h1.
- Al terminar la carga del perfil: el foco **no** se mueve (si estaba en el h1, se queda ahí).
- Tras guardar: el foco **no** se mueve; la confirmación llega por la región `aria-live="polite"`.
- Ningún elemento enfocado se desmonta sin mover antes el foco a un destino definido («Reintentar» → h1; «Descartar cambios» → input).

### 9.4 ARIA (solo donde el HTML no alcanza)
- Formulario: `<form noValidate aria-busy="true|false">`; `<label for>` explícito; `required` nativo; `aria-invalid="true"` solo con error; `aria-describedby` = id del hint + id del error (en ese orden; el contador no, es `aria-hidden`).
- Botón guardando o inactivo: `aria-disabled="true"`, nunca `disabled`.
- Región de confirmación: `role="status"` + `aria-live="polite"`, persistente en el DOM, contenido cambiante.
- Región de progreso: `<p role="status" class="auth-visually-hidden">`, persistente.
- Errores de formulario y de carga: `role="alert"` (remontado por fallo). Errores de campo: sin rol propio (se leen por `aria-describedby` al enfocar el input, que es a donde va el foco).
- Menú: `role="menu"` con `aria-label="Cuenta"`; los tres ítems `role="menuitem"` (uno es `<a>`); `aria-current="page"` en «Mi cuenta» cuando corresponde.
- `DevAccountLink`: enlace nativo, sin rol; `aria-current="page"` en la pantalla de cuenta.
- `ProfileLoading`: `aria-busy="true"` + `role="status"`.
- Avatar, caret, spinner, flecha «←» y contador: `aria-hidden="true"`.
- `<time dateTime>` para la fecha de alta.
- Pastilla «Modo desarrollo» y `DevModeNotice`: sin rol.

### 9.5 Texto alternativo
No hay imágenes. Los glifos decorativos (inicial del avatar, «▾», «←», spinner, contador) llevan `aria-hidden="true"`. Nombres accesibles relevantes: trigger «Menú de cuenta: Ana Gómez»; `DevAccountLink` «Mi cuenta: Dev User»; enlace de vuelta «Volver a Mis proyectos».

### 9.6 Áreas táctiles
Mínimo 44 × 44 px: input (alto 44), «Guardar cambios», «Descartar cambios» y «Reintentar» (alto 44), enlace de vuelta (alto 44), ítems del menú incluido «Mi cuenta» (alto 44, ancho ≥ 240), trigger y `DevAccountLink` (caja de 32 px ampliada con `::after { inset: -6px }`; ancho visual mínimo de `DevAccountLink` con solo avatar = 8 + 24 + 8 + 2 = 42 px, 54 px con la ampliación). Separación entre la pastilla y `DevAccountLink`: 8 px; la pastilla no es interactiva, así que la ampliación puede solaparla sin conflicto.

### 9.7 Objetivos medibles (axe no está en el repo: se verifican con Testing Library y en navegador, y se declara así en el informe)
1. Exactamente un `getAllByRole("heading", { level: 1 })`, con nombre «Mi cuenta»; dos `heading` de nivel 2 «Perfil» y «Cuenta de acceso»; un `main`, un `banner`.
2. `getByRole("textbox", { name: "Nombre para mostrar" })` existe, es `required`, su descripción accesible contiene «Entre 1 y 80 caracteres»; `queryByRole("textbox", { name: /correo/i })` es `null` (el correo no es un control).
3. El menú abierto expone `menuitem` en el orden «Mi cuenta», «Salir», «Cerrar sesión en todos lados»; Flecha abajo desde el trigger enfoca «Mi cuenta»; en la pantalla de cuenta, «Mi cuenta» tiene `aria-current="page"`.
4. Tras un `PATCH` correcto, el `status` con `aria-live="polite"` contiene «Guardamos tu nombre para mostrar.», `document.activeElement` no cambió, y el trigger del menú tiene nombre accesible «Menú de cuenta: » + nombre nuevo.
5. Red, 5xx, 403 y 429 muestran cada uno su texto exacto en un `alert` distinto; en todos el input conserva el valor escrito y el foco no se movió; un 401 no muestra `alert` y deja la app en el login.
6. Validación cliente: vacío, 81 caracteres y un tabulador pegado producen sus mensajes exactos, `aria-invalid="true"` y foco en el input, sin petición de red.
7. Navegación interna a «Mi cuenta» deja el foco en el h1; «Descartar cambios» deja el foco en el input; reintento correcto deja el foco en el h1.
8. Todos los pares de §2.2 ≥ 4.5:1 (texto) / ≥ 3:1 (no texto), en claro y oscuro.
9. Todos los objetivos interactivos ≥ 44 × 44 px (verificado en navegador con las herramientas de inspección).
10. Recorrido completo solo con teclado: abrir menú → «Mi cuenta» → editar → guardar → error simulado → reintentar → éxito → volver a Mis proyectos.
11. Sin errores de consola; sin scroll horizontal a 360, 768, 1280 y 1920 px ni con zoom 200 %, en modo Authenticated y en modo Development.

---

## 10. Presupuesto de rendimiento

- **Imagen hero:** no hay. Peso máximo 0 KB; no se agrega ninguna imagen, ilustración ni icono en archivo; `srcset` y AVIF/WebP no aplican.
- **Fuentes:** 0 KB (pila de sistema).
- **JS de cliente añadido por la tarjeta:** ≤ 4 KB gzip (pantalla, formulario, datos de solo lectura, cliente de `GET/PATCH /api/v1/me`, cambios en menú y ruta). Cero dependencias nuevas. Se mide comparando el gzip del bundle de `npm run build` antes y después.
- **CSS añadido:** ≤ 1.5 KB gzip en `auth.css`.
- **Carga diferida:** nada. La pantalla es pequeña y `React.lazy` agregaría una ida y vuelta más que lo que ahorra.
- **Peticiones:** un `GET /api/v1/me` por montaje de la pantalla; un `PATCH /api/v1/me` por guardado (nunca en paralelo: los envíos extra se ignoran mientras hay uno en curso); **ningún** `GET /api/v1/auth/me` adicional tras guardar (el usuario de `AuthProvider` se actualiza con la respuesta del `PATCH`).
- **CLS:**
  - La cabecera de página (enlace, h1, intro) se pinta desde el primer render y no se mueve.
  - `ProfileLoading` se reemplaza entero por las tarjetas; debajo no hay ningún elemento (sin footer en `AccountLayout`), así que el reemplazo no desplaza contenido.
  - En modo Development, `DevModeNotice` se renderiza en el mismo render que las tarjetas (el modo ya se conoce desde `/auth/me`), nunca después.
  - «Guardar cambios» tiene `min-width: 11rem`: el cambio a «Guardando…» no mueve «Descartar cambios».
  - La región de confirmación vacía no ocupa alto (§5.6) y el banner aparece solo como respuesta a una acción del usuario (fuera del cómputo de CLS), igual que «Descartar cambios», las alertas y los errores de campo.
  - El trigger del menú puede cambiar de ancho al cambiar el nombre: es respuesta directa a la acción de guardar.

---

## 11. Contenido de ejemplo (copy exacto)

Español rioplatense con voseo. Los valores dinámicos se indican fuera de las comillas. Datos de ejemplo: nombre «Ana Gómez», correo «ana.gomez@ejemplo.com», alta el 15 de octubre de 2026; usuario de desarrollo «Dev User».

### 11.1 Menú de usuario y entrada en Development
- Ítem del menú: «Mi cuenta»
- Prefijo oculto de `DevAccountLink`: «Mi cuenta:» seguido de un espacio y del nombre (ejemplo de nombre accesible completo: «Mi cuenta: Dev User»)
- Resto del menú: sin cambios respecto de S05 («Salir», «Cerrar sesión en todos lados», «Menú de cuenta:», «Cuenta», «Modo desarrollo»).

### 11.2 Cabecera de página
- Enlace: «← Volver a Mis proyectos» (nombre accesible «Volver a Mis proyectos»)
- `h1`: «Mi cuenta»
- Intro: «Revisá cómo te mostramos en VECTORiZE y con qué datos entrás.»
- Título del documento: «Mi cuenta — Vectorify»

### 11.3 Sección «Perfil»
- `h2`: «Perfil»
- Intro: «Esto es de VECTORiZE: el nombre que aparece en el menú de tu cuenta.»
- Label: «Nombre para mostrar»
- Hint: «Entre 1 y 80 caracteres. Puede ser tu nombre o un apodo.»
- Contador: longitud actual + «/80» (ejemplo: «9/80»)
- Botón primario: «Guardar cambios» / en carga «Guardando…»
- Botón secundario: «Descartar cambios»
- Región oculta de progreso: «Guardando…» / tras descartar: «Descartaste los cambios.»
- Confirmación de guardado: «Guardamos tu nombre para mostrar.»

Validación cliente:
- Vacío o solo espacios: «Escribí un nombre para mostrar.»
- Más de 80 caracteres: «El nombre para mostrar puede tener hasta 80 caracteres. Ahora tiene 93.» (el número es la longitud real del valor recortado)
- Caracteres de control: «El nombre para mostrar no puede tener tabulaciones, saltos de línea ni otros caracteres de control.»

Errores al guardar:
- 400 de validación del nombre: en el campo, el `message` del servidor tal cual (ejemplo: «El nombre para mostrar debe tener entre 1 y 80 caracteres.»).
- Otro 400 / 4xx no clasificado: «No pudimos guardar el nombre con esos datos. Revisalo e intentá de nuevo.»
- Red: «No pudimos guardar el cambio: no hay conexión con el servidor. Lo que escribiste sigue acá; revisá tu conexión e intentá de nuevo.»
- 5xx con código: «El servidor no pudo guardar el cambio (código 503). Lo que escribiste sigue acá; intentá de nuevo en unos minutos.» (el número es el status HTTP real)
- 5xx sin código o respuesta ilegible: «El servidor no pudo guardar el cambio. Lo que escribiste sigue acá; intentá de nuevo en unos minutos.»
- 403: «El servidor rechazó el cambio (código 403) y no se guardó. Intentá de nuevo; si vuelve a pasar, copiá el nombre que escribiste y recargá la página.»
- 429: «Hiciste demasiados intentos. Esperá unos minutos antes de volver a probar.» (constante existente `RATE_LIMITED_MESSAGE`)

### 11.4 Sección «Cuenta de acceso»
- `h2`: «Cuenta de acceso»
- Intro (Authenticated): «Son los datos con los que iniciás sesión. No forman parte de tu perfil de VECTORiZE.»
- `dt` correo: «Correo electrónico»
- `dd` correo: el correo (ejemplo «ana.gomez@ejemplo.com»); si no hay: «Sin correo asociado»
- Nota del correo (Authenticated): «Tu correo se gestiona con tu cuenta y no se puede cambiar desde esta pantalla.»
- `dt` fecha: «Cuenta creada el»
- `dd` fecha: fecha larga (ejemplo «15 de octubre de 2026»)

Modo Development:
- Banner `DevModeNotice`: «Estás en modo desarrollo: usás el usuario de desarrollo, sin iniciar sesión. Lo que cambies acá se guarda en ese usuario y lo ve cualquiera que use este entorno.»
- Intro de «Cuenta de acceso»: «Son los datos del usuario de desarrollo configurado en el servidor.»
- Nota del correo: «En modo desarrollo el correo es el del usuario de desarrollo: se gestiona con la configuración del servidor y no se puede cambiar desde esta pantalla.»

### 11.5 Carga del perfil
- Cargando: «Cargando tu perfil…»
- Error, red: «No pudimos cargar tu perfil: no hay conexión con el servidor. Revisá tu conexión e intentá de nuevo.»
- Error, 5xx con código: «El servidor no pudo cargar tu perfil (código 503). Intentá de nuevo en unos minutos.»
- Error, 5xx sin código o respuesta ilegible: «El servidor no pudo cargar tu perfil. Intentá de nuevo en unos minutos.»
- Error, 403: «El servidor rechazó la solicitud (código 403). Recargá la página e intentá de nuevo.»
- Error, otro 4xx: «No pudimos cargar tu perfil. Recargá la página e intentá de nuevo.»
- Aclaración: «Esto no cierra tu sesión.» (constante existente `SESSION_ERROR.clarification`)
- Botón: «Reintentar» / en carga «Reintentando…»

---

## 12. Supuestos

- La ruta de la pantalla es `?view=account`, resuelta en `AppRoot` antes que las vistas de producto.
- «Mi cuenta» va primero en el menú, separado visualmente de las salidas por una línea decorativa dibujada con CSS (no un elemento `separator`).
- «Mi cuenta» en el menú es un `<a role="menuitem">` con `href` real (abre en pestaña nueva con clic central) y Espacio lo activa igual que Enter.
- En modo Development, la entrada a «Mi cuenta» es el nombre del usuario convertido en enlace con avatar (`DevAccountLink`), porque esa variante no tiene menú.
- Tras `PATCH`, la UI actualiza el usuario de `AuthProvider` con el `displayName` de la respuesta (nueva acción del proveedor) en vez de volver a pedir `GET /api/v1/auth/me`.
- En modo Development, `GET /api/v1/auth/me` debe leer `Users.DisplayName` del usuario sembrado (no el valor de configuración `DevelopmentUser:DisplayName`); si no, el nombre editado volvería al de la configuración al recargar. Es requisito de backend que este diseño da por cumplido.
- El correo se muestra como texto en una lista de definición, no como input de solo lectura.
- El `id` interno, el proveedor y el subject nunca se muestran.
- La fecha de alta se muestra solo si llega y es válida, en formato largo en español y en la zona horaria del navegador.
- No hay ninguna nota de «próximamente» para contraseña, correo, avatar, preferencias, supresión ni exportación.
- El input del nombre no tiene `maxLength`; el límite de 80 se valida al enviar, con contador visual `aria-hidden`.
- El conteo de 80 caracteres en el cliente usa la longitud del string recortado de JavaScript (unidades UTF-16), igual que la longitud de string de .NET en el servidor.
- `autocomplete="nickname"` para el nombre para mostrar.
- «Guardar cambios» está inactivo (`aria-disabled`, enfocable) cuando no hay cambios; cambios solo de espacios en los extremos no cuentan.
- Se agrega «Descartar cambios», visible solo con cambios sin guardar o durante el guardado.
- La confirmación de guardado no desaparece por tiempo: se quita al volver a editar, al descartar o al salir de la pantalla.
- No se avisa al salir de la pantalla con cambios sin guardar (ni `beforeunload` ni diálogo): es un único campo de hasta 80 caracteres.
- Ante un 401 al guardar, lo escrito y no guardado se pierde (la frontera global redirige de inmediato, mismo criterio que el Editor en S05).
- El servidor devuelve los errores de validación del nombre como 400 con un `code` propio del campo y `message` en español; cualquier otro 400 va a la alerta general.
- El `PATCH` lleva solo `displayName`; la UI nunca envía otros campos.
- La marca del header de `AccountLayout` baja a 22 px por debajo de 401 px para que el header de Development quepa en 360 px.
- `AccountLayout` gana la prop `intro` y su enlace de vuelta pasa a pedir foco de llegada y a interceptar solo el clic izquierdo sin modificadores.
- `AuthButton` gana el estado `inactive` y `TextField` gana `type="text"`, `autoCapitalize`, `spellCheck` y el slot `counter`, sin cambiar su comportamiento en login y registro.
- El ancho máximo del input (30rem) y la columna de etiquetas (12rem) son decisiones propias, dentro de la escala existente.
- La intro de página y de secciones, y todo el copy nuevo, son propuestas propias en el tono de S05.

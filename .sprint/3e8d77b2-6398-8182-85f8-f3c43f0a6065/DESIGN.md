# DESIGN.md · M3.1-S08 · Recuperación de acceso + verificación de correo

Alcance de este documento, y nada más:

1. Enlaces de ayuda en el login: «¿Olvidaste tu contraseña?» y «¿No te llegó el correo para confirmar tu cuenta?».
2. Pantalla de solicitud de recuperación (`?view=forgot-password`) con su confirmación genérica.
3. Pantalla de restablecimiento (`?view=reset-password`, token en el fragmento de la URL).
4. Pantalla de confirmación de correo (`?view=confirm-email`, token en el fragmento) con reenvío.
5. Sección nueva «Contraseña» dentro de «Mi cuenta» (S07) para cambiar la contraseña.
6. Cómo el registro («Registro recibido») y el login comunican la confirmación de correo sin afirmar que el correo llegó ni revelar si la cuenta existe.

Fuera de alcance, sin ninguna mención en la UI: MFA, login social, supresión de cuenta, cambio de correo, estado «correo confirmado / sin confirmar» en «Mi cuenta».

Este documento **no crea un sistema visual nuevo**. Extiende el de S05 (`.sprint/3e8d77b2-6398-81e1-ac16-f85c9543a936/DESIGN.md`) y S07 (`.sprint/3e8d77b2-6398-812a-8c0e-c7f89f52d2cf/DESIGN.md`) y el código real de `frontend/src/auth/*` (`auth.css`, `AuthUi.tsx`, `LoginScreen.tsx`, `RegisterScreen.tsx`, `ProfileScreen.tsx`, `ProfileForm.tsx`, `authLocation.ts`, `authCopy.ts`, `authErrors.ts`). Todo lo que no se redefine acá se comporta exactamente como en S05/S07.

Stack: React 19 + TypeScript + Vite existentes en `frontend/`. Sin react-router (ruteo a mano por query string en `authLocation.ts` + `AppRoot.tsx`), sin dependencias nuevas, CSS plano en `frontend/src/auth/auth.css` (sección nueva «Recuperación», prefijo `auth-`). Copy nuevo en `frontend/src/auth/authCopy.ts` (objetos `FORGOT`, `RESET`, `CONFIRM_EMAIL`, `RESEND`, `CHANGE_PASSWORD`, `AUTH_HELP`). Español rioplatense con voseo, como el resto de la app.

---

## 1. Arquetipo y objetivo de conversión

**Arquetipo: app de una sola página (SPA de herramienta) — pantallas de autenticación con formulario de una sola tarea** (mismo arquetipo que S05), más **una sección de configuración de cuenta** dentro de «Mi cuenta» (mismo arquetipo que S07). Densidad baja, una columna, una acción primaria por estado.

| Pantalla / estado | Qué debe hacer el visitante | Elemento que lo consigue |
|---|---|---|
| Login | Encontrar la salida si no puede entrar | Lista de ayuda bajo el botón: «¿Olvidaste tu contraseña?» y «¿No te llegó el correo para confirmar tu cuenta?» |
| Solicitud de recuperación | Pedir el enlace | Botón primario «Enviar enlace» |
| Pedido recibido | Ir a su correo; si se equivocó, volver a pedirlo | Texto con el correo escrito + «Volver a pedir el enlace» (secundario) + «Volver a iniciar sesión» (primario) |
| Restablecimiento | Elegir una contraseña nueva y entrar | Botón primario «Guardar contraseña nueva», luego «Ir a iniciar sesión» |
| Enlace no válido / sin enlace | Conseguir un enlace nuevo | Botón primario (enlace) «Pedir un enlace nuevo» |
| Confirmación de correo | Confirmar y seguir | Confirmación automática al cargar; luego «Ir a iniciar sesión» o «Ir a Mis proyectos» |
| Confirmación fallida / sin enlace | Pedir otro correo de confirmación | `ResendConfirmationForm` con botón «Enviar otro enlace» |
| «Mi cuenta» → Contraseña | Cambiar la contraseña sin perder la sesión actual | Botón primario «Cambiar contraseña» |

Objetivos transversales, no negociables:
- **Ninguna pantalla revela si una cuenta existe**, si está confirmada o bloqueada, ni si un correo se envió de verdad. Los textos usan condicionales («Si existe una cuenta…», «debería llegarte»).
- **Ningún token** sale de la memoria de la pestaña: ni `localStorage`, ni `sessionStorage`, ni `history.state`, ni atributos del DOM, ni texto visible, ni consola.

---

## 2. Tokens de color

**No se agrega ningún token nuevo.** Se reutilizan los globales de `index.css` y los `--auth-*` de `auth.css` (S05 §2). Ratios calculados con la fórmula de luminancia relativa de WCAG 2.x (los mismos valores que S05 §2.3 y S07 §2.2; los fondos semitransparentes se dan ya compuestos sobre `--bg`).

### 2.1 Tokens usados

| Rol | Token | Claro | Oscuro |
|---|---|---|---|
| Superficie nivel 0 (página, tarjeta, inputs) | `--bg` | `#ffffff` | `#16171d` |
| Superficie nivel 1 (input en solo lectura durante el envío, botón inactivo) | `--code-bg` | `#f4f3ec` | `#1f2028` |
| Superficie nivel 2 (lista del menú de usuario en «Mi cuenta») | `--bg` + borde `--border` + sombra `0 6px 20px rgba(0,0,0,0.18)` | igual | igual |
| Texto primario | `--text-h` | `#08060d` | `#f3f4f6` |
| Texto secundario (intro, hints, notas) | `--text` | `#6b6375` | `#9ca3af` |
| Texto deshabilitado / inactivo | `--text` sobre `--code-bg` | `#6b6375` | `#9ca3af` |
| Acento base (botón primario, enlaces, borde de foco del input) | `--auth-accent` | `#9333ea` | `#c084fc` |
| Acento hover | `--auth-accent-hover` | `#7e22ce` | `#d8b4fe` |
| Acento activo | `--auth-accent-active` | `#6b21a8` | `#e9d5ff` |
| Texto sobre acento | `--auth-on-accent` | `#ffffff` | `#16171d` |
| Borde decorativo (tarjetas, botón secundario) | `--border` | `#e5e4e7` | `#2e303a` |
| Borde identificador de input | `--auth-input-border` | `#8b8594` | `#6b7280` |
| Anillo de foco global | `--accent` | `#aa3bff` | `#c084fc` |
| Éxito (banners «Cambiamos tu contraseña», pedido de reenvío recibido, banners del login) | `--ok` / `--ok-bg` compuesto | `#1a9e5a` / `#e8f5ef` | `#4ade80` / `#1e352c` |
| Advertencia (banner `expired`, heredado) | `--warn` / `--warn-bg` compuesto | `#b3760f` / `#f6efe2` | `#fbbf24` / `#38301e` |
| Error (alertas, error de campo) | `--error` / `--error-bg` compuesto | `#d1373f` / `#faebec` | `#f87171` / `#382529` |
| Info (banner `return-info`, heredado) | `--neutral` | `#6b6375` | `#9ca3af` |

### 2.2 Pares texto/fondo y de interfaz que aparecen en este alcance

Modo claro:

| Par | Dónde | Ratio | Requisito | Resultado |
|---|---|---|---|---|
| `--text-h #08060d` / `--bg #ffffff` | h1, h2, labels, valores, correo resaltado en intros, cuerpo de paneles | 20.2:1 | 4.5:1 | Pasa |
| `--text #6b6375` / `--bg #ffffff` | Intro, hints, notas, línea de cambio | 5.73:1 | 4.5:1 | Pasa |
| `--text-h #08060d` / `--code-bg #f4f3ec` | Valor del input en solo lectura durante el envío | 18.1:1 | 4.5:1 | Pasa |
| `--text #6b6375` / `--code-bg #f4f3ec` | Botón inactivo | 5.15:1 | 4.5:1 | Pasa |
| `--auth-on-accent #ffffff` / `--auth-accent #9333ea` | Botón primario | 5.38:1 | 4.5:1 | Pasa |
| `#ffffff` / `--auth-accent-hover #7e22ce` | Botón primario en hover | 6.98:1 | 4.5:1 | Pasa |
| `#ffffff` / `--auth-accent-active #6b21a8` | Botón primario presionado | 8.72:1 | 4.5:1 | Pasa |
| `--auth-accent #9333ea` / `--bg #ffffff` | Enlaces de ayuda y de vuelta | 5.38:1 | 4.5:1 | Pasa |
| `--auth-accent-hover #7e22ce` / `#ffffff` | Enlace en hover | 6.98:1 | 4.5:1 | Pasa |
| `--auth-accent-active #6b21a8` / `#ffffff` | Enlace presionado | 8.72:1 | 4.5:1 | Pasa |
| `--text-h #08060d` / `--bg #ffffff` | Botón secundario «Volver a pedir el enlace» | 20.2:1 | 4.5:1 | Pasa |
| `--text-h #08060d` / `--code-bg #f4f3ec` | Botón secundario presionado | 18.1:1 | 4.5:1 | Pasa |
| `--error #d1373f` / `--bg #ffffff` | Error de campo | 4.85:1 | 4.5:1 | Pasa |
| `--text-h #08060d` / `#faebec` | Texto de `AuthAlert` | 17.4:1 | 4.5:1 | Pasa |
| `--text-h #08060d` / `#e8f5ef` | Texto de banners de éxito | 18.0:1 | 4.5:1 | Pasa |
| `--text-h #08060d` / `#f6efe2` | Banner `expired` (heredado, en el login) | 17.6:1 | 4.5:1 | Pasa |
| Borde `--auth-input-border #8b8594` / `#ffffff` | Input por defecto | 3.57:1 | 3:1 | Pasa |
| Borde `--auth-input-border #8b8594` / `--code-bg #f4f3ec` | Input en solo lectura | 3.21:1 | 3:1 | Pasa |
| Borde `--error #d1373f` / `#ffffff` | Input inválido | 4.85:1 | 3:1 | Pasa |
| Borde `--auth-accent #9333ea` / `#ffffff` | Input con foco | 5.38:1 | 3:1 | Pasa |
| Anillo `--accent #aa3bff` / `#ffffff` | Foco visible | 4.39:1 | 3:1 | Pasa |
| Borde izquierdo `--ok #1a9e5a` / `#e8f5ef` | Banner de éxito | 3.08:1 | 3:1 | Pasa |
| Borde izquierdo `--error #d1373f` / `#faebec` | Alerta | 4.19:1 | 3:1 | Pasa |
| Borde izquierdo `--warn #b3760f` / `#f6efe2` | Banner `expired` | 3.33:1 | 3:1 | Pasa |
| Borde izquierdo `--neutral #6b6375` / `#ffffff` | Banner `return-info` | 5.73:1 | 3:1 | Pasa |
| Spinner `#ffffff` / `#9333ea` | Botón en carga | 5.38:1 | 3:1 | Pasa |
| Borde del botón secundario `--border #e5e4e7` / `#ffffff` | Decorativo: el botón se identifica por su texto (20.2:1), como en S05 | 1.27:1 | No exigible (WCAG 1.4.11 no pide borde si el texto identifica el control) | Pasa |

Modo oscuro:

| Par | Dónde | Ratio | Requisito | Resultado |
|---|---|---|---|---|
| `--text-h #f3f4f6` / `--bg #16171d` | h1, h2, labels, valores, correo resaltado | 16.3:1 | 4.5:1 | Pasa |
| `--text #9ca3af` / `--bg #16171d` | Intro, hints, notas | 7.04:1 | 4.5:1 | Pasa |
| `--text-h #f3f4f6` / `--code-bg #1f2028` | Input en solo lectura; secundario presionado | 14.7:1 | 4.5:1 | Pasa |
| `--text #9ca3af` / `--code-bg #1f2028` | Botón inactivo | 6.38:1 | 4.5:1 | Pasa |
| `--auth-on-accent #16171d` / `--auth-accent #c084fc` | Botón primario | 6.77:1 | 4.5:1 | Pasa |
| `#16171d` / `#d8b4fe` | Botón primario en hover | 10.1:1 | 4.5:1 | Pasa |
| `#16171d` / `#e9d5ff` | Botón primario presionado | 13.1:1 | 4.5:1 | Pasa |
| `--auth-accent #c084fc` / `--bg #16171d` | Enlaces | 6.77:1 | 4.5:1 | Pasa |
| `#d8b4fe` / `#16171d` | Enlace en hover | 10.1:1 | 4.5:1 | Pasa |
| `#e9d5ff` / `#16171d` | Enlace presionado | 13.1:1 | 4.5:1 | Pasa |
| `--error #f87171` / `--bg #16171d` | Error de campo | 6.46:1 | 4.5:1 | Pasa |
| `--text-h #f3f4f6` / `#382529` | Texto de alerta | 13.0:1 | 4.5:1 | Pasa |
| `--text-h #f3f4f6` / `#1e352c` | Texto de banners de éxito | 11.9:1 | 4.5:1 | Pasa |
| `--text-h #f3f4f6` / `#38301e` | Banner `expired` | 11.9:1 | 4.5:1 | Pasa |
| Borde `#6b7280` / `#16171d` | Input por defecto | 3.70:1 | 3:1 | Pasa |
| Borde `#6b7280` / `#1f2028` | Input en solo lectura | 3.35:1 | 3:1 | Pasa |
| Borde `#f87171` / `#16171d` | Input inválido | 6.46:1 | 3:1 | Pasa |
| Borde `#c084fc` / `#16171d` | Input con foco | 6.77:1 | 3:1 | Pasa |
| Anillo `#c084fc` / `#16171d` | Foco visible | 6.77:1 | 3:1 | Pasa |
| Borde izquierdo `#4ade80` / `#1e352c` | Banner de éxito | 7.5:1 | 3:1 | Pasa |
| Borde izquierdo `#f87171` / `#382529` | Alerta | 5.18:1 | 3:1 | Pasa |
| Borde izquierdo `#fbbf24` / `#38301e` | Banner `expired` | 7.8:1 | 3:1 | Pasa |
| Borde izquierdo `#9ca3af` / `#16171d` | Banner `return-info` | 7.04:1 | 3:1 | Pasa |
| Spinner `#16171d` / `#c084fc` | Botón en carga | 6.77:1 | 3:1 | Pasa |

Pares prohibidos (heredados de S05/S07, no llegan a AA): `--ok` o `--error` como **color de texto** sobre sus fondos; `#fff` sobre `--accent`; enlace global `a { color: var(--accent) }` (4.39:1); `--border` como borde de input; cualquier `opacity` para indicar inactividad. Todo texto dentro de banners y alertas es `--text-h`.

---

## 3. Tipografía

Sin cambios: pila de sistema `--sans: system-ui, 'Segoe UI', Roboto, sans-serif`. **0 bytes de fuentes web**: no hay `@font-face`, por lo que `font-display`, subsetting y preload no aplican (se declara para que nadie agregue una fuente). Base `16px/145%`, `letter-spacing: 0.18px`. 1 rem = 16 px.

| Nivel | Uso en este alcance | Móvil (≤ 400 px) | Desktop (≥ 401 px) | Peso | Altura de línea | `letter-spacing` |
|---|---|---|---|---|---|---|
| Marca | «VECTORiZE» en `AuthLayout` / `AccountLayout` | 1.125rem (auth) / 1.375rem (cuenta) | 1.25rem (auth) / 1.75rem (cuenta) | 700 / 600 | 1.2 | 1px |
| H1 | Título de cada pantalla/estado («¿Olvidaste tu contraseña?», «Elegí una contraseña nueva»…) | 1.375rem (22 px) | 1.75rem (28 px) | 600 | 1.2 | -0.4px |
| H2 | «Contraseña» en «Mi cuenta» | 1.125rem (18 px) | 1.125rem (18 px) | 600 | 1.18 | -0.2px |
| Cuerpo | Intro, cuerpo de paneles, banners, alertas | 0.875rem (14 px) | 0.875rem (14 px) | 400 | 1.45 | 0.18px |
| Correo resaltado | Correo dentro de un texto («…la cuenta ana.gomez@ejemplo.com.») | 0.875rem | 0.875rem | 600, `overflow-wrap: anywhere` | 1.45 | 0.18px |
| Label | Etiquetas de campo | 0.875rem | 0.875rem | 600 | 1.3 | 0.18px |
| Input | Valor tecleado | 1rem (16 px, evita zoom en iOS) | 1rem | 400 | 1.4 | 0.18px |
| Hint / error de campo | Ayuda, error | 0.8125rem (13 px) | 0.8125rem | 400 / 600 | 1.4 | 0.18px |
| Enlaces de ayuda | Lista bajo el botón del login, «Volver a iniciar sesión» | 0.875rem | 0.875rem | 600 | 1.3 | 0.18px |
| Botón primario | «Enviar enlace», «Guardar contraseña nueva», «Cambiar contraseña», «Reintentar», «Pedir un enlace nuevo»… | 1rem | 1rem | 600 | 1.2 | 0.18px |
| Botón secundario | «Volver a pedir el enlace» | 0.875rem | 0.875rem | 600 | 1.2 | 0.18px |

Regla nueva única: el correo que se repite dentro de un texto va en `<strong class="auth-email">` (peso 600, `overflow-wrap: anywhere`) para que un correo largo no provoque scroll horizontal a 360 px.

---

## 4. Grilla y espaciado

- **Contenedor:** el `#root` existente (`max-width: 720px`; padding `32px 20px 24px`, y `20px 14px 16px` en ≤ 400 px).
- **Pantallas de auth nuevas:** `AuthLayout` + `AuthCard` de S05 (`width: min(400px, 100%)`, centrada, padding 16 px en ≤ 400 px y 24 px desde 401 px). **Una columna** en 360/768/1280/1920; sin canaleta (no hay columnas).
- **«Mi cuenta»:** `AccountLayout` + `ProfileSection` de S07 a ancho completo del `#root`; una columna; campos con `max-width: 30rem` (regla existente `.profile-form .auth-field`).
- **Escala de espaciado única:** `--auth-space-1..6` = 4, 8, 12, 16, 24, 32 px. No se agrega ningún valor suelto. Valores heredados fuera de la escala que se mantienen: radio 8 px (inputs, botones), 10 px (tarjetas), 44 px de objetivo táctil, padding `14px 16px` y borde izquierdo de 4 px de `.status-banner`.

### 4.1 Ritmo vertical en `AuthCard` (pantallas de auth)

Tarjeta en columna con `gap: var(--auth-space-4)` (16 px), igual que S05:

h1 → 4 px → intro → 16 px → banner (si hay) → 16 px → formulario (alerta → 16 → región de estado → 16 → campos con 16 entre sí → 24 (16 + `margin-top` 8 del botón) → botón primario) → 16 px → `AuthHelpLinks` (solo login) → 16 px → línea de cambio / enlace de vuelta.

En paneles de resultado (pedido recibido, contraseña cambiada, enlace no válido, sin enlace, correo confirmado): h1 → 4 px → cuerpo (`.auth-card__body`) → 16 px → nota (`.auth-card__intro`) → 16 px → acciones `.auth-result__actions` (columna, `gap: var(--auth-space-3)` = 12 px): primario a ancho completo arriba, secundario debajo.

### 4.2 Ritmo vertical de la sección «Contraseña» en «Mi cuenta»

Igual que la sección «Perfil» de S07: `ProfileSection` (padding 16/24, gap 16) → cabecera (h2 → 4 px → intro) → 16 px → formulario `.profile-form` (alerta → región de estado persistente (sin hueco cuando está vacía) → campo actual → 16 → campo nueva → 16 → repetir → 24 → `.profile-actions` con el botón primario).

La región de estado vacía no deja hueco: clase nueva `.auth-status:empty { margin-bottom: calc(-1 * var(--auth-space-4)); }`, misma técnica que `.profile-status` de S07 (se reutiliza `.profile-status` dentro de «Mi cuenta» y se usa `.auth-status` dentro de `AuthCard`). **Nunca** `display: none` ni `display: contents` en una región viva.

---

## 5. Inventario de componentes

Foco visible en todo: el `:focus-visible` global (`outline: 2px solid var(--accent); outline-offset: 2px`). Nunca `outline: none` sin reemplazo. Los componentes marcados «(S05)» o «(S07)» se usan sin cambios salvo lo que se indica.

### 5.1 `AuthLayout` (S05)
- **Propósito:** marco de las pantallas anónimas (header con la marca como `<p>` + `<main>`).
- **Uso:** solicitud, restablecimiento, confirmación de correo. Sin menú de usuario, ni siquiera si hay sesión (la tarea es de una sola pantalla y el menú añadiría salidas que interrumpen el flujo).
- **Estados:** no interactivo.

### 5.2 `AuthCard` (S05)
- **Propósito:** contenedor de cada formulario o panel, con `h1 tabIndex=-1`.
- **Variantes nuevas (solo cambia el contenido):** `forgot`, `forgot-sent`, `reset`, `reset-success`, `reset-invalid`, `reset-missing`, `confirm-pending`, `confirm-success`, `confirm-invalid`, `confirm-missing`.
- **Estados:** no interactivo. El h1 recibe foco por programa en los cambios de estado de §9.3.

### 5.3 `AuthBanner` (S05, con dos tipos nuevos)
- **Propósito:** explicar por qué el usuario llega al login.
- **Tipos nuevos:** `password-reset` (clase `status-banner--online`) y `email-confirmed` (clase `status-banner--online`). El motivo viaja **en memoria** en `AuthProvider` (como `signed-out`), nunca en la URL.
- **Prioridad (uno a la vez):** `expired` > `signed-out-all` > `signed-out` > `password-reset` > `email-confirmed` > `registered` > `return-info`.
- **Estados:** visible / ausente; recibe foco por programa al llegar (S05 §9.3). Hover, activo, deshabilitado: no aplican.

### 5.4 `AuthAlert` (S05)
- **Propósito:** errores a nivel formulario o de carga. `role="alert"`, texto `--text-h` sobre `--error-bg`.
- **Regla:** se desmonta al iniciar cada envío y se remonta con `key` = número de fallo, para que se anuncie aunque el texto se repita (patrón de `ProfileForm`).
- **Texto nuevo para 429 con `Retry-After`:** incluye los minutos (§11.8). Si la respuesta no trae la cabecera o no se puede leer, el texto es `RATE_LIMITED_MESSAGE` existente.
- **Estados:** visible / ausente. No recibe foco. No interactivo.

### 5.5 `TextField` (S05)
- **Configuraciones en este alcance** (todas con `required`, label explícito, `aria-describedby` hacia hint y error):

| Pantalla | `name` | `type` | `autoComplete` | Otros |
|---|---|---|---|---|
| Solicitud de recuperación | `email` | `email` | `email` | `autoCapitalize="none"`, `spellCheck=false` (por defecto del tipo) |
| Reenvío de confirmación | `email` | `email` | `email` | ídem |
| Restablecimiento, nueva | `newPassword` | `password` | `new-password` | `minLength=12`, `maxLength=128`, hint de 12 caracteres |
| Restablecimiento, repetir | `newPasswordConfirmation` | `password` | `new-password` | `minLength=12`, `maxLength=128` |
| Cambio, actual | `currentPassword` | `password` | `current-password` | hint de «si no la recordás» |
| Cambio, nueva | `newPassword` | `password` | `new-password` | `minLength=12`, `maxLength=128`, hint de 12 caracteres |
| Cambio, repetir | `newPasswordConfirmation` | `password` | `new-password` | `minLength=12`, `maxLength=128` |

- **Estados (S05):** por defecto borde `--auth-input-border`; hover borde `--text`; foco visible outline global + borde `--auth-accent`; activo igual que foco; deshabilitado (definido, no usado) fondo `--code-bg`, texto `--text`, borde `--border`; solo lectura durante el envío (`readOnly`, fondo `--code-bg`, `cursor: progress`, sigue enfocable); error `aria-invalid="true"`, borde `--error`, mensaje 13 px / 600 `--error`. El error se limpia al modificar ese campo.
- **Nunca** se bloquea pegar ni se desactiva el autocompletado (WCAG 3.3.8). Sin botón «Mostrar contraseña» (decisión heredada de S05).

### 5.6 `HiddenUsernameField` (nuevo)
- **Propósito:** que el gestor de contraseñas asocie la contraseña nueva a la cuenta correcta (los formularios de restablecimiento y de cambio no tienen campo de correo visible).
- **Anatomía:** `<input type="email" name="username" autoComplete="username" value="CORREO" readOnly hidden>` como **primer hijo** del `<form>`. CORREO es el correo del fragmento (restablecimiento) o el `email` del perfil (cambio).
- **Reglas:** el atributo `hidden` lo saca del orden de tabulación y del árbol de accesibilidad; no lleva label (no es un control para personas). Si no hay correo (perfil con `email` nulo) no se renderiza. Nunca contiene el token.
- **Estados:** no interactivo.

### 5.7 `AuthButton` (S05/S07)
- **Variantes usadas:** primario (ancho completo en `AuthCard`; `width: auto; min-width: 11rem` dentro de `.profile-actions`), secundario (`.upload-actions__button` + 44 px de alto), primario como enlace (`AuthLink asButton`).
- **Estados:** por defecto; hover (`--auth-accent-hover` / borde `--text` en secundario); foco visible outline global; activo (`--auth-accent-active` / fondo `--code-bg` en secundario); deshabilitado/inactivo (`aria-disabled="true"` **sin** `disabled`, fondo `--code-bg`, texto `--text`, borde `--border`, sin `opacity`); carga (spinner + etiqueta de carga, `aria-disabled="true"`, `cursor: progress`, clics y Enter extra ignorados).
- **Etiquetas de carga nuevas:** «Enviando…», «Guardando contraseña…», «Reintentando…» (ya existe), «Cambiando contraseña…».

### 5.8 `AuthLink` / `TextLink` (S05)
- **Propósito:** navegación entre vistas de auth sin recarga, con `href` real (abre en otra pestaña) e intercepción solo del clic izquierdo sin modificadores.
- **Cambio:** el tipo `AuthView` suma `"forgot-password" | "reset-password" | "confirm-email"`. Prop nueva opcional `prefillEmail` (se guarda en memoria en `AuthProvider` justo antes de navegar, generalizando el `registeredEmail` de S05; nunca va en la URL).
- **Estilo y estados (S05):** `--auth-accent`, 600, subrayado siempre visible, `min-height: 44px`; hover `--auth-accent-hover` + subrayado 2 px; foco visible outline global; activo `--auth-accent-active`; deshabilitado no aplica.

### 5.9 `AuthHelpLinks` (nuevo, solo en el login)
- **Propósito:** las dos salidas para quien no puede entrar.
- **Anatomía:** `<ul class="auth-help">` con dos `<li>`, cada uno con un `AuthLink`:
  1. «¿Olvidaste tu contraseña?» → `?view=forgot-password` (+ `returnUrl` validado si había), `focusHeading`, `prefillEmail` = correo escrito en el login si tiene formato válido.
  2. «¿No te llegó el correo para confirmar tu cuenta?» → `?view=confirm-email` (sin fragmento ⇒ estado `missing` con reenvío), `focusHeading`, mismo `prefillEmail`.
- **Ubicación:** hijo de `AuthCard` **después del `<form>`** y **antes** de la línea «¿No tenés cuenta? Creá una». No va entre la contraseña y el botón: así el camino principal con teclado (correo → contraseña → Recordarme → Iniciar sesión) no se interrumpe y Enter en la contraseña sigue enviando.
- **Estilo:** `list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0;` cada enlace `font-size: 0.875rem` y `min-height: 44px` (heredado de `.auth-link`). A 360 px el segundo enlace ocupa dos líneas; sigue teniendo ≥ 44 px de alto.
- **Estados:** los del `TextLink`. Durante un envío del login siguen activos (navegar aborta el envío con su `AbortController`, regla S05).

### 5.10 Región de estado persistente `.auth-status` (patrón S07)
- **Propósito:** anunciar éxitos sin mover el foco (reenvío de confirmación, cambio de contraseña).
- **Anatomía:** `<div class="auth-status" role="status" aria-live="polite">` siempre en el DOM; contiene `<div class="status-banner status-banner--online auth-banner"><p>…</p></div>` solo cuando corresponde. El banner interior no lleva rol. En «Mi cuenta» se usa la clase existente `.profile-status`.
- **Estados:** vacía (sin alto) / con banner. No interactiva. El banner se quita al primer cambio en cualquier campo del mismo formulario.

### 5.11 `ForgotPasswordScreen` (`?view=forgot-password`)
- **Propósito:** pedir el enlace de restablecimiento con `POST /api/v1/auth/forgot-password`.
- **Anatomía, estado formulario:** `AuthLayout` → `AuthCard` (variante `forgot`) → `<form class="auth-form" noValidate aria-busy>` → `AuthAlert` condicional → `TextField` correo → `AuthButton` primario submit «Enviar enlace» → `<p role="status" class="auth-visually-hidden">` (progreso) → pie `<p class="auth-card__switch">` «¿Te acordaste?» + `AuthLink` «Volver a iniciar sesión» (conserva `returnUrl`, `prefillEmail` = correo escrito).
- **Anatomía, estado enviado:** misma `AuthCard` con `ResetResultPanel`: h1 «Pedido recibido» → `.auth-card__body` con el correo enviado en `<strong class="auth-email">` → `.auth-card__intro` nota → `.auth-result__actions`: `AuthLink asButton` «Volver a iniciar sesión» (primario) + `AuthButton` secundario «Volver a pedir el enlace». Sin pie.
- **Estados:**
  - Por defecto: correo precargado si llegó en memoria (desde el login o desde «Pedir un enlace nuevo»); si no, vacío.
  - Validación cliente al enviar (nunca al escribir): vacío / formato. Foco al campo.
  - Enviando: `aria-busy="true"`, input `readOnly`, botón en carga «Enviando…», región oculta «Enviando…».
  - 202 (siempre, exista o no la cuenta, y también cuando el límite por dirección se activó en el servidor): pasa al estado enviado; foco al h1.
  - Error: red, 5xx, 403, 429 (con o sin `Retry-After`), 400 sin código de campo → `AuthAlert`; lo escrito se conserva; el foco se queda donde estaba. 400 con `code` `invalid_email` → error del campo con el `message` del servidor; foco al campo.
  - «Volver a pedir el enlace»: vuelve al estado formulario con el mismo correo; foco al campo de correo (no al h1: la intención es corregir o reenviar).
  - Vacío: no aplica.

### 5.12 `ResetPasswordScreen` (`?view=reset-password`)
- **Propósito:** elegir una contraseña nueva con `POST /api/v1/auth/reset-password` `{ email, token, newPassword }`, usando el token capturado del fragmento (§6.1).
- **Estado `ready` (hay token y correo válidos en memoria):** `AuthCard` (variante `reset`): h1 «Elegí una contraseña nueva» → intro con el correo en `<strong class="auth-email">` → `<form class="auth-form" noValidate aria-busy>` → `HiddenUsernameField` → `AuthAlert` condicional → `TextField` nueva (hint) → `TextField` repetir → `AuthButton` primario «Guardar contraseña nueva» → región oculta de progreso → pie con `AuthLink` «Volver a iniciar sesión».
- **Estado `submitting`:** `aria-busy="true"`, inputs `readOnly`, botón «Guardando contraseña…», región oculta «Guardando contraseña…».
- **Estado `success` (`ResetResultPanel`):** h1 «Contraseña cambiada» → cuerpo → nota de sesiones → `AuthLink asButton` «Ir a iniciar sesión» (al navegar: banner `password-reset` + `prefillEmail` = correo del enlace). Al entrar en este estado se borran de memoria el token y las contraseñas. Si en ese navegador había sesión (`AuthProvider` autenticado), se cierra localmente con el `logout` existente (errores ignorados) y el proveedor pasa a «no autenticado» **sin** banner de sesión terminada.
- **Estado `invalid` (`ResetResultPanel`):** cualquier 4xx distinto de 403, 429 y 400 `weak_password` (token caducado, reusado, malformado, de otra cuenta, cuenta inexistente: **un solo mensaje**). h1 «Este enlace ya no es válido» → cuerpo → nota → `AuthLink asButton` «Pedir un enlace nuevo» (`?view=forgot-password`, `prefillEmail` = correo del enlace) + `AuthLink` «Volver a iniciar sesión». Se borran de memoria token y contraseñas.
- **Estado `missing` (`ResetResultPanel`):** no hay token o correo en memoria (se abrió sin fragmento, se recargó la página, el fragmento estaba incompleto o el correo no tiene formato válido). h1 «Abrí el enlace desde tu correo» → cuerpo → `AuthLink asButton` «Pedir un enlace nuevo» + `AuthLink` «Volver a iniciar sesión».
- **Errores recuperables en `ready`:** red, 5xx, 403, 429 → `AuthAlert`; contraseñas conservadas; token conservado en memoria; foco donde estaba. 400 `weak_password` → error en «Contraseña nueva» con el `message` del servidor; foco a ese campo.
- **Validación cliente (al enviar):** nueva < 12 o > 128; repetir vacía o distinta. Foco al primer campo inválido.
- Vacío: no aplica (lo cubre `missing`).

### 5.13 `ResetResultPanel` (nuevo, presentación)
- **Propósito:** panel de resultado sin formulario, compartido por `forgot-sent`, `reset-success`, `reset-invalid`, `reset-missing` y `confirm-success`.
- **Anatomía:** dentro de `AuthCard`: `.auth-card__body` → `.auth-card__intro` (opcional) → `<div class="auth-result__actions">` (columna, gap 12 px) con un primario a ancho completo y, opcional, un secundario (`AuthButton` secundario o `AuthLink` de texto).
- **Estados:** no interactivo salvo sus acciones (estados de §5.7 y §5.8). Al montarse por un cambio de estado, foco al h1 (§9.3).

### 5.14 `ConfirmEmailScreen` (`?view=confirm-email`)
- **Propósito:** confirmar el correo con `POST /api/v1/auth/confirm-email` usando el token capturado, y ofrecer reenvío.
- **Estado `pending` (hay token en memoria; se envía automáticamente al montar, una sola vez):** `AuthCard` (variante `confirm-pending`) h1 «Confirmando tu correo» → `<div aria-busy="true">` con `<p role="status" class="auth-pending__text">Confirmando tu correo…</p>` (fundido con 300 ms de retraso de S05, para que una respuesta rápida no parpadee).
- **Estado `pending` con error recuperable (red, 5xx, 403, 429):** mismo h1 → `AuthAlert` (remontada por intento) → `<p class="auth-card__intro">` «Tu enlace sigue sirviendo mientras no venza.» → `AuthButton` primario «Reintentar» / «Reintentando…». Reintento automático una vez al evento `online` (patrón de `SessionErrorPanel`).
- **Estado `success`:** h1 «Correo confirmado» → cuerpo → acción primaria según sesión: sin sesión, `AuthLink asButton` «Ir a iniciar sesión» (banner `email-confirmed`); con sesión, enlace con apariencia de botón primario «Ir a Mis proyectos» (`href` = ruta de la app, `requestArrivalFocus()` antes de navegar). Token borrado de memoria.
- **Estado `invalid`:** cualquier 4xx distinto de 403 y 429. h1 «No pudimos confirmar tu correo» → cuerpo (mensaje único) → `ResendConfirmationForm` → pie `AuthLink` «Volver a iniciar sesión». Token borrado.
- **Estado `missing` (sin token: entrada desde el login o enlace incompleto/recargado):** h1 «Confirmá tu correo» → cuerpo → `ResendConfirmationForm` → pie `AuthLink` «Volver a iniciar sesión».
- **Doble montaje de `StrictMode`:** el envío automático se protege con una marca a nivel de módulo ligada al token, para que se haga **una sola** petición.

### 5.15 `ResendConfirmationForm` (nuevo)
- **Propósito:** pedir otro correo de confirmación con `POST /api/v1/auth/resend-confirmation` (202 uniforme).
- **Anatomía:** `<form class="auth-form" noValidate aria-busy>` → `AuthAlert` condicional → región `.auth-status` persistente → `TextField` correo (label «Correo de tu cuenta», precargado con el correo del fragmento o con `prefillEmail` si llegó) → `AuthButton` primario «Enviar otro enlace» → región oculta de progreso.
- **Estados:** por defecto; validación cliente (vacío/formato, foco al campo); enviando («Enviando…», input `readOnly`); 202 → banner en `.auth-status` (§11.6), **el foco no se mueve**, el formulario queda disponible (se puede corregir el correo y volver a pedir); error (red/5xx/403/429/400) → `AuthAlert`, foco donde estaba; 400 `invalid_email` → error de campo. El banner de éxito se quita al modificar el correo.
- Deshabilitado y vacío: no aplican.

### 5.16 `ProfileSection` (S07) y `ChangePasswordForm` (nuevo) en «Mi cuenta»
- **Propósito:** cambiar la contraseña con `POST /api/v1/auth/change-password` `{ currentPassword, newPassword }`, manteniendo la sesión actual.
- **Ubicación:** tercera `ProfileSection` («Contraseña»), **después** de «Cuenta de acceso». Solo en estado listo de `ProfileScreen` y **solo en modo Authenticated** (en Development no se renderiza: no hay contraseña).
- **Anatomía:** `<section class="profile-section" aria-labelledby>` → `.profile-section__head` (h2 «Contraseña» + intro) → `<form class="profile-form" noValidate aria-busy>` → `HiddenUsernameField` (correo del perfil) → `AuthAlert` condicional (`key` por fallo) → `.profile-status` persistente (`role="status"`, `aria-live="polite"`) → `TextField` «Contraseña actual» (hint) → `TextField` «Contraseña nueva» (hint) → `TextField` «Repetí la contraseña nueva» → `.profile-actions` con `AuthButton` primario submit «Cambiar contraseña» → región oculta de progreso.
- **Estados:**
  - Por defecto: tres campos vacíos, botón activo (no hay estado «sin cambios»: enviar vacío dispara la validación).
  - Validación cliente al enviar: actual vacía; nueva < 12 o > 128; repetir vacía o distinta. Foco al primer inválido.
  - Enviando: `aria-busy="true"`, inputs `readOnly`, botón «Cambiando contraseña…», región oculta igual.
  - Éxito (2xx): **se vacían los tres campos**, banner de éxito en `.profile-status`; el foco se queda en el botón (no se desmonta). La sesión actual sigue (el servidor re-emite la cookie); el menú de usuario no cambia.
  - 400 `invalid_current_password`: error en «Contraseña actual» (§11.7); foco a ese campo; los tres valores se conservan.
  - 400 `weak_password`: error en «Contraseña nueva» con el `message` del servidor; foco a ese campo.
  - Otro 4xx no clasificado: `AuthAlert`.
  - Red, 5xx, 403, 429: `AuthAlert`; valores conservados; foco donde estaba.
  - 401: la ruta `/api/v1/auth/` **no** dispara la frontera de sesión automática (`sessionBoundary` excluye ese prefijo); el formulario llama explícitamente a la acción de «sesión terminada» de `AuthProvider` ⇒ login con banner `expired` y `returnUrl=/?view=account`. Lo escrito se pierde (mismo criterio que S07).
  - Deshabilitado, vacío, carga inicial: no aplican (la carga la resuelve `ProfileLoading`).

### 5.17 `SessionPending` (S05)
- Se muestra en las vistas nuevas mientras la sesión está en `unknown` (es lo que ya hace `PublicRoutes`). Texto «Comprobando tu sesión…». No interactivo.

### 5.18 Utilidad `auth-visually-hidden` (S05)
- Para las regiones ocultas de progreso.

---

## 6. Estructura de la página

### 6.1 Rutas, fragmento y seguridad de UI

**Rutas nuevas** (por query string, en `authLocation.ts`; `readAuthView` las reconoce):
- `?view=forgot-password` (con `returnUrl` opcional validado, como login/registro).
- `?view=reset-password`, al que el correo enlaza como `PublicBaseUrl` + `/?view=reset-password#email=…&token=…` (valores codificados con `encodeURIComponent`).
- `?view=confirm-email`, enlazado como `PublicBaseUrl` + `/?view=confirm-email#userId=…&token=…` (o `#email=…&token=…`: la SPA acepta cualquiera de los dos identificadores y lo reenvía tal cual).

**Captura del fragmento (antes de cualquier otra cosa):**
1. Módulo con efecto `frontend/src/auth/authFragment.ts`, importado como **primer import** de `main.tsx` (los módulos ES se evalúan en orden de import, así corre antes de `AppRoot`, del `AuthProvider` y de cualquier `fetch`).
2. Si `view` es `reset-password` o `confirm-email` y `location.hash` no está vacío: lee el fragmento con `URLSearchParams`, guarda `{ view, token, email, userId }` en **una variable del módulo** y ejecuta de inmediato `history.replaceState(history.state, "", pathname + search)`. El fragmento se borra **aunque esté mal formado**. Para otras vistas no toca nada.
3. El mismo manejo se registra en `hashchange` (pegar el enlace en una pestaña que ya está en `?view=reset-password` es una navegación de fragmento sin recarga).
4. Las pantallas leen el dato con una función de lectura; lo borran al llegar a `success` o `invalid`, y al salir de la vista.

**Prohibido** (lo verifican tests): guardar el token en `localStorage`, `sessionStorage`, cookies, `history.state`, la query, atributos `data-*`, `value` de inputs, texto visible, `document.title` o `console.*`. El correo del enlace sí se muestra (es del propio usuario) y va en `HiddenUsernameField`.

**Referrer:** el token nunca forma parte del `Referer` (los fragmentos no se envían) y se borra de la barra antes de la primera petición. Las pantallas de recuperación no cargan recursos de terceros ni tienen enlaces externos. **No** se agrega `<meta name="referrer" content="no-referrer">` global: haría que las peticiones del mismo origen salgan con `Origin: null` y el `CsrfGuardMiddleware` (que valida `Origin`) respondería 403.

**Sesión y redirecciones por vista** (en `PublicRoutes`):

| Estado de sesión | login / register / forgot-password | reset-password / confirm-email |
|---|---|---|
| `unknown` | `SessionPending` | `SessionPending` |
| `unauthenticated` | Pantalla | Pantalla |
| `authenticated` (real) | Redirección a `returnUrl` o Mis proyectos (S05) | **Pantalla** (no se redirige) |
| `authenticated` en modo Development | Redirección | Redirección (en Development no hay recuperación) |
| `error` (red/5xx en `/me`) | `SessionErrorPanel` (S05) | **Pantalla** (su propio envío informará el error) |

### 6.2 Login (`?view=login`, cambio mínimo)
1. `AuthLayout` header con marca.
2. `AuthCard` login:
   1. h1 «Iniciar sesión» + intro (sin cambios).
   2. `AuthBanner` (con los tipos nuevos `password-reset` y `email-confirmed`).
   3. `LoginForm` sin cambios de estructura (alerta → correo → contraseña → «Recordarme» → «Iniciar sesión»). **Cambia el texto** de la alerta de credenciales (§11.1).
   4. **Nuevo:** `AuthHelpLinks` («¿Olvidaste tu contraseña?», «¿No te llegó el correo para confirmar tu cuenta?»).
   5. Línea de cambio «¿No tenés cuenta? Creá una» (sin cambios).

Con `Auth:RequireConfirmedEmail=true`, el login de una cuenta sin confirmar devuelve el **mismo 401** y la UI muestra **la misma alerta** de credenciales: la UI no sabe ni distingue el motivo.

### 6.3 Registro recibido (`?view=register` tras el 202, cambio de texto)
- `RegisterReceivedPanel` de S05 con cuerpo y nota nuevos (§11.2), que mencionan el correo de confirmación **en condicional** y nunca afirman que la cuenta es nueva ni que el correo llegó. Botón «Ir a iniciar sesión» sin cambios (banner `registered`).

### 6.4 Solicitud de recuperación (`?view=forgot-password`)
1. `AuthLayout` header.
2. `AuthCard` `forgot`: h1 «¿Olvidaste tu contraseña?» + intro → `ForgotPasswordScreen` formulario (alerta → correo → «Enviar enlace») → pie «¿Te acordaste? Volver a iniciar sesión».
3. Tras el 202: `AuthCard` `forgot-sent` con `ResetResultPanel` (h1 «Pedido recibido», cuerpo con el correo, nota, «Volver a iniciar sesión» primario, «Volver a pedir el enlace» secundario).

### 6.5 Restablecimiento (`?view=reset-password`)
1. `AuthLayout` header.
2. `AuthCard` según estado:
   - `ready`/`submitting`: h1 «Elegí una contraseña nueva» + intro con el correo → formulario (`HiddenUsernameField`, alerta, nueva, repetir, «Guardar contraseña nueva») → pie «Volver a iniciar sesión».
   - `success`: `ResetResultPanel` (h1 «Contraseña cambiada», cuerpo, nota de sesiones, «Ir a iniciar sesión»).
   - `invalid`: `ResetResultPanel` (h1 «Este enlace ya no es válido», cuerpo, nota, «Pedir un enlace nuevo», «Volver a iniciar sesión»).
   - `missing`: `ResetResultPanel` (h1 «Abrí el enlace desde tu correo», cuerpo, «Pedir un enlace nuevo», «Volver a iniciar sesión»).

### 6.6 Confirmación de correo (`?view=confirm-email`)
1. `AuthLayout` header.
2. `AuthCard` según estado: `pending` (h1 + texto de estado, o alerta + «Reintentar»), `success` (`ResetResultPanel`: h1 «Correo confirmado», cuerpo, acción primaria según sesión), `invalid` (h1 «No pudimos confirmar tu correo», cuerpo, `ResendConfirmationForm`, pie), `missing` (h1 «Confirmá tu correo», cuerpo, `ResendConfirmationForm`, pie).

### 6.7 «Mi cuenta» (`?view=account`, sección nueva)
Estructura de S07 §6.2 sin cambios en los puntos 1 a 2.4, más:
- 2.5 **Sección «Contraseña»** (`ProfileSection`): h2 «Contraseña» + intro → `ChangePasswordForm`.
En modo Development la sección no existe. En carga y error de carga la sección no se pinta (la sustituyen `ProfileLoading` / `ProfileLoadError`, como a las otras dos).

### 6.8 Transiciones

| Evento | Resultado | Foco |
|---|---|---|
| Clic en «¿Olvidaste tu contraseña?» | Push a `?view=forgot-password`, correo precargado | h1 «¿Olvidaste tu contraseña?» |
| Clic en «¿No te llegó el correo…?» | Push a `?view=confirm-email` (estado `missing`) | h1 «Confirmá tu correo» |
| Solicitud aceptada (202) | Panel «Pedido recibido» | h1 |
| «Volver a pedir el enlace» | Formulario con el mismo correo | Campo de correo |
| Abrir el enlace de restablecimiento (carga de página) | Fragmento capturado y borrado; estado `ready` o `missing` | Natural del documento (no se mueve) |
| Restablecimiento correcto | Panel «Contraseña cambiada»; sesión local cerrada si había | h1 |
| Restablecimiento con enlace no válido | Panel «Este enlace ya no es válido» | h1 |
| «Ir a iniciar sesión» tras restablecer | Login con banner `password-reset`, correo precargado | Banner (S05) |
| Abrir el enlace de confirmación | `pending` y envío automático | Natural del documento |
| Confirmación resuelta (éxito o inválido) | Panel correspondiente | h1 (el contenido cambió entero) |
| Confirmación con error recuperable | Alerta + «Reintentar» | No se mueve (la alerta se anuncia) |
| Reintento de confirmación correcto/inválido | Panel correspondiente | h1 |
| Reenvío aceptado (202) | Banner en la región de estado | No se mueve |
| «Ir a iniciar sesión» tras confirmar | Login con banner `email-confirmed` | Banner |
| «Ir a Mis proyectos» tras confirmar (con sesión) | Mis proyectos | h2 «Mis proyectos» (vía `ArrivalFocus`) |
| Cambio de contraseña correcto | Campos vacíos, banner de éxito | Se queda en «Cambiar contraseña» |
| Cambio con contraseña actual incorrecta | Error en «Contraseña actual» | Ese campo |
| 401 en cambio de contraseña | Login con banner `expired`, `returnUrl=/?view=account` | Banner (S05) |
| Usuario autenticado abre `?view=forgot-password` | Redirección (reemplazo) a `returnUrl` o Mis proyectos | Como S05 |

---

## 7. Comportamiento responsive

| Ancho | Pantallas de auth (solicitud, restablecimiento, confirmación) | Login | «Mi cuenta» → Contraseña |
|---|---|---|---|
| **360 px** | `#root` padding 20/14/16; tarjeta de 332 px con padding 16 (300 px útiles); h1 22 px; botones primario y secundario a ancho completo, apilados (primario arriba); correo resaltado parte con `overflow-wrap: anywhere`. Nada se oculta. | `AuthHelpLinks` en columna; «¿No te llegó el correo para confirmar tu cuenta?» ocupa dos líneas (alto ≥ 44 px). | Sección a ancho completo, padding 16; campos al ancho de la tarjeta; botón «Cambiar contraseña» a ancho completo (regla existente `.profile-actions` ≤ 400 px). |
| **768 px** | Tarjeta de 400 px centrada, padding 24; h1 28 px; acciones de resultado siguen en columna y a ancho completo (la tarjeta tiene 352 px útiles: dos botones en fila no caben con su texto). | Enlaces de ayuda en una línea cada uno. | Campos `max-width: 30rem`; botón `width: auto; min-width: 11rem`, alineado a la izquierda. |
| **1280 px** | Igual que 768 (una columna de 400 px es el ancho de lectura correcto para una tarea). | Igual que 768. | Igual que 768 (el `#root` no pasa de 720 px). |
| **1920 px** | Igual que 768, centrado. | Igual que 768. | Igual que 768. |

- No se oculta nada en ningún ancho, así que no hay información perdida. No se reordena nada: orden visual = orden DOM = orden de tabulación.
- Zoom 200 % y reflow a 320 CSS px: todo es fluido (`min(400px, 100%)`, `max-width`), sin scroll horizontal; los correos largos parten.

---

## 8. Movimiento

| Qué | Duración | Curva | Notas |
|---|---|---|---|
| Color de fondo/borde/texto en hover y activo de botones, enlaces e inputs | 120 ms | `ease-out` | Solo `background-color`, `border-color`, `color` (S05) |
| Spinner de botón en carga | 800 ms por vuelta, infinito | `linear` | `transform: rotate()` (S05) |
| Texto «Confirmando tu correo…» | 150 ms tras 300 ms de retraso | `ease-out` | Solo `opacity` (animación `auth-fade-in` de S05) |
| Cambios de estado de tarjeta (formulario ↔ panel), banners, alertas, errores de campo | Sin animación | — | Aparecen de inmediato |

No se anima ningún cambio de layout ni se hace scroll animado.

`prefers-reduced-motion`: la regla existente de `auth.css` ya cubre todo, porque las pantallas nuevas viven dentro de `.auth-layout` y la sección nueva dentro de `.auth-account`:

```css
@media (prefers-reduced-motion: reduce) {
  .auth-layout *, .auth-pending *, .auth-account *, .user-menu *, .auth-button {
    transition: none !important;
    animation: none !important;
  }
}
```

Con movimiento reducido el spinner queda estático (la etiqueta «Enviando…» / «Guardando contraseña…» comunica la carga) y «Confirmando tu correo…» aparece sin fundido ni retraso. No hace falta regla nueva.

---

## 9. Accesibilidad

### 9.1 Landmarks y encabezados
- Pantallas de auth: `<header>` (marca como `<p>`) → `<main>` → **un único `h1`** por estado (el texto del h1 cambia con el estado; nunca hay dos). Sin `h2`.
- «Mi cuenta»: un `h1` «Mi cuenta»; `h2` «Perfil», «Cuenta de acceso» y **«Contraseña»**, cada uno nombrando su `<section aria-labelledby>`. Sin `h3`.
- `document.title` = h1 del estado + « — Vectorify» (§11.9), con `useDocumentTitle` (restaura el anterior al salir).

### 9.2 Orden de foco (Tab)
- Login: (banner si recibió foco) → correo → contraseña → «Recordarme» → «Iniciar sesión» → «¿Olvidaste tu contraseña?» → «¿No te llegó el correo para confirmar tu cuenta?» → «Creá una».
- Solicitud: correo → «Enviar enlace» → «Volver a iniciar sesión».
- Pedido recibido: «Volver a iniciar sesión» → «Volver a pedir el enlace».
- Restablecimiento `ready`: contraseña nueva → repetir → «Guardar contraseña nueva» → «Volver a iniciar sesión». (`HiddenUsernameField` no es parada.)
- Resultado de restablecimiento: primario → secundario (si hay).
- Confirmación `pending` con error: «Reintentar». `success`: acción primaria. `invalid` / `missing`: correo → «Enviar otro enlace» → «Volver a iniciar sesión».
- «Mi cuenta» (Authenticated): trigger del menú → «← Volver a Mis proyectos» → nombre → «Guardar cambios» → («Descartar cambios») → contraseña actual → contraseña nueva → repetir → «Cambiar contraseña».
- Ningún `tabIndex` positivo.

### 9.3 Manejo del foco al cambiar de estado
Reglas (detalle por evento en §6.8):
- **Cambio de pantalla interno** (enlace de auth con `focusHeading`): h1 de la pantalla nueva.
- **Cambio de estado que reemplaza la tarjeta entera** (formulario → panel; `pending` → resultado): h1, con `flushSync` antes de enfocar.
- **Carga de página desde el correo:** el foco no se mueve.
- **Error de validación o de campo del servidor:** primer campo inválido / ese campo.
- **Error de red/servidor/403/429:** el foco se queda donde estaba; la alerta (`role="alert"`) se anuncia.
- **Éxito sin cambio de tarjeta** (reenvío, cambio de contraseña): el foco no se mueve; anuncio por la región `aria-live="polite"`.
- **Ningún elemento enfocado se desmonta sin mover antes el foco** a un destino definido («Reintentar» → h1; «Volver a pedir el enlace» → campo de correo).

### 9.4 ARIA (solo donde el HTML no alcanza)
- Formularios: `<form noValidate aria-busy="true|false">`; `<label for>` en todos los campos visibles; `required`; `aria-invalid="true"` solo con error; `aria-describedby` = hint + error.
- Botones en carga o inactivos: `aria-disabled="true"`, nunca `disabled`.
- Progreso: `<p role="status" class="auth-visually-hidden">` persistente con «Enviando…», «Guardando contraseña…», «Cambiando contraseña…».
- Confirmación en curso: contenedor `aria-busy="true"` + `<p role="status">` visible.
- Éxitos sin cambio de tarjeta: `role="status"` + `aria-live="polite"` persistente (§5.10).
- Errores a nivel formulario o de carga: `role="alert"` remontado por fallo. Errores de campo: sin rol (se leen al enfocar).
- Lista de ayuda: `<ul>` nativa, sin rol extra.
- `HiddenUsernameField`: atributo `hidden` (fuera del árbol de accesibilidad); sin label.
- `autocomplete` válidos (regla axe `autocomplete-valid`): `email`, `username`, `current-password`, `new-password`.
- Spinner: `aria-hidden="true"`.

### 9.5 Texto alternativo
No hay imágenes ni iconos nuevos. Los glifos decorativos heredados (spinner, «←» del enlace de vuelta) llevan `aria-hidden="true"`.

### 9.6 Áreas táctiles
Mínimo 44 × 44 px: todos los inputs (alto 44), botones primarios y secundarios (alto 44), enlaces de ayuda y de vuelta (`min-height: 44px`, ancho = texto, siempre > 44 px), botón «Reintentar». Separación vertical entre los dos enlaces de ayuda: 0 px, pero cada uno tiene su propia caja de 44 px sin solaparse.

### 9.7 Objetivos medibles
axe no está en el repo: se verifican con Testing Library y en navegador, y se declara así en el informe.
1. Cada estado de cada pantalla nueva tiene exactamente un `heading` de nivel 1 con el texto de §11; un `main` y un `banner`.
2. Login: los enlaces «¿Olvidaste tu contraseña?» y «¿No te llegó el correo para confirmar tu cuenta?» están en el DOM **después** del botón «Iniciar sesión» y antes de «Creá una»; `userEvent.tab()` desde «Iniciar sesión» llega a «¿Olvidaste tu contraseña?».
3. Solicitud: con correo de cuenta existente y con correo inexistente (mock 202 idéntico) el DOM resultante es **idéntico** (snapshot de la tarjeta) y el foco está en el h1 «Pedido recibido».
4. Restablecimiento: tras montar con `#email=…&token=…`, `window.location.hash === ""`; `history.state` no contiene el token; el token no aparece en `document.body.innerHTML`, en `document.title`, en `localStorage` ni en `sessionStorage`; `replaceState` se llamó antes del primer `fetch` (orden verificado con espías).
5. Los campos de contraseña exponen `autocomplete` `new-password` / `current-password`; hay un `input` con `autocomplete="username"` y atributo `hidden` dentro de cada formulario de contraseña.
6. Token caducado, reusado, malformado, de otra cuenta y cuenta inexistente (mocks 400 con códigos distintos) muestran **el mismo** h1 «Este enlace ya no es válido» y el mismo cuerpo; el foco está en el h1.
7. Sin fragmento, tras recarga simulada o con fragmento incompleto: estado `missing`.
8. 429 con `Retry-After: 120` muestra «…Probá de nuevo en 2 minutos.»; sin cabecera, `RATE_LIMITED_MESSAGE`; en ambos casos el foco no se movió y los valores se conservan.
9. Confirmación: una sola petición `confirm-email` aunque el componente se monte dos veces (`StrictMode`); éxito e inválido mueven el foco al h1; el reenvío muestra el banner en un `status` y no mueve el foco.
10. «Mi cuenta»: tres `heading` de nivel 2 en orden «Perfil», «Cuenta de acceso», «Contraseña»; en Development no existe «Contraseña». Éxito: los tres campos quedan vacíos, el `status` contiene el texto de §11.7 y el foco sigue en «Cambiar contraseña»; 400 `invalid_current_password` deja el foco en «Contraseña actual» con su error; 401 lleva al login con banner `expired`.
11. Todos los pares de §2.2 ≥ 4.5:1 (texto) / ≥ 3:1 (no texto) en claro y oscuro.
12. Recorridos completos solo con teclado: login → «¿Olvidaste…?» → enviar → «Volver a iniciar sesión»; restablecimiento → error de validación → corrección → éxito → login; «Mi cuenta» → cambio de contraseña → error → éxito.
13. Sin errores de consola y sin scroll horizontal a 360, 768, 1280 y 1920 px ni con zoom 200 %.

---

## 10. Presupuesto de rendimiento

- **Imagen hero:** no hay. Peso máximo 0 KB; ninguna imagen, ilustración ni icono en archivo; `srcset` y AVIF/WebP no aplican.
- **Fuentes:** 0 KB.
- **JS de cliente añadido:** ≤ 6 KB gzip en total (captura del fragmento, tres pantallas, `ResendConfirmationForm`, `ChangePasswordForm`, funciones de `authApi`, lectura de `Retry-After`). Cero dependencias nuevas. Se mide comparando el gzip del bundle de `npm run build` antes y después.
- **CSS añadido:** ≤ 0.5 KB gzip (`.auth-help`, `.auth-status:empty`, `.auth-result__actions`, `.auth-email`).
- **Carga diferida:** nada. Las pantallas se abren desde un correo en frío; `React.lazy` agregaría una ida y vuelta antes de poder mostrar el formulario. La captura del fragmento **no** puede diferirse.
- **Peticiones:** solicitud, restablecimiento, reenvío y cambio: una por envío, nunca en paralelo (envíos extra ignorados mientras hay uno en curso). Confirmación: una automática por token. Ninguna `GET /api/v1/auth/me` extra (la de arranque de S05 basta); tras un restablecimiento con sesión, un `POST /api/v1/auth/logout` de mejor esfuerzo.
- **CLS:**
  - Los cambios formulario ↔ panel reemplazan el contenido de la tarjeta como respuesta a una acción del usuario (fuera del cómputo de CLS).
  - La confirmación automática no es una acción del usuario: el estado `pending` reserva su alto con el h1 y un párrafo de una línea; el resultado reemplaza la tarjeta, que está sola en el `main` (nada debajo se desplaza).
  - Las regiones de estado vacías no ocupan alto; banners y alertas aparecen solo tras una acción.
  - Botones primarios a ancho completo en `AuthCard`: el cambio de etiqueta a «Enviando…» no mueve nada; en «Mi cuenta» el botón no tiene vecino a su derecha.

---

## 11. Contenido de ejemplo (copy exacto)

Español rioplatense con voseo. Valores dinámicos indicados fuera de las comillas. Datos de ejemplo: correo «ana.gomez@ejemplo.com».

### 11.1 Login (cambios)
- Enlace de ayuda 1: «¿Olvidaste tu contraseña?»
- Enlace de ayuda 2: «¿No te llegó el correo para confirmar tu cuenta?»
- Alerta de credenciales (401 y 400; **reemplaza** el texto de S05; mismo texto exista o no la cuenta, esté o no bloqueada o sin confirmar): «El correo o la contraseña no son correctos. Si fallaste varias veces seguidas, esperá unos minutos antes de volver a intentar. Si todavía no confirmaste tu correo, puede que tengas que hacerlo antes de entrar.»
- Banner `password-reset`: «Cambiaste tu contraseña. Iniciá sesión con la contraseña nueva.»
- Banner `email-confirmed`: «Confirmaste tu correo. Iniciá sesión para continuar.»
- Resto del login: sin cambios.

### 11.2 Registro recibido (cambios)
- h1: «Registro recibido» (sin cambios)
- Cuerpo (reemplaza): «Iniciá sesión con tu correo y la contraseña que elegiste. Si ya tenías una cuenta con este correo, entrá con la contraseña de siempre.»
- Nota (reemplaza): «Si el correo es nuevo para nosotros, en unos minutos debería llegarte un mensaje con un enlace para confirmarlo. Si no lo ves, revisá la carpeta de correo no deseado o pedí otro desde el inicio de sesión.»
- Botón: «Ir a iniciar sesión» (sin cambios)

### 11.3 Solicitud de recuperación
- h1: «¿Olvidaste tu contraseña?»
- Intro: «Escribí el correo con el que entrás. Si corresponde a una cuenta, te vamos a enviar un enlace para elegir una contraseña nueva.»
- Label: «Correo electrónico»
- Botón: «Enviar enlace» / en carga «Enviando…»
- Pie: «¿Te acordaste?» + enlace «Volver a iniciar sesión»
- Validación: vacío «Ingresá tu correo electrónico.»; formato «Ingresá un correo electrónico válido, por ejemplo nombre@ejemplo.com.»
- Errores: red «No se pudo contactar con el servidor. Revisá tu conexión e intentá de nuevo.»; 5xx «El servidor no pudo recibir el pedido. Intentá de nuevo en unos minutos.»; 403 «No pudimos verificar la solicitud. Recargá la página e intentá de nuevo.»; 429 §11.8; 400 `invalid_email` el `message` del servidor en el campo; otro 400 «No pudimos procesar el pedido con esos datos. Revisá el correo e intentá de nuevo.»

Pedido recibido:
- h1: «Pedido recibido»
- Cuerpo: «Si existe una cuenta con» + correo en negrita (ejemplo «ana.gomez@ejemplo.com») + «, en unos minutos debería llegarte un correo con un enlace para elegir una contraseña nueva.»
- Nota: «Por seguridad, el enlace vence al poco tiempo y sirve una sola vez. Si no lo ves, revisá la carpeta de correo no deseado o volvé a pedirlo.»
- Botones: «Volver a iniciar sesión» (primario) · «Volver a pedir el enlace» (secundario)

### 11.4 Restablecimiento
Estado `ready`:
- h1: «Elegí una contraseña nueva»
- Intro: «Vas a cambiar la contraseña de la cuenta» + correo en negrita + «.»
- Label 1: «Contraseña nueva»; hint: «Usá al menos 12 caracteres. Una frase larga que te resulte fácil de recordar es una buena opción.»
- Label 2: «Repetí la contraseña nueva»
- Botón: «Guardar contraseña nueva» / en carga «Guardando contraseña…»
- Pie: enlace «Volver a iniciar sesión»
- Validación: corta o vacía «La contraseña debe tener al menos 12 caracteres.»; larga «La contraseña no puede superar los 128 caracteres.»; repetir vacía «Repetí la contraseña.»; distinta «Las contraseñas no coinciden.»
- Errores: red «No pudimos confirmar el cambio: no hay conexión con el servidor. Revisá tu conexión e intentá de nuevo.»; 5xx «El servidor no pudo cambiar la contraseña. Intentá de nuevo en unos minutos.»; 403 «No pudimos verificar la solicitud. Intentá de nuevo; si vuelve a pasar, abrí otra vez el enlace desde tu correo.» (no se pide recargar: recargar pierde el enlace); 429 §11.8; 400 `weak_password` el `message` del servidor en «Contraseña nueva».

Estado `success`:
- h1: «Contraseña cambiada»
- Cuerpo: «Listo. Ya podés iniciar sesión con tu contraseña nueva.»
- Nota: «Por seguridad, cerramos las sesiones que tenías abiertas con tu cuenta en otros dispositivos y navegadores. Puede tardar unos minutos en aplicarse en todos.»
- Botón: «Ir a iniciar sesión»

Estado `invalid`:
- h1: «Este enlace ya no es válido»
- Cuerpo: «No pudimos usar este enlace para cambiar la contraseña. Puede que haya vencido, que ya se haya usado o que esté incompleto.»
- Nota: «Pedí un enlace nuevo: cada enlace sirve una sola vez y por poco tiempo.»
- Botones: «Pedir un enlace nuevo» (primario) · enlace «Volver a iniciar sesión»

Estado `missing`:
- h1: «Abrí el enlace desde tu correo»
- Cuerpo: «Esta página funciona con el enlace del correo de recuperación. Si recargaste la página o escribiste la dirección a mano, el enlace ya no está acá: volvé a abrirlo desde el correo o pedí uno nuevo.»
- Botones: «Pedir un enlace nuevo» (primario) · enlace «Volver a iniciar sesión»

### 11.5 Confirmación de correo
Estado `pending`:
- h1: «Confirmando tu correo»
- Texto de estado: «Confirmando tu correo…»
- Con error: red «No pudimos confirmar tu correo: no hay conexión con el servidor. Revisá tu conexión e intentá de nuevo.»; 5xx «El servidor no pudo confirmar tu correo. Intentá de nuevo en unos minutos.»; 403 «No pudimos verificar la solicitud. Intentá de nuevo.»; 429 §11.8
- Aclaración: «Tu enlace sigue sirviendo mientras no venza.»
- Botón: «Reintentar» / en carga «Reintentando…»

Estado `success`:
- h1: «Correo confirmado»
- Cuerpo: «Listo: confirmamos tu correo. Desde ahora lo podés usar para recuperar el acceso a tu cuenta.»
- Botón sin sesión: «Ir a iniciar sesión»; con sesión: «Ir a Mis proyectos»

Estado `invalid`:
- h1: «No pudimos confirmar tu correo»
- Cuerpo: «Puede que el enlace haya vencido, que ya se haya usado o que esté incompleto. Si ya habías confirmado tu correo, no tenés que hacer nada más.»
- Pie: enlace «Volver a iniciar sesión»

Estado `missing`:
- h1: «Confirmá tu correo»
- Cuerpo: «Para confirmar tu correo, abrí el enlace del mensaje que te enviamos al crear la cuenta. Si no lo encontrás o ya venció, pedí otro acá.»
- Pie: enlace «Volver a iniciar sesión»

### 11.6 Reenvío de confirmación (`ResendConfirmationForm`)
- Label: «Correo de tu cuenta»
- Botón: «Enviar otro enlace» / en carga «Enviando…»
- Éxito (202, banner en la región de estado): «Pedido recibido. Si hay una cuenta con ese correo pendiente de confirmar, en unos minutos debería llegarte un enlace nuevo.»
- Validación: vacío «Ingresá tu correo electrónico.»; formato «Ingresá un correo electrónico válido, por ejemplo nombre@ejemplo.com.»
- Errores: red «No se pudo contactar con el servidor. Revisá tu conexión e intentá de nuevo.»; 5xx «El servidor no pudo recibir el pedido. Intentá de nuevo en unos minutos.»; 403 «No pudimos verificar la solicitud. Recargá la página e intentá de nuevo.»; 429 §11.8; 400 `invalid_email` el `message` del servidor en el campo; otro 400 «No pudimos procesar el pedido con esos datos. Revisá el correo e intentá de nuevo.»

### 11.7 «Mi cuenta» → Contraseña
- h2: «Contraseña»
- Intro: «Cambiala cuando quieras. Seguís con la sesión iniciada en este navegador y cerramos las demás.»
- Label 1: «Contraseña actual»; hint: «Si no la recordás, cerrá sesión y usá «¿Olvidaste tu contraseña?» en la pantalla de inicio de sesión.»
- Label 2: «Contraseña nueva»; hint: «Usá al menos 12 caracteres. Una frase larga que te resulte fácil de recordar es una buena opción.»
- Label 3: «Repetí la contraseña nueva»
- Botón: «Cambiar contraseña» / en carga «Cambiando contraseña…»
- Éxito: «Cambiamos tu contraseña. Seguís con la sesión iniciada en este navegador; en tus otros dispositivos la sesión se cierra en unos minutos y vas a tener que entrar con la contraseña nueva.»
- Validación: actual vacía «Ingresá tu contraseña actual.»; nueva corta o vacía «La contraseña debe tener al menos 12 caracteres.»; nueva larga «La contraseña no puede superar los 128 caracteres.»; repetir vacía «Repetí la contraseña.»; distinta «Las contraseñas no coinciden.»
- Errores: 400 `invalid_current_password` en el campo «La contraseña actual no es correcta.»; 400 `weak_password` el `message` del servidor en «Contraseña nueva»; otro 4xx «No pudimos cambiar la contraseña con esos datos. Revisalos e intentá de nuevo.»; red «No pudimos confirmar el cambio: no hay conexión con el servidor. Revisá tu conexión e intentá de nuevo.»; 5xx con código «El servidor no pudo cambiar la contraseña (código 503). Intentá de nuevo en unos minutos.» (número = status real); 5xx sin código «El servidor no pudo cambiar la contraseña. Intentá de nuevo en unos minutos.»; 403 «El servidor rechazó el cambio (código 403). Recargá la página e intentá de nuevo.»; 429 §11.8.

### 11.8 Límite de frecuencia (429)
- Con `Retry-After` legible (segundos o fecha HTTP), redondeado hacia arriba a minutos, mínimo 1: «Hiciste demasiados pedidos seguidos. Probá de nuevo en 1 minuto.» / «Hiciste demasiados pedidos seguidos. Probá de nuevo en 2 minutos.» (el número es el cálculo real; singular solo para 1).
- Sin cabecera o ilegible: «Hiciste demasiados intentos. Esperá unos minutos antes de volver a probar.» (constante existente `RATE_LIMITED_MESSAGE`).

### 11.9 Títulos de documento
«¿Olvidaste tu contraseña? — Vectorify», «Pedido recibido — Vectorify», «Elegí una contraseña nueva — Vectorify», «Contraseña cambiada — Vectorify», «Este enlace ya no es válido — Vectorify», «Abrí el enlace desde tu correo — Vectorify», «Confirmando tu correo — Vectorify», «Correo confirmado — Vectorify», «No pudimos confirmar tu correo — Vectorify», «Confirmá tu correo — Vectorify». «Mi cuenta — Vectorify» sin cambios.

---

## 12. Supuestos

- Rutas nuevas por query string: `?view=forgot-password`, `?view=reset-password`, `?view=confirm-email`.
- El correo enlaza a `PublicBaseUrl` + `/?view=reset-password#email=…&token=…` y `/?view=confirm-email#userId=…&token=…` (o `#email=…&token=…`); el backend genera ese formato con codificación equivalente a `encodeURIComponent`.
- La captura del fragmento vive en un módulo con efecto importado primero en `main.tsx`, y también escucha `hashchange`.
- El token se guarda solo en una variable de módulo de la pestaña; recargar la página lo pierde (estado `missing`, con texto que explica cómo volver).
- El historial global del navegador puede conservar la URL original con el fragmento (antes del `replaceState`); se acepta porque el token es de un solo uso y vence; no hay forma de evitarlo desde la página.
- No se agrega `<meta name="referrer">` global porque rompería la validación de `Origin` del `CsrfGuardMiddleware` en despliegues del mismo origen.
- `ApiClientError` gana un campo con los segundos de `Retry-After` (segundos o fecha HTTP); en cross-origin el backend debe exponer la cabecera con `Access-Control-Expose-Headers: Retry-After`, o la UI usará el texto genérico.
- El backend responde contraseña actual incorrecta en `change-password` como 400 con `code` `invalid_current_password` (no 401), y contraseña débil como 400 `weak_password` con `message` en español (como el registro de S02).
- El backend responde `reset-password` y `confirm-email` con 400 para token inválido, caducado, reusado, malformado, de otra cuenta o cuenta inexistente; la UI trata cualquier 4xx distinto de 403, 429 y `weak_password` como «enlace no válido».
- `resend-confirmation` recibe `{ email }` y responde 202 uniforme.
- `forgot-password` y `resend-confirmation` pueden responder 400 `invalid_email` ante un correo mal formado; la UI lo muestra en el campo.
- Confirmar el correo se hace automáticamente al abrir el enlace (sin botón), una sola petición por token.
- La pantalla de confirmación sin fragmento sirve también como pantalla de reenvío, enlazada desde el login.
- Las pantallas de restablecimiento y confirmación se muestran también con sesión iniciada; la de solicitud redirige como el login.
- Tras un restablecimiento correcto, si el navegador tenía sesión se cierra localmente con el `logout` existente, sin banner de sesión terminada.
- En modo Development las tres vistas nuevas redirigen al destino y la sección «Contraseña» no existe.
- El texto de la alerta de credenciales del login y el de «Registro recibido» cambian respecto de S05 (los tests existentes se actualizan) para cubrir la confirmación obligatoria sin revelarla ni depender de la configuración.
- La UI no conoce el valor de `Auth:RequireConfirmedEmail`; todo el copy es válido con `true` y con `false`.
- Los textos no mencionan la duración exacta de los enlaces (es configurable): dicen «vence al poco tiempo».
- El correo escrito pasa entre login, solicitud y restablecimiento solo en memoria (`prefillEmail`), nunca por URL.
- Los formularios de contraseña incluyen un campo oculto `username` con el correo para los gestores de contraseñas.
- No hay validación cliente de «la contraseña nueva es igual a la actual»: decide el servidor.
- No se muestra en «Mi cuenta» si el correo está confirmado ni se ofrece reenvío desde allí.
- La sección «Contraseña» va después de «Cuenta de acceso».
- La lista de ayuda del login va después del botón «Iniciar sesión», no entre la contraseña y el botón.
- Todo el copy nuevo es propuesta propia en el tono de S05/S07.

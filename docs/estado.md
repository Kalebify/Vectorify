# Estado del proyecto — 2026-10-20

## Qué hemos hecho

- **MVP 3 (S01–S16)**: mergeado en `main` (PRs #44–#63). Resumen y bugs conocidos en `docs/MVP3_RELEASE.md`.
- **MVP 3.1 (Auth)**: S01 mergeada (#64, ADR + PoC). La migración a **.NET 10** está en el PR #65 (abierto). S02–S09 implementadas, **en Test en Notion**, en ramas apiladas (cada una sobre la anterior, subidas a origin, sin PR ni merge):

| Tarjeta | Rama (`sprint/3e8d77b2-…`) | Commit |
|---|---|---|
| S02 Registro + User | `m31-s02-registro-user` | `80ef41d` (+`49cbe73` PoC) |
| S03 Login/logout | `m31-s03-login-logout` | `7366220` |
| S04 Sesiones | `m31-s04-sesiones` | `3d7e4e2` |
| S05 React Auth | `m31-s05-react-auth` | `6c011ed` |
| S06 Autorización | `m31-s06-autorizacion` | `a3ed9f1` |
| S07 Perfil | `m31-s07-perfil` | `8ca70af` |
| S08 Recuperación | `m31-s08-recuperacion` | `51c3ed7` |
| S09 Hardening | `m31-s09-hardening` | `df542f1` |

- Última verificación (re-ejecutada por mí en S09): backend **2218/2218**, frontend **3732/3732**, `npm run build` y `npm audit` limpios.
- **S10 (E2E + release gate)**: implementada y verificada (`docs/MVP31_RELEASE.md`): E2E HTTP 11/11, navegador 12/12, imagen real, herramienta de reasignación de datos legados. Backend **2224/2224**, frontend **3732/3732**, build OK. **Veredicto: NO LISTO PARA RELEASE** (H-1).

## Decisiones tomadas

- ASP.NET Core Identity + cookie; residencia UE obligatoria; sin MFA ni login social.
- 404 uniforme para recurso ajeno o inexistente; denegar por defecto (`FallbackPolicy`); datos sin dueño inaccesibles en modo Authenticated.
- Tokens nativos de Identity; en los enlaces del correo el token va en el fragmento de la URL; verificación de correo implementada pero **no obligatoria**.
- Email de solo lectura en el perfil; **no** se implementó supresión ni exportación de cuenta.
- La imagen del backend arranca por defecto en Production + Authenticated; el compose de desarrollo pide el modo desarrollo explícito y publica solo en `127.0.0.1`.
- ImageSharp **no** se actualiza a 4.x (cambio de licencia); queda como bloqueante abierto en el gate (decisión tuya).

## Problemas abiertos

- **H-1 · High · `SixLabors.ImageSharp` 2.1.13**: bloquea el release. Mitigado (solo PNG/JPEG/WEBP, tope de 64 Mpx), no corregido. Opciones en `docs/AUTH_SECURITY_REVIEW.md` §9.
- **M3-S16 sigue Bloqueado en Notion**: LightBurn pierde las capas al importar el DXF (todas en ACI 7). Hay otra sesión corrigiéndolo; aún no ha informado.
- Decisiones humanas pendientes: proveedor de correo de la UE (P5), verificación de correo obligatoria (P9), destino de datos legados y del usuario de desarrollo (P10), supresión/exportación de cuenta (P11), dominio y certificado TLS.
- `.env.example` no se puede editar (regla de denegación): hay variables nuevas por añadir a mano (listadas en los IMPL de S02, S04, S08, S09).
- Sin verificar: TLS/HSTS reales, proxy real, correo real, navegadores distintos de Chromium, axe/Lighthouse. Tests sensibles al tiempo (ManufacturingOperations, EditorShell.history, Login/Register) fallan a veces bajo carga y pasan aislados.
- Sin relación con esto y sin commitear: `ESPECIFICACION_BOT_MT5_DEMO.md` y `mql5/`.

## Siguiente paso

1. S10 ya está en Test en Notion (commit `e71b772`, subida). Decidir H-12 (`vite` 8.3.1, solo desarrollo; `npm audit fix` y repetir tests/build).
2. Tú: decidir lo de ImageSharp y revisar/mergear la cadena de PRs en orden (#65 → S02 → … → S10).
3. Después: seguimiento del DXF de M3-S16 y retirar el PoC `backend/spikes/AuthPoc` (el ADR lo preveía tras S10).

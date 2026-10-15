# M3.1-S01 · Arquitectura Identity/Auth + spike de proveedor
URL: https://app.notion.com/p/3e8d77b26398817cbda7d2ce0ab746b4
Stack declarado (propiedad Área): ASP.NET Core, Frontend, Infra. Entregable principal: **documento de decisión (ADR) + PoC** (sin cambios en el comportamiento del producto).

> Lee primero `.sprint/3e8d77b2-6398-817c-bda7-d2ce0ab746b4/research.md` (investigación del orquestador, con nivel de evidencia por dato), `docs/ADR_EDITOR_MVP3.md` (formato de ADR del repo),
> `docs/ARQUITECTURA_PERSISTENCIA.md`, `backend/Vectorify.Api/Users/*` (IUserContext, DevelopmentUserContext, UserContextRegistration), `backend/Vectorify.Api/Data/User.cs`, `Project.cs` y el
> `VectorizationDbContext`, `ProjectManagement/ProjectService.cs`, `Projects/Persistence/ProjectRepository.cs`, `Endpoints/ProjectV2Endpoints.cs`, los tests `EndToEnd/UserOwnershipEndpointsTests.cs` y
> `TestSupport/OwnershipTestFixture.cs`, y `Program.cs` (CORS, registro de IUserContext). El precedente de spike del repo es `frontend/spike-editor-engine/`.

## Requerimiento (transcripción del cuerpo de la tarjeta)
Objetivo: Definir la arquitectura de identidad y elegir con evidencia entre proveedor gestionado y autenticación propia, manteniendo desacoplado el dominio.
Criterio de aceptación: Existe ADR con requisitos, threat model básico, comparación de opciones y PoC; IUserContext de MVP 2.2 puede alimentarse desde identidad autenticada sin cambiar Project.

**Contexto.** Antes de implementar registro/login, decidir cómo resolver Identity. No construir passwords/tokens por costumbre.
**Evaluar.** Proveedor gestionado vs ASP.NET Core Identity/self-hosted u opciones vigentes al momento de ejecutar el sprint. Comparar coste, OAuth, email/password, MFA futuro, session management, SDK React/.NET, exportabilidad, lock-in, GDPR/UE y complejidad operativa.
**PoC.** Login mínimo → identidad llega a ASP.NET → AuthenticatedUserContext → User local → GET /projects filtra por OwnerId.
**Arquitectura.** El proveedor autentica identidad; VECTORiZE mantiene su User de dominio. Mapear Provider/Subject a User.Id interno.
**Seguridad.** Definir cookie segura vs token según arquitectura; CSRF/XSS implications; secretos; HTTPS; expiración.
**Entregable.** ADR + diagrama + decisión + variables/config necesarias.
**DoD.** S02–S10 implementan una decisión explícita, no una mezcla improvisada de estrategias.

## Criterios de aceptación
1. `docs/ADR_AUTH_MVP31.md` con: requisitos (funcionales, de seguridad, operativos), alcance y no-objetivos, **threat model básico** (activos, actores, superficie, amenazas y mitigaciones concretas: robo/fijación de sesión, CSRF, XSS, enumeración de cuentas, fuerza bruta, tokens en el cliente, CORS con credenciales, secretos, downgrade HTTP, IDOR entre usuarios), **comparación de opciones** en todos los ejes de la tarjeta, **diagrama** (Mermaid), **decisión recomendada** con su justificación y los datos que la sostienen, **variables/config necesarias**, y el **impacto concreto en S02–S10**, una por una.
2. **PoC ejecutable** que demuestra la cadena: identidad autenticada → `AuthenticatedUserContext` → `User` local (mapeo Provider+Subject → `User.Id`, idempotente) → `GET /api/v2/projects` filtra por `OwnerId`; sin identidad ⇒ 401; **`Project` y los servicios del dominio no se modifican**.
3. La decisión queda **explícita y con estado**: "Recomendada — pendiente de confirmación de la persona dueña del producto", con la lista de preguntas abiertas (presupuesto, MAU, residencia UE, dependencia de terceros, email, social/MFA). No se inventan respuestas.
4. La evidencia dice de dónde sale cada dato (oficial verificado / secundario / no verificado) y la fecha; los precios llevan "verificar antes de contratar".

## Referencias visuales / de marca
No aplica.

## Umbrales de calidad
`dotnet build` 0 errores, `dotnet test` (Docker disponible) verde sin regresiones, `npm test` y `npm run build` sin cambios de resultado. El PoC no debe entrar al build del producto ni a la imagen Docker.

## Decisiones del orquestador
1. **Enfoque del PoC = frontera agnóstica del proveedor.** El dominio solo ve un `ClaimsPrincipal`; el PoC demuestra esa frontera con **dos fuentes de identidad intercambiables detrás del mismo `AuthenticatedUserContext`**: (A) un **emisor OIDC simulado** (JWT firmado con una clave de prueba, validado con `AddJwtBearer`/OIDC discovery simulado) como *stand-in* de cualquier proveedor gestionado (Auth0/Entra/Clerk/Keycloak), y (B) **ASP.NET Core Identity con cookie** (autoalojado). Un PoC contra un proveedor real exige crear cuentas/tenants externos y claves, algo que no se puede hacer aquí: queda explícitamente **fuera del PoC y como pregunta/tarea humana** si se elige un proveedor.
2. **Aislamiento**: el PoC vive en `backend/spikes/AuthPoc/` (proyecto propio + tests, **no** añadido a `Vectorify.sln` ni a la imagen Docker; README con cómo correrlo). Puede referenciar `Vectorify.Api` (IUserContext, `Data.User`, servicios) para probar que el dominio no cambia. Los paquetes nuevos (Identity EF, JwtBearer, etc.) solo entran en el proyecto del spike. La tabla de vínculo `(provider, subject) → user_id` del PoC es del spike (no se toca el `VectorizationDbContext` del producto); el ADR propone el modelo definitivo (`UserIdentity` con índice único `(Provider, Subject)`, `Users.Id` intacto) para S02.
3. **El ADR no es neutral: recomienda.** Con la evidencia y el contexto del proyecto (docker compose, Postgres propio, sin cuentas externas hoy, un solo equipo), debe llegar a una recomendación razonada y dejar claro bajo qué respuestas de la persona dueña cambiaría (p. ej. "si hace falta MFA/social desde el día 1 o no se quiere operar el email ⇒ proveedor gestionado X"). Evaluar al menos: ASP.NET Core Identity (cookie), OpenIddict/Keycloak (servidor OIDC propio), Auth0, Entra External ID, Clerk (y mencionar Cognito). Incluir **coste a 1 k / 25 k / 100 k MAU** con las cifras verificadas y marcar las que no.
4. **.NET 9 sale de soporte el 2026-11-10** (research.md): el ADR debe recomendar la migración a .NET 10 LTS (alcance, riesgos, orden: antes de S02) y lo repercute en el plan.
5. **Cookie vs token** debe resolverse con argumentos del proyecto: SPA React servida por nginx + API en otro origen del mismo *site* en desarrollo; analizar el caso de despliegue con dominios distintos; patrón BFF; SameSite/CORS credentials/CSRF (antiforgery o cabecera personalizada); almacenamiento de tokens en el navegador; expiración y renovación (referencia a S04).
6. **Sin features de producto** en esta tarjeta: no se registra `AuthenticatedUserContext` en `UserContextRegistration` del producto ni se tocan endpoints reales; eso es S02–S06. Se permite *proponer* en el ADR los cambios exactos (con firma de clases y migración) para esas tarjetas.
7. **Seguridad del propio PoC**: sin secretos reales; claves de prueba generadas en los tests; nada de contraseñas fijas en archivos versionados (generarlas en el test).

## Tests exigidos (del PoC)
- Con la fuente (A) y con la fuente (B): usuario nuevo ⇒ se crea el `User` local una sola vez (repetir el callback/solicitud no duplica); dos usuarios distintos ven **solo sus proyectos** en `GET /api/v2/projects` (IDs conocidos del otro ⇒ 404); sin credencial ⇒ 401; token expirado / firma inválida / emisor o audiencia incorrectos ⇒ 401; cookie manipulada ⇒ 401.
- Prueba de que `Project`, `ProjectService`, `ProjectRepository` y `VectorDocumentService` **no cambiaron** (el PoC compila contra ellos sin modificar su código; verificarlo con `git diff` vacío sobre esos archivos).
- Documentar cómo correr el PoC y su resultado real en el IMPL.

## DoD
S02–S10 pueden implementarse sin ambigüedad sobre la estrategia; la persona dueña del producto tiene un resumen de una página con la recomendación, lo que cuesta y lo que tiene que decidir.

## Ambigüedades detectadas
- La tarjeta pide "elegir": la elección depende de presupuesto, MAU esperados, residencia de datos y apetito de operar email/seguridad, que **no están declarados**. El ADR recomienda y marca la decisión como pendiente de confirmación.
- "Opciones vigentes al momento": la investigación del orquestador (research.md) es la base; el implementador no tiene acceso web, así que toda cifra nueva debe marcarse "no verificada".
- Fuera de alcance: implementar registro/login/UI (S02–S05), autorización de recursos (S06), perfil (S07), recuperación (S08), hardening (S09), E2E (S10); contratar o configurar un proveedor real.

# IMPL-fix-round-2.md — M2.1-S07 · Carga infinita en Vite dev (React StrictMode) + suite inestable

## Bug reportado por QA

"En la prueba E2E con la versión actual en Vite dev (:5174) y la API actual (:5081), tras
confirmar una paleta y generar 5 capas, el Workspace queda indefinidamente en «Cargando el
documento del proyecto…», sin mostrar canvas ni controles de capas, aunque las respuestas API
son 200. En producción el flujo sí carga... Además, `npm test` con paralelismo predeterminado
falló de forma intermitente (1–2 pruebas); con `--maxWorkers=2` pasan 307/307."

## Causa raíz confirmada (carga infinita)

`frontend/src/main.tsx` envuelve la app en `<StrictMode>`. React 18/19, SOLO en desarrollo,
invoca cada efecto DOS VECES de forma sincrónica al montar (mount → cleanup → mount otra vez),
específicamente para exponer efectos que no son idempotentes. `useVectorDocument.ts` tenía dos
efectos relevantes:

1. `useEffect(() => { return () => abortControllerRef.current?.abort(); }, [])`
2. `useEffect(() => { if (requestedForRef.current === key) return; requestedForRef.current =
   key; load(); }, [projectId, imageId, paletteId, savedProjectId])`

Bajo StrictMode, la secuencia real en un solo commit era: (1) ambos efectos corren una vez
(`load()` arranca el fetch, `status` pasa a "loading"); (2) StrictMode simula un unmount —
corre las limpiezas, y la del efecto 1 aborta el `AbortController` que el `load()` de recién
acababa de crear; (3) StrictMode simula un remount — ambos efectos corren de nuevo, pero el
efecto 2 encuentra `requestedForRef.current === key` (ya seteado en el paso 1) y **nunca vuelve
a llamar a `load()`**. El único fetch que llegó a arrancar quedó abortado para siempre, y nada
lo reintentaba — `status` se quedaba en `"loading"` indefinidamente. En producción, `StrictMode`
no duplica efectos, así que el bug nunca se manifestaba ahí — coincide exactamente con lo
reportado.

## Fix

Se elimina el guard `requestedForRef` por completo. `load()` ya es seguro de llamar más de una
vez (cancela su propio fetch anterior vía `abortControllerRef` antes de arrancar uno nuevo), así
que el guard era puramente defensivo y nunca necesario para la lógica real — su único efecto
observable era romper el remount simulado de StrictMode. Sin el guard, la segunda invocación de
StrictMode simplemente vuelve a llamar a `load()` con un `AbortController` fresco, que esta vez
sí completa sin que nada lo cancele.

## Validación del diagnóstico (importante: el primer intento de test fue un falso positivo)

El primer test que escribí (mock de `fetch` que resuelve con `Promise.resolve()`, sin mirar
`init.signal`) pasó tanto CON el bug como SIN el fix -- no reproducía nada, porque el
doble-invoke sincrónico de StrictMode corre antes de que cualquier microtask (incluida la
resolución de una promesa ya resuelta) tenga chance de correr, así que la carrera real nunca se
manifestaba con ese mock. Se reescribió como `stubAbortAwareFetchSequence`: resuelve en un
macrotask (`setTimeout`) y rechaza con un `AbortError` real si el signal se aborta antes —
mismo comportamiento que un `fetch` real contra la red. Con ESTE mock: el test falla
(`"loading"` para siempre, timeout) revirtiendo el fix, y pasa con él aplicado — confirmado
manualmente revirtiendo el cambio y volviendo a correr el test antes de restaurarlo.

## Fix de estabilidad de la suite (`vitest.config.ts`)

El tope de `maxWorkers` ya existente (8, agregado en una revisión anterior) no alcanzaba según
el reporte de QA -- se baja a 2, el valor que QA confirmó empíricamente como estable (307/307).
Confirmado con 2 corridas completas de la suite en esta revisión: la primera 332/332, la
segunda 331/332 con 1 falla aislada en `EditorShell.test.tsx` (test de resize/zoom sensible a
timing, NO tocado por este fix, confirmado pasando 9/9 en aislamiento) -- misma categoría de
flake por contención de CPU ya documentada repetidas veces en este sprint (nunca una regresión
real). El tope de 2 reduce significativamente la frecuencia pero, como con cualquier test
sensible a timing bajo carga de CPU variable, no puede garantizar cero flakes para siempre.

## Verificación (confirmada de forma independiente por el orquestador)

- `npm run build` → limpio, 0 errores de TypeScript.
- `npm test` (sin flags, usa el `maxWorkers: 2` ya configurado) → 332/332 en la primera corrida,
  331/332 en la segunda (1 flake aislado confirmado no relacionado, pasa en aislamiento).
- `dotnet build`/`dotnet test`/`pytest` → sin tocar (diff puramente frontend, confirmado por
  `git diff --stat`).

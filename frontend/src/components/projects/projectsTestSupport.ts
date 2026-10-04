import { vi } from "vitest";
import type { ProjectDetail, ProjectSummary } from "../../types/projectsV2";

/**
 * Soporte de tests de Mis Proyectos (M2.2-S08): un backend v2 de juguete en memoria detrás de
 * `fetch`. Respeta el `AbortSignal` (rechaza con AbortError si se aborta, igual que el fetch real)
 * para que las condiciones de carrera de la pantalla (búsqueda rápida, cambio de página) se
 * ejerciten de verdad.
 */

export interface RecordedCall {
  method: string;
  path: string;
  search: URLSearchParams;
  body: unknown;
}

export type RequestOverride = (call: RecordedCall) => Response | Promise<Response> | undefined;

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export function makeProject(index: number, overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  const n = String(index).padStart(2, "0");
  return {
    id: `00000000-0000-0000-0000-0000000000${n}`,
    name: `Proyecto ${n}`,
    thumbnailAssetId: null,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    layerCount: 3,
    thumbnailUrl: null,
    classicProjectId: `10000000-0000-0000-0000-0000000000${n}`,
    classicImageId: `20000000-0000-0000-0000-0000000000${n}`,
    classicPaletteId: `30000000-0000-0000-0000-0000000000${n}`,
    ...overrides,
  };
}

function toDetail(project: ProjectSummary): ProjectDetail {
  return {
    id: project.id,
    ownerId: "99999999-9999-9999-9999-999999999999",
    name: project.name,
    description: null,
    thumbnailAssetId: project.thumbnailAssetId,
    currentVersionId: null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    classicProjectId: project.classicProjectId,
    classicImageId: project.classicImageId,
    classicPaletteId: project.classicPaletteId,
  };
}

function abortable(signal: AbortSignal | null | undefined, produce: () => Response | Promise<Response>) {
  return new Promise<Response>((resolve, reject) => {
    const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    Promise.resolve(produce()).then(resolve, reject);
  });
}

export function installProjectsApi(initial: ProjectSummary[], override?: RequestOverride) {
  const state = { projects: [...initial] };
  const calls: RecordedCall[] = [];

  const handler = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const call: RecordedCall = {
      method,
      path: url.pathname,
      search: url.searchParams,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    };
    calls.push(call);

    return abortable(init?.signal, () => {
      const overridden = override?.(call);
      if (overridden) return overridden;

      if (method === "GET" && call.path === "/api/v2/projects") {
        const search = (call.search.get("search") ?? "").toLowerCase();
        const sortBy = call.search.get("sortBy") ?? "LastModified";
        const page = Number(call.search.get("page") ?? "1");
        const pageSize = Number(call.search.get("pageSize") ?? "20");

        const filtered = state.projects.filter((project) => project.name.toLowerCase().includes(search));
        const sorted = [...filtered].sort((a, b) =>
          sortBy === "Name"
            ? a.name.localeCompare(b.name)
            : sortBy === "Created"
              ? b.createdAt.localeCompare(a.createdAt)
              : b.updatedAt.localeCompare(a.updatedAt),
        );

        return jsonResponse({
          items: sorted.slice((page - 1) * pageSize, page * pageSize),
          page,
          pageSize,
          totalCount: filtered.length,
        });
      }

      const idMatch = /^\/api\/v2\/projects\/([^/]+)(\/duplicate)?$/.exec(call.path);
      const target = idMatch ? state.projects.find((project) => project.id === idMatch[1]) : undefined;
      if (!idMatch || !target) {
        return jsonResponse({ code: "not_found", message: "No existe un proyecto con ese Id." }, 404);
      }

      if (method === "PATCH") {
        target.name = (call.body as { name: string }).name;
        target.updatedAt = new Date().toISOString();
        return jsonResponse(toDetail(target));
      }

      if (method === "POST" && idMatch[2]) {
        const copy = makeProject(state.projects.length + 100, {
          name: `Copia de ${target.name}`,
          updatedAt: new Date().toISOString(),
        });
        state.projects.push(copy);
        return jsonResponse(toDetail(copy), 201);
      }

      if (method === "DELETE") {
        state.projects = state.projects.filter((project) => project.id !== target.id);
        return new Response(null, { status: 204 });
      }

      return jsonResponse({ code: "not_found", message: "Ruta no soportada por el stub." }, 404);
    });
  };

  const fetchMock = vi.fn(handler);
  vi.stubGlobal("fetch", fetchMock);

  return {
    state,
    calls,
    fetchMock,
    listCalls: () => calls.filter((call) => call.method === "GET" && call.path === "/api/v2/projects"),
    callsOf: (method: string) => calls.filter((call) => call.method === method),
  };
}

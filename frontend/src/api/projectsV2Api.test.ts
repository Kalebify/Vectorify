import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClientError, API_BASE_URL } from "./httpClient";
import { deleteProject, duplicateProject, getProject, listProjects, renameProject, resolveThumbnailUrl } from "./projectsV2Api";

function stubFetch(response: Response | (() => Response)) {
  const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(typeof response === "function" ? response() : response),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("projectsV2Api", () => {
  it("listProjects arma la query string solo con los parámetros presentes", async () => {
    const fetchMock = stubFetch(json({ items: [], page: 2, pageSize: 12, totalCount: 0 }));

    await listProjects({ page: 2, pageSize: 12, search: "lla vero", sortBy: "Name" });

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe("/api/v2/projects");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("pageSize")).toBe("12");
    expect(url.searchParams.get("search")).toBe("lla vero");
    expect(url.searchParams.get("sortBy")).toBe("Name");
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET");
  });

  it("listProjects sin parámetros no agrega query string, y omite search vacío", async () => {
    const fetchMock = stubFetch(() => json({ items: [], page: 1, pageSize: 20, totalCount: 0 }));

    await listProjects();
    await listProjects({ search: "" });

    expect(String(fetchMock.mock.calls[0][0])).toBe(`${API_BASE_URL}/api/v2/projects`);
    expect(String(fetchMock.mock.calls[1][0])).toBe(`${API_BASE_URL}/api/v2/projects`);
  });

  it("listProjects respeta el AbortSignal", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = listProjects({ signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "ApiClientError", isAborted: true });
  });

  it("getProject pide el detalle por id", async () => {
    const fetchMock = stubFetch(json({ id: "abc" }));

    await getProject("abc");

    expect(String(fetchMock.mock.calls[0][0])).toBe(`${API_BASE_URL}/api/v2/projects/abc`);
  });

  it("renameProject hace PATCH con solo { name }", async () => {
    const fetchMock = stubFetch(json({ id: "abc", name: "Nuevo" }));

    await renameProject("abc", "Nuevo");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${API_BASE_URL}/api/v2/projects/abc`);
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ name: "Nuevo" });
  });

  it("duplicateProject hace POST a /duplicate", async () => {
    const fetchMock = stubFetch(json({ id: "copy" }, 201));

    const copy = await duplicateProject("abc");

    expect(copy).toEqual({ id: "copy" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${API_BASE_URL}/api/v2/projects/abc/duplicate`);
    expect(init?.method).toBe("POST");
  });

  it("deleteProject hace DELETE y tolera el 204 sin cuerpo", async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 204 }));

    await expect(deleteProject("abc")).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${API_BASE_URL}/api/v2/projects/abc`);
    expect(init?.method).toBe("DELETE");
  });

  it("un 4xx expone el status HTTP y el cuerpo de error en ApiClientError", async () => {
    stubFetch(json({ code: "concurrency_conflict", message: "Conflicto." }, 409));

    const error = await renameProject("abc", "x").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiClientError);
    expect((error as ApiClientError).status).toBe(409);
    expect((error as ApiClientError).body).toEqual({ code: "concurrency_conflict", message: "Conflicto." });
    expect((error as ApiClientError).isNetworkError).toBe(false);
  });

  it("un fallo de red es un ApiClientError sin status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    const error = await listProjects().catch((caught: unknown) => caught);

    expect((error as ApiClientError).isNetworkError).toBe(true);
    expect((error as ApiClientError).status).toBeUndefined();
  });
});

describe("resolveThumbnailUrl", () => {
  it("prefija la ruta relativa con el origen de la API", () => {
    expect(resolveThumbnailUrl("/api/v2/projects/a/assets/b")).toBe(`${API_BASE_URL}/api/v2/projects/a/assets/b`);
  });

  it("deja intacta una URL absoluta", () => {
    expect(resolveThumbnailUrl("https://cdn.example.com/t.png")).toBe("https://cdn.example.com/t.png");
  });

  it("devuelve null cuando no hay thumbnail", () => {
    expect(resolveThumbnailUrl(null)).toBeNull();
  });
});

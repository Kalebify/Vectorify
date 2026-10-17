import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { httpClient } from "../api/httpClient";
import { rearmSessionBoundary, resetSessionBoundaryForTests } from "../api/sessionBoundary";
import { AccountLayout } from "./AccountLayout";
import { AuthBoundary } from "./AuthBoundary";
import { AuthProvider } from "./AuthProvider";
import { useAuth } from "./authContext";
import {
  ANA,
  DEV_USER,
  GOOD_PASSWORD,
  deferred,
  installAuthBackend,
  resetBrowserState,
} from "./authTestSupport";
import { jsonResponse } from "../components/projects/projectsTestSupport";

/** M3.1-S05: estados del AuthProvider (unknown / authenticated / unauthenticated / error) y su integración con S04. */

function Probe() {
  const auth = useAuth();
  return (
    <div>
      <p data-testid="status">{auth.state.status}</p>
      <p data-testid="user">{auth.user?.email ?? "-"}</p>
      <p data-testid="dev">{String(auth.isDevelopmentMode)}</p>
      <p data-testid="notice">{auth.notice ?? "-"}</p>
      <p data-testid="return-url">
        {auth.state.status === "unauthenticated" ? (auth.state.returnUrl ?? "null") : "-"}
      </p>
      <p data-testid="failure">
        {auth.state.status === "error" ? `${auth.state.failure.kind}:${auth.state.failure.httpStatus ?? ""}` : "-"}
      </p>
      <button type="button" onClick={() => void auth.signIn({ email: ANA.email!, password: GOOD_PASSWORD }).catch(() => undefined)}>
        entrar
      </button>
      <button type="button" onClick={() => void auth.signOut().catch(() => undefined)}>
        salir
      </button>
      <button type="button" onClick={auth.retry}>
        reintentar
      </button>
    </div>
  );
}

const status = () => screen.getByTestId("status").textContent;

beforeEach(() => {
  resetSessionBoundaryForTests();
  resetBrowserState("/");
});

afterEach(() => {
  resetSessionBoundaryForTests();
  resetBrowserState("/");
});

describe("AuthProvider — estados", () => {
  it("unknown mientras /me está pendiente y luego authenticated con el usuario", async () => {
    const gate = deferred();
    installAuthBackend({ gates: { me: gate.promise } });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    expect(status()).toBe("unknown");
    expect(screen.getByTestId("user")).toHaveTextContent("-");

    await act(async () => {
      gate.resolve();
    });

    await waitFor(() => expect(status()).toBe("authenticated"));
    expect(screen.getByTestId("user")).toHaveTextContent(ANA.email!);
    expect(screen.getByTestId("dev")).toHaveTextContent("false");
  });

  it("401 en /me => unauthenticated (sin aviso) con el returnUrl de la ubicación actual", async () => {
    window.history.pushState({}, "", "/?view=new");
    installAuthBackend({ user: null });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(status()).toBe("unauthenticated"));
    expect(screen.getByTestId("return-url")).toHaveTextContent("/?view=new");
    expect(screen.getByTestId("notice")).toHaveTextContent("-");
  });

  it("modo Development: authenticated con isDevelopmentMode=true", async () => {
    installAuthBackend({ user: DEV_USER });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(status()).toBe("authenticated"));
    expect(screen.getByTestId("dev")).toHaveTextContent("true");
  });

  it("un servidor anterior sin authMode se interpreta como Authenticated", async () => {
    installAuthBackend({ user: { ...ANA, authMode: undefined as never } });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(status()).toBe("authenticated"));
    expect(screen.getByTestId("dev")).toHaveTextContent("false");
  });

  it.each([
    ["red caída", "network" as const, "network:"],
    ["503", 503 as const, "server:503"],
    ["500", 500 as const, "server:500"],
    ["403 (CSRF/Origin): no es sesión cerrada", 403 as const, "server:403"],
  ])("%s en /me => error (NUNCA unauthenticated)", async (_label, me, expected) => {
    installAuthBackend({ me });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(status()).toBe("error"));
    expect(screen.getByTestId("failure")).toHaveTextContent(expected);
    expect(screen.getByTestId("return-url")).toHaveTextContent("-");
  });

  it("un 200 con cuerpo ilegible (p. ej. HTML de un proxy) es error de servidor, no sesión cerrada", async () => {
    const api = installAuthBackend();
    api.fetchMock.mockImplementation(() => Promise.resolve(new Response("<html>bad gateway</html>", { status: 200 })));
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(status()).toBe("error"));
  });

  it("retry: de error pasa a authenticated; reintentos concurrentes se ignoran", async () => {
    const api = installAuthBackend({ me: "network" });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(status()).toBe("error"));

    api.session.me = "session";
    fireEvent.click(screen.getByText("reintentar"));
    fireEvent.click(screen.getByText("reintentar"));

    await waitFor(() => expect(status()).toBe("authenticated"));
    expect(api.authCallsTo("GET", "/api/v1/auth/me")).toHaveLength(2);
  });

  it("signIn pasa a authenticated y borra el aviso; signOut a unauthenticated con aviso signed-out y sin returnUrl", async () => {
    installAuthBackend({ user: null });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(status()).toBe("unauthenticated"));

    fireEvent.click(screen.getByText("entrar"));
    await waitFor(() => expect(status()).toBe("authenticated"));

    fireEvent.click(screen.getByText("salir"));
    await waitFor(() => expect(status()).toBe("unauthenticated"));
    expect(screen.getByTestId("notice")).toHaveTextContent("signed-out");
    expect(screen.getByTestId("return-url")).toHaveTextContent("null");
  });
});

describe("AuthProvider — evento de sesión expirada (S04)", () => {
  it("con sesión activa, un 401 de un endpoint de producto => unauthenticated + aviso expired", async () => {
    window.history.pushState({}, "", "/?view=new");
    const api = installAuthBackend();
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(status()).toBe("authenticated"));

    api.session.user = null;
    await act(async () => {
      await httpClient.get("/api/v2/projects").catch(() => undefined);
    });

    await waitFor(() => expect(status()).toBe("unauthenticated"));
    expect(screen.getByTestId("notice")).toHaveTextContent("expired");
    expect(screen.getByTestId("return-url")).toHaveTextContent("/?view=new");
  });

  it("un 401 de un endpoint de AUTH (credenciales inválidas) no es una sesión expirada", async () => {
    installAuthBackend({ login: () => jsonResponse({ code: "invalid_credentials", message: "x" }, 401) });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(status()).toBe("authenticated"));

    await act(async () => {
      await httpClient.postJson("/api/v1/auth/login", {}).catch(() => undefined);
    });

    expect(status()).toBe("authenticated");
    expect(screen.getByTestId("notice")).toHaveTextContent("-");
  });

  it("un 403 de un endpoint de producto NO cierra la sesión", async () => {
    const api = installAuthBackend({ projectsStatus: 403 });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(status()).toBe("authenticated"));

    await act(async () => {
      await httpClient.get("/api/v2/projects").catch(() => undefined);
    });

    expect(status()).toBe("authenticated");
    expect(api.session.user).not.toBeNull();
  });

  it("sin sesión resuelta (unknown / unauthenticated) el evento no hace nada", async () => {
    const gate = deferred();
    installAuthBackend({ user: null, gates: { me: gate.promise } });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    expect(status()).toBe("unknown");

    await act(async () => {
      await httpClient.get("/api/v2/projects").catch(() => undefined);
    });
    expect(status()).toBe("unknown");

    await act(async () => {
      gate.resolve();
    });
    await waitFor(() => expect(status()).toBe("unauthenticated"));
    expect(screen.getByTestId("notice")).toHaveTextContent("-");
  });

  it("el proveedor se da de baja al desmontarse (no queda suscripción colgada)", async () => {
    const api = installAuthBackend();
    const view = render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(status()).toBe("authenticated"));
    view.unmount();
    rearmSessionBoundary();
    api.session.user = null;

    // Sin suscriptores, el 401 no consume el aviso: se puede suscribir otro y recibirlo.
    let received = 0;
    const { onSessionExpired } = await import("../api/sessionBoundary");
    const off = onSessionExpired(() => {
      received += 1;
    });
    await httpClient.get("/api/v2/projects").catch(() => undefined);
    off();

    expect(received).toBe(1);
  });
});

describe("AuthBoundary / AccountLayout — rutas protegidas", () => {
  it("no monta los hijos hasta que la sesión está resuelta y redirige al login con returnUrl si no hay sesión", async () => {
    window.history.pushState({}, "", "/?view=new");
    const gate = deferred();
    installAuthBackend({ user: null, gates: { me: gate.promise } });
    render(
      <AuthProvider>
        <AuthBoundary>
          <p>contenido privado</p>
        </AuthBoundary>
      </AuthProvider>,
    );

    expect(screen.queryByText("contenido privado")).not.toBeInTheDocument();
    await act(async () => {
      gate.resolve();
    });

    await waitFor(() => expect(window.location.search).toBe(`?view=login&returnUrl=${encodeURIComponent("/?view=new")}`));
    expect(screen.queryByText("contenido privado")).not.toBeInTheDocument();
  });

  it("AccountLayout (contenedor para futuras páginas de cuenta): header con marca y menú, main con enlace de vuelta, un único h1 y el contenido", async () => {
    installAuthBackend();
    render(
      <AuthProvider>
        <AuthBoundary>
          <AccountLayout title="Tu cuenta">
            <p>Acá vas a poder ver y editar los datos de tu cuenta.</p>
          </AccountLayout>
        </AuthBoundary>
      </AuthProvider>,
    );

    expect(await screen.findByRole("heading", { level: 1, name: "Tu cuenta" })).toHaveAttribute("tabindex", "-1");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("banner")).toHaveTextContent("VECTORiZE");
    expect(screen.getByRole("main")).toContainElement(screen.getByText("Acá vas a poder ver y editar los datos de tu cuenta."));
    expect(screen.getByRole("button", { name: "Menú de cuenta: Ana Gómez" })).toBeInTheDocument();

    const back = screen.getByRole("link", { name: "Volver a Mis proyectos" });
    expect(back.querySelector('[aria-hidden="true"]')).toHaveTextContent("←");
  });

  it("AccountLayout sin sesión nunca se renderiza (lo resuelve AuthBoundary antes)", async () => {
    installAuthBackend({ user: null });
    render(
      <AuthProvider>
        <AuthBoundary>
          <AccountLayout title="Tu cuenta" />
        </AuthBoundary>
      </AuthProvider>,
    );

    await waitFor(() => expect(window.location.search).toBe("?view=login"));
    expect(screen.queryByRole("heading", { name: "Tu cuenta" })).not.toBeInTheDocument();
  });
});

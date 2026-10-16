import { vi } from "vitest";

/**
 * Reemplazo controlable de XMLHttpRequest para tests: src/api/httpClient.ts
 * (uploadFile) lo usa para tener progreso de subida, que fetch no expone. Los
 * tests de UploadPanel estuban XMLHttpRequest con esto en vez de mockear fetch.
 */
export class FakeXMLHttpRequest {
  static instances: FakeXMLHttpRequest[] = [];

  readonly upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  responseText = "";
  url = "";
  aborted = false;
  /** Réplica de XMLHttpRequest.withCredentials: uploadFile debe activarlo (cookie de sesión, M3.1-S03). */
  withCredentials = false;

  private readonly headers: Record<string, string> = {};

  constructor() {
    FakeXMLHttpRequest.instances.push(this);
  }

  open(_method: string, url: string): void {
    this.url = url;
  }

  setRequestHeader(key: string, value: string): void {
    this.headers[key] = value;
  }

  getRequestHeader(key: string): string | undefined {
    return this.headers[key];
  }

  send(): void {
    // No-op: los tests avanzan el ciclo de vida a mano vía respond()/progress()/networkError().
  }

  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }

  respond(status: number, body: unknown): void {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }

  progress(loaded: number, total: number): void {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total } as ProgressEvent);
  }

  networkError(): void {
    this.onerror?.();
  }

  static reset(): void {
    FakeXMLHttpRequest.instances = [];
  }

  static latest(): FakeXMLHttpRequest {
    const instance = FakeXMLHttpRequest.instances.at(-1);
    if (!instance) throw new Error("No se creó ningún FakeXMLHttpRequest todavía.");
    return instance;
  }
}

export function stubXMLHttpRequest(): void {
  FakeXMLHttpRequest.reset();
  vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
}

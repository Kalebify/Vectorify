import { describe, expect, it } from "vitest";
import { formatAbsoluteDateTime, formatRelativeTime } from "./relativeTime";

const NOW = Date.parse("2026-10-04T12:00:00Z");

function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

describe("formatRelativeTime", () => {
  it.each([
    [10_000, "hace unos segundos"],
    [60_000, "hace 1 minuto"],
    [5 * 60_000, "hace 5 minutos"],
    [60 * 60_000, "hace 1 hora"],
    [3 * 60 * 60_000, "hace 3 horas"],
    [24 * 60 * 60_000, "ayer"],
    [5 * 24 * 60 * 60_000, "hace 5 días"],
  ])("%d ms atrás -> %s", (ms, expected) => {
    expect(formatRelativeTime(ago(ms), NOW)).toBe(expected);
  });

  it("trata un timestamp levemente futuro (reloj adelantado) como 'hace unos segundos'", () => {
    expect(formatRelativeTime(new Date(NOW + 5_000).toISOString(), NOW)).toBe("hace unos segundos");
  });

  it("pasados 30 días devuelve una fecha absoluta, no un relativo", () => {
    const result = formatRelativeTime(ago(45 * 24 * 60 * 60_000), NOW);
    expect(result).not.toMatch(/hace/);
    expect(result).toMatch(/\d/);
  });

  it("una fecha inválida no rompe", () => {
    expect(formatRelativeTime("no-es-una-fecha", NOW)).toBe("fecha desconocida");
    expect(formatAbsoluteDateTime("no-es-una-fecha")).toBe("no-es-una-fecha");
  });
});

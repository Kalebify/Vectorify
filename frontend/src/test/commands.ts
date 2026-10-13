import type { CommandDraft, CommandType, JsonValue } from "../lib/editor/commands";

/**
 * Atajo de pruebas (M3-S12): arma el `CommandDraft` que desde esta tarjeta exige `applyEdit`/`commitGesture`. Por defecto es un `object.move` sin
 * parámetros (el productor de prueba decide qué cambia realmente); las pruebas que verifican tipos pasan el suyo.
 */
export function cmd(label: string, type: CommandType = "object.move", parameters?: Record<string, JsonValue>): CommandDraft {
  return { type, label, ...(parameters ? { parameters } : {}) };
}

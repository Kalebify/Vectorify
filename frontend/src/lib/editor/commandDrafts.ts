import { arrangeDescriptor, type AlignReference, type ArrangeActionId } from "./arrange";
import type { CommandDraft, JsonValue } from "./commands";
import type { RecolorRequest, RecolorScope } from "./colors";

/**
 * Borradores de comando (M3-S12) que comparten la UI y el ejecutor declarativo: una sola traducción entre "lo que se pidió" y el `CommandDraft` que
 * registra el historial. Lógica pura. Los parámetros DESCRIBEN (ids, enums, números); nunca llevan geometría.
 */

/** Parámetros del color de destino: la capa por `groupId` (la identidad, nunca el hex) o un color libre nuevo (crea una capa en el mismo comando). */
function colorTargetParameters(request: RecolorRequest): Record<string, JsonValue> {
  return request.target.kind === "layer" ? { targetLayerId: request.target.groupId } : { newColorHex: request.target.hex };
}

/**
 * Fill (`object.fill`), Recolor (`object.recolor`) o Fusionar capas (`object.merge`): la fusión manda sobre el resto (es lo que tiene consecuencias
 * distintas: la capa origen queda vacía), y Fill es el alcance «selección» pedido desde la herramienta Fill.
 */
export function colorDraft(fromFillTool: boolean, scope: RecolorScope, request: RecolorRequest, label: string): CommandDraft {
  if (request.mergeIntoGroupId) {
    return {
      type: "object.merge",
      label,
      parameters: { scope, sourceLayerId: request.sourceGroupId ?? undefined, mergeIntoLayerId: request.mergeIntoGroupId, ...colorTargetParameters(request) },
    };
  }
  if (fromFillTool) return { type: "object.fill", label, parameters: colorTargetParameters(request) };
  return { type: "object.recolor", label, parameters: { scope, sourceLayerId: request.sourceGroupId ?? undefined, ...colorTargetParameters(request) } };
}

/** Alinear / distribuir / orden de pintado: el tipo y el parámetro salen del descriptor del botón de la barra «Organizar». */
export function arrangeDraft(id: ArrangeActionId, label: string, reference: AlignReference): CommandDraft {
  const descriptor = arrangeDescriptor(id);
  if (descriptor.group === "align") return { type: "arrange.align", label, parameters: { mode: descriptor.mode, reference } };
  if (descriptor.group === "distribute") return { type: "arrange.distribute", label, parameters: { axis: descriptor.axis } };
  return { type: "arrange.zorder", label, parameters: { action: descriptor.action } };
}

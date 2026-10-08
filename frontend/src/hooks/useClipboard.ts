import { useCallback, useState } from "react";
import { copyToClipboard, EMPTY_CLIPBOARD, nextPasteOffset, registerPaste, type ClipboardContent, type ClipboardState } from "../lib/editor/clipboard";
import type { Point } from "../lib/editor/types";

/**
 * Portapapeles INTERNO de la sesión del editor (M3-S06, ver `lib/editor/clipboard.ts`): el contenido copiado y el contador de pegados
 * consecutivos que alimenta el offset acumulado (1x, 2x, 3x...). Vive en el shell, no en el documento: copiar no es un comando, no entra
 * al historial y no activa `geometryDirty`.
 *
 * `scopeKey` identifica el documento: si cambia (otro proyecto/imagen/paleta) el portapapeles queda VACÍO -- se pega solo dentro del
 * documento donde se copió. El estado guarda la clave con la que se copió y se descarta durante el render, sin efectos.
 */

export interface ClipboardApi {
  /** Contenido copiado, o `null` si el portapapeles está vacío. */
  content: ClipboardContent | null;
  /** Cantidad de objetos copiados (0 si está vacío). */
  size: number;
  /** Copiar o cortar: reemplaza el contenido y reinicia el contador de offset. */
  copy: (content: ClipboardContent) => void;
  /** Registra un pegado CON offset: el siguiente se desplaza un paso más. Pegar en el lugar no lo llama. */
  registerPaste: () => void;
  /** Offset (unidades de documento) del PRÓXIMO pegado con offset. */
  nextOffset: (mmPerUnit: number | null) => Point;
}

interface Stored {
  scopeKey: string;
  value: ClipboardState;
}

export function useClipboard(scopeKey: string): ClipboardApi {
  const [stored, setStored] = useState<Stored>({ scopeKey, value: EMPTY_CLIPBOARD });
  // Otro documento: el portapapeles se vacía (y no reaparece si se vuelve al anterior). Ajuste de estado durante el render, sin efecto.
  if (stored.scopeKey !== scopeKey) setStored({ scopeKey, value: EMPTY_CLIPBOARD });
  const value = stored.scopeKey === scopeKey ? stored.value : EMPTY_CLIPBOARD;

  const copy = useCallback((content: ClipboardContent) => setStored({ scopeKey, value: copyToClipboard(content) }), [scopeKey]);
  const register = useCallback(
    () => setStored((current) => ({ scopeKey, value: registerPaste(current.scopeKey === scopeKey ? current.value : EMPTY_CLIPBOARD) })),
    [scopeKey],
  );
  const nextOffset = useCallback((mmPerUnit: number | null) => nextPasteOffset(value, mmPerUnit), [value]);

  return { content: value.content, size: value.content?.items.length ?? 0, copy, registerPaste: register, nextOffset };
}

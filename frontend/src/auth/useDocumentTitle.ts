import { useEffect } from "react";
import { DOCUMENT_TITLE_SUFFIX } from "./authCopy";

/** Título del documento por vista de auth (M3.1-S05); restaura el anterior al salir de la vista. */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    const previous = document.title;
    document.title = `${title}${DOCUMENT_TITLE_SUFFIX}`;
    return () => {
      document.title = previous;
    };
  }, [title]);
}

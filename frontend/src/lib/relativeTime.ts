/**
 * Formato relativo legible en español ("hace 5 minutos", "ayer") para la "última modificación"
 * de Mis Proyectos (M2.2-S08). Implementación propia y acotada en vez de `Intl.RelativeTimeFormat`
 * para que la salida no dependa de los datos ICU del entorno (tests deterministas). Pasado el
 * umbral de 30 días devuelve la fecha corta absoluta.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return "fecha desconocida";

  const diff = now - time;
  // Un reloj de cliente levemente adelantado respecto del servidor produce diffs negativos
  // pequeños -- se tratan como "ahora" en vez de mostrar un futuro absurdo.
  if (diff < MINUTE) return "hace unos segundos";
  if (diff < HOUR) return `hace ${plural(Math.floor(diff / MINUTE), "minuto", "minutos")}`;
  if (diff < DAY) return `hace ${plural(Math.floor(diff / HOUR), "hora", "horas")}`;

  const days = Math.floor(diff / DAY);
  if (days === 1) return "ayer";
  if (days < 30) return `hace ${days} días`;

  return new Date(time).toLocaleDateString("es");
}

/** Fecha y hora absolutas legibles, para `title`/`<time>` accesible. */
export function formatAbsoluteDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("es");
}

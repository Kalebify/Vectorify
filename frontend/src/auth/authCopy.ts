/** Copy de las pantallas de autenticación (M3.1-S05, DESIGN.md §11). Español rioplatense con voseo, como el resto de la app. */

export const NETWORK_MESSAGE = "No se pudo contactar con el servidor. Revisá tu conexión e intentá de nuevo.";
export const FORBIDDEN_MESSAGE = "No pudimos verificar la solicitud. Recargá la página e intentá de nuevo.";
export const RATE_LIMITED_MESSAGE = "Hiciste demasiados intentos. Esperá unos minutos antes de volver a probar.";

export const TITLES = {
  login: "Iniciar sesión",
  register: "Crear cuenta",
  registerReceived: "Registro recibido",
  sessionError: "No pudimos comprobar tu sesión",
} as const;

export const DOCUMENT_TITLE_SUFFIX = " — Vectorify";

export const PENDING_TEXT = "Comprobando tu sesión…";

export const SESSION_ERROR = {
  server: (status: number | undefined) =>
    status === undefined
      ? "El servidor no pudo responder. Intentá de nuevo en unos minutos."
      : `El servidor no pudo responder (código ${status}). Intentá de nuevo en unos minutos.`,
  clarification: "Esto no cierra tu sesión.",
  retry: "Reintentar",
  retrying: "Reintentando…",
} as const;

export const LOGIN = {
  intro: "Entrá con tu correo y tu contraseña para ver tus proyectos.",
  emailLabel: "Correo electrónico",
  passwordLabel: "Contraseña",
  rememberLabel: "Recordarme en este dispositivo",
  rememberHint: "Mantiene tu sesión abierta aunque cierres el navegador. No lo marques en un equipo compartido.",
  submit: "Iniciar sesión",
  submitting: "Iniciando sesión…",
  switchPrompt: "¿No tenés cuenta?",
  switchLink: "Creá una",
  emailRequired: "Ingresá tu correo electrónico.",
  emailInvalid: "Ingresá un correo electrónico válido, por ejemplo nombre@ejemplo.com.",
  passwordRequired: "Ingresá tu contraseña.",
  credentials:
    "El correo o la contraseña no son correctos. Si fallaste varias veces seguidas, esperá unos minutos antes de volver a intentar.",
  server: "El servidor no pudo completar el inicio de sesión. Intentá de nuevo en unos minutos.",
} as const;

export const REGISTER = {
  intro: "Creá tu cuenta con tu correo y una contraseña para guardar tus proyectos.",
  emailLabel: "Correo electrónico",
  passwordLabel: "Contraseña",
  passwordHint: "Usá al menos 12 caracteres. Una frase larga que te resulte fácil de recordar es una buena opción.",
  confirmLabel: "Repetí la contraseña",
  submit: "Crear cuenta",
  submitting: "Creando cuenta…",
  switchPrompt: "¿Ya tenés cuenta?",
  switchLink: "Iniciá sesión",
  emailRequired: "Ingresá tu correo electrónico.",
  emailInvalid: "Ingresá un correo electrónico válido, por ejemplo nombre@ejemplo.com.",
  passwordShort: "La contraseña debe tener al menos 12 caracteres.",
  passwordLong: "La contraseña no puede superar los 128 caracteres.",
  confirmRequired: "Repetí la contraseña.",
  confirmMismatch: "Las contraseñas no coinciden.",
  rejected: "No pudimos procesar el registro con esos datos. Revisalos e intentá de nuevo.",
  server: "El servidor no pudo completar el registro. Intentá de nuevo en unos minutos.",
} as const;

export const REGISTER_RECEIVED = {
  body: "Ya podés iniciar sesión con tu correo y la contraseña que elegiste.",
  note: "Si ya tenías una cuenta con este correo, entrá con la contraseña de siempre.",
  goToLogin: "Ir a iniciar sesión",
} as const;

export const BANNERS = {
  expired: "Tu sesión terminó. Iniciá sesión de nuevo para continuar.",
  "signed-out": "Cerraste sesión.",
  "signed-out-all": "Cerraste sesión en todos tus dispositivos.",
  registered: "Registro recibido. Iniciá sesión con tu correo y tu contraseña.",
  "return-info": "Iniciá sesión para continuar. Después te llevamos a la página que querías abrir.",
} as const;

export const USER_MENU = {
  triggerPrefix: "Menú de cuenta:",
  listLabel: "Cuenta",
  signOut: "Salir",
  signOutAll: "Cerrar sesión en todos lados",
  signingOut: "Cerrando sesión…",
  signOutNetwork: "No pudimos cerrar la sesión: no hay conexión con el servidor. Intentá de nuevo.",
  signOutServer: "El servidor no pudo cerrar la sesión. Intentá de nuevo en unos minutos.",
  dismiss: "Cerrar aviso",
  developmentPill: "Modo desarrollo",
  fallbackName: "Usuario",
} as const;

export const LOGOUT_ALL_DIALOG = {
  title: "¿Cerrar sesión en todos lados?",
  description:
    "Vamos a cerrar tu sesión en este navegador y en todos los dispositivos donde entraste con esta cuenta. Después vas a tener que iniciar sesión de nuevo en cada uno.",
  cancel: "Cancelar",
  confirm: "Cerrar sesión en todos lados",
  confirming: "Cerrando sesiones…",
  network: "No pudimos cerrar las sesiones: no hay conexión con el servidor. Intentá de nuevo.",
  server: "El servidor no pudo cerrar las sesiones. Intentá de nuevo en unos minutos.",
} as const;

export const ACCOUNT = {
  back: "Volver a Mis proyectos",
} as const;

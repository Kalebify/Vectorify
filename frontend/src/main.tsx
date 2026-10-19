// PRIMER import, a propósito (M3.1-S08): captura y borra de la barra el token del fragmento de los enlaces de correo antes de que corra nada más.
import './auth/authFragment.ts'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { AppRoot } from './AppRoot.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppRoot />
  </StrictMode>,
)

# Recuperación y cambio de contraseña (Admin Web)

Completa el flujo de "olvidé mi contraseña" que faltaba: Supabase Auth ya
enviaba correctamente el email de recuperación, pero al abrir el enlace el
usuario terminaba en `/login` sin ninguna pantalla para establecer una
contraseña nueva. No es una etapa numerada del plan del cliente -- es una
corrección puntual sobre Admin Web y el paquete `auth-client` compartido.

## Flujo

1. En `/login`, "¿Olvidaste tu contraseña?" muestra un formulario de email.
2. Al enviarlo, se llama a `supabase.auth.resetPasswordForEmail(email, { redirectTo })`
   -- `redirectTo` se arma con `${window.location.origin}/reset-password` en
   tiempo de ejecución (nunca un dominio hardcodeado), así que funciona igual
   en local, staging o cualquier dominio donde esté desplegado el frontend.
3. Se muestra siempre el mismo mensaje genérico ("si el email corresponde a
   una cuenta, vas a recibir instrucciones..."), haya o no haya una cuenta
   real con ese email, y también si Supabase devuelve un error -- ninguna
   variante del mensaje permite inferir si la cuenta existe.
4. El usuario abre el enlace del email y llega a `/reset-password`.
   `@supabase/supabase-js` procesa la URL automáticamente
   (`detectSessionInUrl`, activo por defecto) y dispara el evento
   `PASSWORD_RECOVERY` en `supabase.auth.onAuthStateChange` -- exactamente el
   patrón oficial documentado por Supabase para este flujo. No se parsea ni
   se manipula ningún token a mano.
5. `/reset-password` muestra el formulario de nueva contraseña sólo mientras
   esa sesión de recuperación está activa. Al guardar, llama a
   `supabase.auth.updateUser({ password })` -- la contraseña nunca llega al
   backend de SistemaGrido.
6. Tras un `updateUser` exitoso, se cierra la sesión de recuperación
   (reutilizando el `signOut()` ya existente) y se muestra la confirmación
   con un link a `/login`. El usuario inicia sesión de nuevo, ahora con la
   contraseña nueva, pasando por el flujo normal de `signIn()` (que audita
   el `LOGIN` contra el backend, igual que cualquier otro ingreso).

## Dónde vive cada pieza

- `packages/auth-client/src/AuthContext.tsx`: agrega `passwordRecovery`
  (refleja el evento `PASSWORD_RECOVERY`), `requestPasswordReset(email,
redirectTo)` y `updatePassword(newPassword)` a `useAuth()` -- wrappers
  finos sobre Supabase Auth, mismo patrón que `signIn`/`signOut` ya
  existentes. Ninguno de los dos llama a la API propia de SistemaGrido.
- `apps/admin-web/src/pages/LoginPage.tsx`: agrega el modo "olvidé mi
  contraseña" dentro de la misma pantalla de login.
- `apps/admin-web/src/pages/ResetPasswordPage.tsx`: pantalla nueva,
  `/reset-password` en `apps/admin-web/src/App.tsx`. Deliberadamente fuera
  de `RequireAuth` -- a quien llega desde el enlace todavía no lo valida el
  backend como una sesión "normal" hasta que decide loguearse de nuevo.

## Por qué no hay loop entre `/login` y `/reset-password`

`ResetPasswordPage` nunca redirige automáticamente a `/login`: si no hay una
sesión de recuperación válida (`passwordRecovery` en `false`, por ejemplo
alguien que entra a la URL directamente sin haber abierto el enlace del
email), muestra un aviso con un link manual a `/login` -- no navega sola. La
única redirección automática de todo el flujo es la que ya hacía
`LoginPage` cuando `user` es real (sin relación con este cambio). El único
salto entre pantallas que agrega este flujo es intencional y en un solo
sentido: de `/reset-password` (éxito) a `/login`, después de cerrar la
sesión de recuperación.

## Alcance

Sólo Admin Web y `auth-client`. Sin cambios en el backend de SistemaGrido,
en el modelo `AppUser`, en roles/permisos, ni en configuración de
Supabase/Render/Vercel -- Supabase Auth sigue siendo la única autoridad
sobre credenciales, y el backend sigue sin recibir ni almacenar contraseñas.
Shop PWA no se tocó.

import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@sistema-grido/auth-client';

/**
 * Longitud mínima razonable, compatible con Supabase Auth (cuyo mínimo por
 * defecto es 6) -- se elige un valor propio más alto (nunca más bajo que el
 * de Supabase) para no depender de la configuración exacta del proyecto,
 * que esta corrección no debe tocar (sección 6/9 del prompt: no modificar
 * configuración de Supabase).
 */
const MIN_PASSWORD_LENGTH = 8;

/**
 * Mensaje fijo para cualquier error que venga de Supabase al establecer la
 * contraseña (enlace vencido/ya usado, error de red, etc.) -- nunca se
 * muestra `error.message` de Supabase tal cual, para no arriesgar exponer
 * detalles internos (sección 6 del prompt: "no exponer información sensible
 * en mensajes de error").
 */
const UPDATE_ERROR_MESSAGE =
  'No pudimos actualizar tu contraseña. El enlace puede haber expirado o ya haber sido usado -- volvé a "¿Olvidaste tu contraseña?" desde la pantalla de inicio de sesión para pedir uno nuevo.';

/**
 * Pantalla de recuperación de contraseña (`/reset-password`). Reconoce la
 * sesión de recuperación mediante `passwordRecovery` de `useAuth()` -- que a
 * su vez refleja el evento `PASSWORD_RECOVERY` de
 * `supabase.auth.onAuthStateChange`, el mecanismo oficial de
 * @supabase/supabase-js para este flujo (no se maneja ningún token a mano
 * acá). No está protegida por `RequireAuth`: a quien llega desde el enlace
 * del email todavía no lo reconoce el backend de SistemaGrido como una
 * sesión "normal" -- es Supabase Auth quien valida el enlace.
 */
export function ResetPasswordPage() {
  const { loading, passwordRecovery, updatePassword, signOut } = useAuth();

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!password || !confirmPassword) {
      setError('Completá los dos campos.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Las contraseñas no coinciden.');
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
      return;
    }

    setSubmitting(true);
    try {
      await updatePassword(password);
      // Cierra la sesión de recuperación: el usuario vuelve a /login e
      // inicia sesión explícitamente con la contraseña nueva (sección 5 del
      // prompt), en vez de quedar logueado automáticamente por el enlace.
      try {
        await signOut();
      } catch {
        // La contraseña ya se guardó -- este signOut es sólo limpieza.
      }
      setDone(true);
    } catch {
      setError(UPDATE_ERROR_MESSAGE);
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="login-page">
        <div className="login-form">
          <h1>SistemaGrido</h1>
          <p>Tu contraseña fue actualizada correctamente.</p>
          <Link to="/login">Ir a iniciar sesión</Link>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="login-page">
        <div className="login-form">
          <h1>SistemaGrido</h1>
          <p className="muted">Verificando el enlace de recuperación...</p>
        </div>
      </div>
    );
  }

  if (!passwordRecovery) {
    return (
      <div className="login-page">
        <div className="login-form">
          <h1>SistemaGrido</h1>
          <p className="muted">
            Este enlace de recuperación no es válido o ya venció. Pedí uno nuevo desde la pantalla
            de inicio de sesión.
          </p>
          <Link to="/login">Volver a iniciar sesión</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <form className="login-form" onSubmit={(event) => void handleSubmit(event)}>
        <h1>SistemaGrido</h1>
        <p className="muted">Elegí tu nueva contraseña.</p>

        <label htmlFor="new-password">Nueva contraseña</label>
        <input
          id="new-password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />

        <label htmlFor="confirm-password">Confirmar nueva contraseña</label>
        <input
          id="confirm-password"
          type="password"
          autoComplete="new-password"
          required
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
        />

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" disabled={submitting}>
          {submitting ? 'Guardando...' : 'Guardar nueva contraseña'}
        </button>
      </form>
    </div>
  );
}

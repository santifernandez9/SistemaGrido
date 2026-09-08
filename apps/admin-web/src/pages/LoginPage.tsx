import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@sistema-grido/auth-client';

/**
 * Mensaje único para cualquier resultado de "olvidé mi contraseña" -- éxito o
 * error de Supabase, da igual. Es a propósito: `resetPasswordForEmail` de
 * Supabase ya no distingue si el email corresponde a una cuenta real, y este
 * componente no le agrega ninguna distinción propia (sección 6 del prompt de
 * recuperación de contraseña: "no revelar si una cuenta existe o no").
 */
const FORGOT_PASSWORD_MESSAGE =
  'Si el email corresponde a una cuenta, vas a recibir un correo con instrucciones para restablecer la contraseña.';

export function LoginPage() {
  const { user, signIn, requestPasswordReset } = useAuth();
  const location = useLocation();
  const [mode, setMode] = useState<'login' | 'forgot'>('login');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotMessage, setForgotMessage] = useState<string | null>(null);
  const [forgotSubmitting, setForgotSubmitting] = useState(false);

  if (user) {
    const from = (location.state as { from?: Location })?.from;
    return <Navigate to={from?.pathname ?? '/'} replace />;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await signIn(email, password);
    } catch {
      setError('No pudimos iniciar sesión. Revisá tu email y contraseña.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleForgotSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setForgotSubmitting(true);
    setForgotMessage(null);
    try {
      await requestPasswordReset(forgotEmail, `${window.location.origin}/reset-password`);
    } catch {
      // Deliberadamente sin distinguir del caso de éxito -- ver FORGOT_PASSWORD_MESSAGE.
    } finally {
      setForgotMessage(FORGOT_PASSWORD_MESSAGE);
      setForgotSubmitting(false);
    }
  }

  if (mode === 'forgot') {
    return (
      <div className="login-page">
        <form className="login-form" onSubmit={(event) => void handleForgotSubmit(event)}>
          <h1>SistemaGrido</h1>
          <p className="muted">Ingresá tu email para restablecer tu contraseña.</p>

          <label htmlFor="forgot-email">Email</label>
          <input
            id="forgot-email"
            type="email"
            autoComplete="username"
            required
            value={forgotEmail}
            onChange={(event) => setForgotEmail(event.target.value)}
          />

          {forgotMessage && <p className="muted">{forgotMessage}</p>}

          <button type="submit" disabled={forgotSubmitting}>
            {forgotSubmitting ? 'Enviando...' : 'Enviar instrucciones'}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setMode('login');
              setForgotMessage(null);
            }}
          >
            Volver a iniciar sesión
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="login-page">
      <form className="login-form" onSubmit={(event) => void handleSubmit(event)}>
        <h1>SistemaGrido</h1>
        <p className="muted">Ingresá con tu usuario individual.</p>

        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />

        <label htmlFor="password">Contraseña</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" disabled={submitting}>
          {submitting ? 'Ingresando...' : 'Ingresar'}
        </button>
        <button type="button" className="secondary" onClick={() => setMode('forgot')}>
          ¿Olvidaste tu contraseña?
        </button>
      </form>
    </div>
  );
}

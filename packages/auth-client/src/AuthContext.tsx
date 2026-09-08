import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { UserProfile } from '@sistema-grido/shared-types';
import { createApiClient, ApiClientError, type ApiClient } from './apiClient.js';

export interface AuthState {
  /** undefined = todavía no se sabe (arrancando); null = no hay sesión. */
  user: UserProfile | null | undefined;
  loading: boolean;
  error: string | null;
  api: ApiClient;
  /**
   * true mientras Supabase reporta que la sesión activa viene de un enlace de
   * recuperación de contraseña (evento `PASSWORD_RECOVERY` de
   * `onAuthStateChange`) -- ver `requestPasswordReset`/`updatePassword` más
   * abajo. Vuelve a `false` en cuanto se cierra esa sesión.
   */
  passwordRecovery: boolean;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  /**
   * "Olvidé mi contraseña": pide a Supabase Auth que envíe el email de
   * recuperación. `redirectTo` lo arma el llamador (normalmente
   * `${window.location.origin}/reset-password`) -- este paquete no asume
   * ningún dominio ni entorno. Supabase ya no distingue, en su respuesta,
   * si el email corresponde a una cuenta existente (ver sección 6 del
   * prompt de recuperación de contraseña); este método no agrega ninguna
   * distinción propia.
   */
  requestPasswordReset(email: string, redirectTo: string): Promise<void>;
  /**
   * Establece la nueva contraseña sobre la sesión de recuperación activa
   * (`passwordRecovery` debe ser `true`). Nunca pasa por el backend de
   * SistemaGrido -- es Supabase Auth quien la recibe y la guarda.
   */
  updatePassword(newPassword: string): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export interface AuthProviderProps {
  supabase: SupabaseClient;
  apiBaseUrl: string;
  children: ReactNode;
}

/**
 * Sesión + identidad individual (sección 8 del prompt de Etapa 1, P-001 resuelta).
 * El login/logout de credenciales lo maneja Supabase Auth (`signIn`/`signOut` acá
 * son wrappers finos); el backend es la autoridad sobre si esa sesión corresponde
 * a un usuario real, activo, del sistema -- por eso después de loguear se llama a
 * POST /api/auth/session (registra LOGIN en auditoría) y se usa su respuesta como
 * perfil, no lo que Supabase por sí solo devolvería.
 */
export function AuthProvider({ supabase, apiBaseUrl, children }: AuthProviderProps) {
  const api = useMemo(
    () => createApiClient({ baseUrl: apiBaseUrl, supabase }),
    [apiBaseUrl, supabase],
  );
  const [user, setUser] = useState<UserProfile | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [passwordRecovery, setPasswordRecovery] = useState(false);

  const refreshProfile = useCallback(async () => {
    try {
      const profile = await api.get<UserProfile>('/api/me');
      setUser(profile);
      setError(null);
    } catch (err) {
      setUser(null);
      if (err instanceof ApiClientError && err.code !== 'UNAUTHENTICATED') {
        setError(err.message);
      }
    }
  }, [api]);

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      if (data.session) {
        void refreshProfile();
      } else {
        setUser(null);
      }
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        setUser(null);
        setPasswordRecovery(false);
      }
      // Se dispara cuando el usuario abre un enlace de recuperación de
      // contraseña válido (ver `requestPasswordReset`/`updatePassword`) --
      // patrón oficial de @supabase/supabase-js, no un mecanismo propio.
      if (event === 'PASSWORD_RECOVERY') {
        setPasswordRecovery(true);
      }
    });

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      setError(null);
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) {
        setError(signInError.message);
        throw signInError;
      }
      // Confirma server-side que la cuenta existe y está activa, y deja auditoría de LOGIN.
      await api.post('/api/auth/session');
      await refreshProfile();
    },
    [supabase, api, refreshProfile],
  );

  const signOut = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } catch {
      // Si el backend no respondió, igual cerramos la sesión del lado del cliente.
    }
    await supabase.auth.signOut();
    setUser(null);
  }, [supabase, api]);

  const requestPasswordReset = useCallback(
    async (email: string, redirectTo: string) => {
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo,
      });
      if (resetError) {
        throw resetError;
      }
    },
    [supabase],
  );

  const updatePassword = useCallback(
    async (newPassword: string) => {
      const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
      if (updateError) {
        throw updateError;
      }
    },
    [supabase],
  );

  const value: AuthState = {
    user,
    loading: user === undefined,
    error,
    api,
    passwordRecovery,
    signIn,
    signOut,
    requestPasswordReset,
    updatePassword,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth debe usarse dentro de un <AuthProvider>');
  }
  return ctx;
}

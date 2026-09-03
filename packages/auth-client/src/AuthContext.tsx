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
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
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

  const value: AuthState = {
    user,
    loading: user === undefined,
    error,
    api,
    signIn,
    signOut,
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

import { useEffect, useState, type FormEvent } from 'react';
import { useAuth, ApiClientError } from '@sistema-grido/auth-client';
import type {
  InviteUserInput,
  LocationSummary,
  RoleCode,
  UserProfile,
} from '@sistema-grido/shared-types';
import { ROLE_CODES } from '@sistema-grido/shared-types';

const ROLE_LABELS: Record<RoleCode, string> = {
  ADMIN: 'Administrador / Franquiciado',
  DEPOSIT_MANAGER: 'Encargado de depósito',
  SHOP_EMPLOYEE: 'Empleada de heladería',
};

/**
 * Gestión de usuarios individuales (P-001 resuelta). Sólo ADMIN llega acá
 * (RequireAuth en App.tsx), pero el backend vuelve a validar el rol igual --
 * esto es sólo UX, no el control de acceso real.
 */
export function UsersPage() {
  const { api } = useAuth();
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [locations, setLocations] = useState<LocationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formState, setFormState] = useState<InviteUserInput>({
    email: '',
    displayName: '',
    roleCode: 'SHOP_EMPLOYEE',
    defaultLocationId: null,
  });
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const [usersData, locationsData] = await Promise.all([
        api.get<UserProfile[]>('/api/users'),
        api.get<LocationSummary[]>('/api/locations'),
      ]);
      setUsers(usersData);
      setLocations(locationsData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cargar la lista de usuarios');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      await api.post<UserProfile>('/api/users', formState);
      setFormState({
        email: '',
        displayName: '',
        roleCode: 'SHOP_EMPLOYEE',
        defaultLocationId: null,
      });
      await loadData();
    } catch (err) {
      setFormError(err instanceof ApiClientError ? err.message : 'No se pudo invitar al usuario');
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleActive(user: UserProfile) {
    try {
      await api.patch(`/api/users/${user.id}`, { active: !user.active });
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo actualizar el usuario');
    }
  }

  return (
    <div className="users-page">
      <h1>Usuarios</h1>
      <p className="muted">
        Cada persona tiene su propio usuario individual — no se usan cuentas compartidas por
        sucursal.
      </p>

      <section className="card">
        <h2>Invitar a una persona nueva</h2>
        <form onSubmit={(event) => void handleInvite(event)} className="invite-form">
          <label htmlFor="invite-email">Email</label>
          <input
            id="invite-email"
            type="email"
            required
            value={formState.email}
            onChange={(event) => setFormState((s) => ({ ...s, email: event.target.value }))}
          />

          <label htmlFor="invite-name">Nombre visible</label>
          <input
            id="invite-name"
            type="text"
            required
            value={formState.displayName}
            onChange={(event) => setFormState((s) => ({ ...s, displayName: event.target.value }))}
          />

          <label htmlFor="invite-role">Rol</label>
          <select
            id="invite-role"
            value={formState.roleCode}
            onChange={(event) =>
              setFormState((s) => ({ ...s, roleCode: event.target.value as RoleCode }))
            }
          >
            {ROLE_CODES.map((code) => (
              <option key={code} value={code}>
                {ROLE_LABELS[code]}
              </option>
            ))}
          </select>

          <label htmlFor="invite-location">Ubicación asignada</label>
          <select
            id="invite-location"
            value={formState.defaultLocationId ?? ''}
            onChange={(event) =>
              setFormState((s) => ({ ...s, defaultLocationId: event.target.value || null }))
            }
          >
            <option value="">Sin ubicación (acceso completo, sólo Admin)</option>
            {locations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
              </option>
            ))}
          </select>

          {formError && (
            <p className="error" role="alert">
              {formError}
            </p>
          )}

          <button type="submit" disabled={submitting}>
            {submitting ? 'Invitando...' : 'Invitar'}
          </button>
        </form>
      </section>

      <section className="card">
        <h2>Usuarios de la organización</h2>
        {loading && <p>Cargando...</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!loading && !error && (
          <table>
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Email</th>
                <th>Rol</th>
                <th>Estado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>{user.displayName}</td>
                  <td>{user.email}</td>
                  <td>{ROLE_LABELS[user.roleCode]}</td>
                  <td>{user.active ? 'Activo' : 'Desactivado'}</td>
                  <td>
                    <button type="button" onClick={() => void toggleActive(user)}>
                      {user.active ? 'Desactivar' : 'Reactivar'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

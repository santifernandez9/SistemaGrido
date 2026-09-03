import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from '@sistema-grido/auth-client';
import { LoginPage } from './pages/LoginPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { UsersPage } from './pages/UsersPage.js';
import { Layout } from './components/Layout.js';

/**
 * Routing base de Etapa 1 (sección 12 del prompt): login, layout, rutas protegidas
 * y una pantalla inicial neutra. Ninguna pantalla operativa final (conteo, stock,
 * ventas, caja, cierres) se implementa acá -- eso es de etapas futuras.
 */
export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route
          path="usuarios"
          element={
            <RequireAuth roles={['ADMIN']}>
              <UsersPage />
            </RequireAuth>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

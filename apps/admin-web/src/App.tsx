import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from '@sistema-grido/auth-client';
import { LoginPage } from './pages/LoginPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { UsersPage } from './pages/UsersPage.js';
import { CategoriesPage } from './pages/CategoriesPage.js';
import { FlavorsPage } from './pages/FlavorsPage.js';
import { ProductsPage } from './pages/ProductsPage.js';
import { Layout } from './components/Layout.js';

/**
 * Routing (Etapa 1 + Etapa 2, sección 15 del prompt de Etapa 2): login, layout,
 * rutas protegidas y las pantallas de catálogo/maestros. Ninguna pantalla operativa
 * de inventario (conteo, stock, ventas, caja, cierres) se implementa acá -- eso es
 * de etapas futuras.
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
        <Route
          path="categorias"
          element={
            <RequireAuth roles={['ADMIN']}>
              <CategoriesPage />
            </RequireAuth>
          }
        />
        <Route
          path="sabores"
          element={
            <RequireAuth roles={['ADMIN']}>
              <FlavorsPage />
            </RequireAuth>
          }
        />
        <Route
          path="productos"
          element={
            <RequireAuth roles={['ADMIN']}>
              <ProductsPage />
            </RequireAuth>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

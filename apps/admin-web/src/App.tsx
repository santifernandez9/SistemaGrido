import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from '@sistema-grido/auth-client';
import { LoginPage } from './pages/LoginPage.js';
import { ResetPasswordPage } from './pages/ResetPasswordPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { UsersPage } from './pages/UsersPage.js';
import { CategoriesPage } from './pages/CategoriesPage.js';
import { FlavorsPage } from './pages/FlavorsPage.js';
import { ProductsPage } from './pages/ProductsPage.js';
import { InventoryStockPage } from './pages/InventoryStockPage.js';
import { InventoryMovementsPage } from './pages/InventoryMovementsPage.js';
import { Layout } from './components/Layout.js';

/**
 * Routing (Etapa 1, 2 y 3): login, layout, rutas protegidas, pantallas de
 * catálogo/maestros y el panel administrativo del motor de inventario (Stock,
 * Movimientos -- ver docs/ETAPA-3-MOTOR-INVENTARIO.md, sección "Admin Web").
 * Ninguna pantalla OPERATIVA de inventario (conteo, mermas, baja de lata,
 * ventas, caja, cierres) se implementa acá todavía -- eso es de etapas
 * futuras, y corresponde a la Shop PWA, no a este panel de escritorio.
 *
 * `/reset-password` (recuperación/cambio de contraseña, ver
 * docs/RECUPERACION-CONTRASENA.md) es, junto con `/login`, la única ruta
 * pública -- deliberadamente FUERA de `RequireAuth`: a quien llega desde el
 * enlace de recuperación de Supabase todavía no lo valida el backend como
 * una sesión "normal".
 */
export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
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
        <Route
          path="stock"
          element={
            <RequireAuth roles={['ADMIN']}>
              <InventoryStockPage />
            </RequireAuth>
          }
        />
        <Route
          path="movimientos"
          element={
            <RequireAuth roles={['ADMIN']}>
              <InventoryMovementsPage />
            </RequireAuth>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

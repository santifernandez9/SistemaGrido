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
import { ShopOpsPage } from './pages/ShopOpsPage.js';
import { SalesImportPage } from './pages/SalesImportPage.js';
import { WeeklyClosingPage } from './pages/WeeklyClosingPage.js';
import { PriceListPage } from './pages/PriceListPage.js';
import { Layout } from './components/Layout.js';

/**
 * Routing (Etapa 1 a 4): login, layout, rutas protegidas, pantallas de
 * catálogo/maestros, el panel administrativo del motor de inventario (Stock,
 * Movimientos -- ver docs/ETAPA-3-MOTOR-INVENTARIO.md, sección "Admin Web")
 * y las vistas de sólo lectura de la App Heladería (Etapa 4, sección 15:
 * "vistas mínimas de revisión", ver docs/ETAPA-4-APP-HELADERIA.md). Ninguna
 * pantalla OPERATIVA de captura (conteo, mermas, baja de lata, gastos, sin
 * stock, ventas, caja, cierres) se implementa acá -- esa es la Shop PWA;
 * este panel sólo revisa lo ya cargado.
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
        <Route
          path="heladeria"
          element={
            <RequireAuth roles={['ADMIN']}>
              <ShopOpsPage />
            </RequireAuth>
          }
        />
        <Route
          path="ventas"
          element={
            <RequireAuth roles={['ADMIN']}>
              <SalesImportPage />
            </RequireAuth>
          }
        />
        <Route
          path="cierre-semanal"
          element={
            <RequireAuth roles={['ADMIN']}>
              <WeeklyClosingPage />
            </RequireAuth>
          }
        />
        <Route
          path="precios"
          element={
            <RequireAuth roles={['ADMIN']}>
              <PriceListPage />
            </RequireAuth>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

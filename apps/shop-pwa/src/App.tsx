import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from '@sistema-grido/auth-client';
import { LoginPage } from './pages/LoginPage.js';
import { HomePage } from './pages/HomePage.js';
import { CountPage } from './pages/CountPage.js';
import { WastePage } from './pages/WastePage.js';
import { CloseContainerPage } from './pages/CloseContainerPage.js';
import { ExpensePage } from './pages/ExpensePage.js';
import { StockoutPage } from './pages/StockoutPage.js';
import { Layout } from './components/Layout.js';

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
        <Route index element={<HomePage />} />
        <Route path="conteo" element={<CountPage />} />
        <Route path="merma" element={<WastePage />} />
        <Route path="baja-lata" element={<CloseContainerPage />} />
        <Route path="gasto" element={<ExpensePage />} />
        <Route path="sin-stock" element={<StockoutPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

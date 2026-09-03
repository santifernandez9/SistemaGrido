import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Iconos placeholder (public/icon-*.png) generados para esta etapa -- reemplazar
// por los assets de marca reales antes de un lanzamiento real. Ver
// docs/ETAPA-1-BASE-CORE.md, sección "PWA".
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt', // Nunca reemplaza la app en uso sin avisar -- ver App.tsx (UpdatePrompt).
      includeAssets: ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png'],
      manifest: {
        name: 'SistemaGrido — Heladería',
        short_name: 'Grido App',
        description: 'App operativa para heladería y depósito — SistemaGrido',
        theme_color: '#0B1D33',
        background_color: '#0B1D33',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Precachea sólo el shell de la app (assets estáticos). Etapa 1 no cachea
        // respuestas de la API ni implementa sincronización offline de datos --
        // eso es una decisión funcional de etapas futuras (conteo con autoguardado,
        // sección 13 del prompt), no algo a inventar acá.
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
      },
      devOptions: {
        enabled: false, // El service worker sólo se registra en build de producción.
      },
    }),
  ],
  server: {
    port: 5174,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});

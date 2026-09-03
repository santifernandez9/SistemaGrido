import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorBoundary } from './ErrorBoundary.js';

function Boom(): never {
  throw new Error('boom');
}

describe('ErrorBoundary (shop-pwa)', () => {
  it('muestra un mensaje de fallback en vez de una pantalla en blanco', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Algo salió mal')).toBeInTheDocument();
    consoleError.mockRestore();
  });
});

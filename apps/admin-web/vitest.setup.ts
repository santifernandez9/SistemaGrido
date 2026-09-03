import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Sin esto, el DOM de un test queda montado para el siguiente test del mismo
// archivo (no usamos `test.globals: true`, así que Testing Library no puede
// engancharse solo al afterEach global).
afterEach(() => {
  cleanup();
});

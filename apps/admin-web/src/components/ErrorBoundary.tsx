import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Manejo de errores del frontend (sección 12 del prompt de Etapa 1): un error de
 * render no controlado no debe dejar la pantalla en blanco sin explicación.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Error no controlado en la UI', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error-boundary">
          <h1>Algo salió mal</h1>
          <p>Recargá la página. Si el problema sigue, avisale al equipo técnico.</p>
        </div>
      );
    }
    return this.props.children;
  }
}

export const SECRET_KEY = /token|secret|password|api[_-]?key|authorization/i;

/**
 * Pi diagnostics intentionally preserve their original content. Callers remain
 * responsible for applying the existing numeric bounds at their output seam.
 */
export function redactDiagnostic(value: string, _secrets: string[] = []): string {
  return value;
}

/**
 * Retained for interface compatibility while Pi-owned output filtering is
 * disabled. Collected values are not transformed by this package.
 */
export function environmentSecrets(env: NodeJS.ProcessEnv, configured: string[] = []): string[] {
  return [...new Set([
    ...configured,
    ...Object.entries(env)
      .filter(([key, value]) => SECRET_KEY.test(key) && value !== undefined && value.length >= 8)
      .map(([, value]) => value!),
  ])];
}

/** Streams Pi output unchanged across arbitrary callback boundaries. */
export class StreamingRedactor {
  constructor(
    _secrets: string[],
    private readonly write: (value: string) => void,
    _redactValue?: (value: string) => string,
    _sensitiveMarker?: RegExp,
  ) {}

  push(chunk: string): void {
    if (chunk) this.write(chunk);
  }

  flush(): void {}
}

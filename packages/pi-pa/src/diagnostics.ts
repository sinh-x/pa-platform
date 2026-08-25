const SECRET_TEXT = [
  /(?:token|secret|password|api[_-]?key|authorization)\s*(?::|=|\s)\s*\S+/gi,
  /bearer\s+\S+/gi,
  /sk-[\w-]+/gi,
];

export const SECRET_KEY = /token|secret|password|api[_-]?key|authorization/i;
const STREAM_CONTEXT = 8192;

export function redactDiagnostic(value: string, secrets: string[] = []): string {
  let result = value;
  for (const secret of secrets) if (secret) result = result.split(secret).join("[REDACTED]");
  for (const pattern of SECRET_TEXT) result = result.replace(pattern, "[REDACTED]");
  return result;
}

export function environmentSecrets(env: NodeJS.ProcessEnv, configured: string[] = []): string[] {
  return [...new Set([
    ...configured,
    ...Object.entries(env)
      .filter(([key, value]) => SECRET_KEY.test(key) && value !== undefined && value.length >= 8)
      .map(([, value]) => value!),
  ])];
}

/**
 * Redacts arbitrary stream chunks without treating callback boundaries as
 * security boundaries. Complete lines are emitted immediately; a bounded
 * overlap protects secrets and credential-shaped tokens split across chunks.
 */
export class StreamingRedactor {
  private buffer = "";
  private readonly overlap: number;

  constructor(
    private readonly secrets: string[],
    private readonly write: (safe: string) => void,
  ) {
    const longestSecret = secrets.reduce((length, secret) => Math.max(length, secret.length), 0);
    this.overlap = Math.max(STREAM_CONTEXT, longestSecret + 128);
  }

  push(chunk: string): void {
    this.buffer += chunk;
    const newline = this.buffer.lastIndexOf("\n");
    if (newline >= 0) {
      this.emit(this.buffer.slice(0, newline + 1));
      this.buffer = this.buffer.slice(newline + 1);
    }
    if (this.buffer.length > this.overlap * 2) {
      const cutoff = this.buffer.length - this.overlap;
      const masked = maskDiagnostic(this.buffer, this.secrets);
      this.write(masked.slice(0, cutoff));
      this.buffer = masked.slice(cutoff);
    }
  }

  flush(): void {
    if (!this.buffer) return;
    this.emit(this.buffer);
    this.buffer = "";
  }

  private emit(value: string): void {
    if (value) this.write(redactDiagnostic(value, this.secrets));
  }
}

function maskDiagnostic(value: string, secrets: string[]): string {
  let result = value;
  for (const secret of secrets) if (secret) result = result.split(secret).join("*".repeat(secret.length));
  for (const pattern of SECRET_TEXT) result = result.replace(pattern, (match) => "*".repeat(match.length));
  return result;
}

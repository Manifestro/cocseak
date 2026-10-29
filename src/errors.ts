/** Errors that map to a documented exit code. */

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class ProviderError extends Error {
  readonly status: number | undefined;
  readonly body: string | undefined;
  /** Transient: the same request may succeed if sent again. */
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    status?: number,
    body?: string,
    options: { retryable?: boolean; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.body = body;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export class MaxTurnsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaxTurnsError";
  }
}

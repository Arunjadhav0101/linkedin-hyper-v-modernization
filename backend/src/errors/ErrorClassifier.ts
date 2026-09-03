import { VoyagerApiError, MissingIntegrationError } from '../automation/VoyagerClient.js';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class ErrorClassifier {
  /**
   * Returns true if error is a permanent client/data/auth failure that should NOT be retried
   */
  public static isPermanent(err: unknown): boolean {
    if (!err) return false;

    if (err instanceof MissingIntegrationError || err instanceof ValidationError) {
      return true;
    }

    if (err instanceof VoyagerApiError) {
      // 4xx client errors (400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found, 422 Unprocessable)
      // are permanent data/permission issues, EXCEPT 429/421 which are rate limits
      if (err.statusCode >= 400 && err.statusCode < 500) {
        return err.statusCode !== 429 && err.statusCode !== 421;
      }
    }

    const message = (err as Error).message || '';
    if (
      message.includes('Missing integration') ||
      message.includes('Invalid LinkedIn session cookie') ||
      message.includes('Cannot send invitation') ||
      message.includes('Cannot send message') ||
      message.includes('was not found in database')
    ) {
      return true;
    }

    return false;
  }

  /**
   * Returns true if error is a transient upstream/network failure that CAN be retried
   */
  public static isTransient(err: unknown): boolean {
    if (!err) return false;

    if (this.isPermanent(err)) return false;

    if (err instanceof VoyagerApiError) {
      return err.statusCode >= 500;
    }

    const message = (err as Error).message || '';
    if (
      message.includes('fetch failed') ||
      message.includes('ECONNRESET') ||
      message.includes('ETIMEDOUT') ||
      message.includes('ENOTFOUND') ||
      message.includes('EAI_AGAIN') ||
      message.includes('timeout') ||
      message.includes('Network')
    ) {
      return true;
    }

    return false;
  }

  /**
   * Returns true if error is a LinkedIn anti-bot or rate-limit challenge
   */
  public static isRateLimit(err: unknown): boolean {
    if (err instanceof VoyagerApiError) {
      return err.statusCode === 429 || err.statusCode === 421 || err.statusCode === 999;
    }
    const message = (err as Error).message || '';
    return message.includes('Rate limit') || message.includes('Cooloff');
  }
}

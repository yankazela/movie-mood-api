/**
 * Errors with a known HTTP status that handlers return to the caller as-is.
 * Anything else that escapes a handler is treated as an unexpected failure (500).
 */
export class ClientError extends Error {
    public readonly statusCode: number;

    constructor(message: string, statusCode = 400) {
        super(message);
        this.name = new.target.name;
        this.statusCode = statusCode;
    }
}

export class ValidationError extends ClientError {}

export class UserAlreadyExistsError extends ClientError {
    constructor(email: string) {
        super(`A user with email ${email} already exists`);
    }
}

/** Credentials or session were rejected by the auth provider. */
export class UnauthorizedError extends ClientError {
    constructor(message: string) {
        super(message, 401);
    }
}

export class NotFoundError extends ClientError {
    constructor(message: string) {
        super(message, 404);
    }
}

/** The request was understood but must not be fulfilled, e.g. a mood that raised a safety flag. */
export class SafetyError extends ClientError {
    constructor(message: string) {
        super(message, 422);
    }
}

export class RateLimitError extends ClientError {
    constructor(message: string) {
        super(message, 429);
    }
}

/** A dependency this feature needs is not configured or not reachable. */
export class ServiceUnavailableError extends ClientError {
    constructor(message: string) {
        super(message, 503);
    }
}

/** Internal: a profile already exists for this identity. Callers decide whether that matters. */
export class ProfileAlreadyExistsError extends Error {
    constructor(userId: string) {
        super(`A profile already exists for user ${userId}`);
        this.name = new.target.name;
    }
}

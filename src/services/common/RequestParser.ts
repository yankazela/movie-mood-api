import { ValidationService } from "@novha/cdk-lib";
import { ValidationError } from "./errors";

/**
 * Parses an API Gateway body into a validated request DTO.
 * Throws ValidationError, with the field messages, on bad input.
 */
export async function parseRequest<T extends ValidationService>(
    body: string | null,
    Request: new () => T,
): Promise<T> {
    let parsed: unknown;

    try {
        parsed = JSON.parse(body ?? "");
    } catch {
        throw new ValidationError("Request body must be valid JSON");
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new ValidationError("Request body must be a JSON object");
    }

    const request = Object.assign(new Request(), parsed);

    try {
        await request.validate();
    } catch (error: any) {
        throw new ValidationError(error.message);
    }

    return request;
}

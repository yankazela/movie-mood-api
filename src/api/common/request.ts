import { APIGatewayProxyEvent } from "aws-lambda";
import { UnauthorizedError, ValidationError } from "../../services/common/errors";
import { EMediaType, isMediaType } from "../../services/media/MediaType";
import { localeFromHeader, runWithLocale } from "../../services/i18n/locale";

/** The caller's id, read from the claims API Gateway verified; never from the request itself. */
export function requireUserId(event: APIGatewayProxyEvent): string {
    const userId = event.requestContext?.authorizer?.claims?.sub as string | undefined;

    if (!userId) {
        throw new UnauthorizedError("Missing or invalid authorization");
    }

    return userId;
}

export function queryParam(event: APIGatewayProxyEvent, name: string): string | undefined {
    const value = event.queryStringParameters?.[name]?.trim();

    return value ? value : undefined;
}

export function listParam(event: APIGatewayProxyEvent, name: string): string[] {
    return (queryParam(event, name) ?? "").split(",").map(part => part.trim()).filter(Boolean);
}

export function intParam(event: APIGatewayProxyEvent, name: string): number | undefined {
    const raw = queryParam(event, name);

    if (raw === undefined) {
        return undefined;
    }

    const value = Number(raw);

    if (!Number.isInteger(value)) {
        throw new ValidationError(`${name} must be a whole number`);
    }

    return value;
}

export function mediaTypesParam(event: APIGatewayProxyEvent): EMediaType[] | undefined {
    const types = listParam(event, "mediaTypes");

    if (types.length === 0) {
        return undefined;
    }

    const invalid = types.filter(type => !isMediaType(type));

    if (invalid.length > 0) {
        throw new ValidationError(`Unknown mediaTypes: ${invalid.join(", ")}`);
    }

    return types as EMediaType[];
}

/** API Gateway may leave path parameters percent-encoded; item ids contain colons. */
export function pathParam(event: APIGatewayProxyEvent, name: string): string {
    const raw = event.pathParameters?.[name];

    if (!raw) {
        throw new ValidationError(`Missing path parameter ${name}`);
    }

    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
}

export function countryParam(event: APIGatewayProxyEvent): string | undefined {
    const country = queryParam(event, "country");

    if (country !== undefined && !/^[A-Za-z]{2}$/.test(country)) {
        throw new ValidationError("country must be a two-letter country code");
    }

    return country;
}

/**
 * Runs an API handler in the caller's language, read from Accept-Language, so catalogue items
 * come back with translated titles and descriptions where the catalogue has them.
 */
export function localized<R>(handler: (event: APIGatewayProxyEvent) => Promise<R>): (event: APIGatewayProxyEvent) => Promise<R> {
    return event => runWithLocale(localeFromHeader(headerValue(event, "accept-language")), () => handler(event));
}

/** Header lookup that does not depend on the casing API Gateway kept. */
export function headerValue(event: APIGatewayProxyEvent, name: string): string | undefined {
    const match = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase());

    return match?.[1] ?? undefined;
}

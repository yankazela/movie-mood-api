import { ApiResponse, ResponseService } from "@novha/cdk-lib";
import { ClientError } from "../../services/common/errors";

/**
 * Maps an error thrown by a handler to an API response: a ClientError keeps its own status
 * (400, 401, 404, 422, 429, 503) and any details it carries; anything else is logged and
 * returned as a 500.
 */
export function errorResponse(error: any, responseService: ResponseService, context: string): ApiResponse {
    if (error instanceof ClientError) {
        const response = responseService.clientError(error.message);
        const hasDetails = Object.keys(error.details ?? {}).length > 0;

        if (error.statusCode === 400 && !hasDetails) {
            return response;
        }

        return {
            ...response,
            statusCode: error.statusCode,
            body: JSON.stringify({ status: false, errorMessage: error.message, ...error.details }),
        };
    }

    console.error(`${context}:`, error.message);

    return responseService.failure({ errorMessage: error.message });
}

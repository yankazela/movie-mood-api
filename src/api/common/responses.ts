import { ApiResponse, ResponseService } from "@novha/cdk-lib";
import { ClientError } from "../../services/common/errors";

/**
 * Maps an error thrown by a handler to an API response: a ClientError keeps its own
 * status (400, 401, 404, 422, 429, 503); anything else is logged and returned as a 500.
 */
export function errorResponse(error: any, responseService: ResponseService, context: string): ApiResponse {
    if (error instanceof ClientError) {
        const response = responseService.clientError(error.message);

        return error.statusCode === 400 ? response : { ...response, statusCode: error.statusCode };
    }

    console.error(`${context}:`, error.message);

    return responseService.failure({ errorMessage: error.message });
}

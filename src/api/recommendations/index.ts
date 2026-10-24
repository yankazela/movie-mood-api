import { ApiResponse, ResponseService } from "@novha/cdk-lib";
import { APIGatewayProxyEvent } from "aws-lambda";
import { errorResponse } from "../common/responses";
import { intParam, pathParam, requireUserId } from "../common/request";
import { parseRequest } from "../../services/common/RequestParser";
import { HistoryServiceImpl } from "../../services/recommendations/HistoryServiceImpl";
import { RecommendationServiceImpl } from "../../services/recommendations/RecommendationServiceImpl";
import { EInputType, IRequestFilters } from "../../services/recommendations/domain/types";
import { RecommendRequest } from "../../services/recommendations/dto/RecommendRequest";
import { RecordOutcomeRequest } from "../../services/recommendations/dto/RecordOutcomeRequest";

// Created once per container so the Bedrock, S3 Vectors and DynamoDB clients are reused.
const recommendationService = new RecommendationServiceImpl();
const historyService = new HistoryServiceImpl();

/**
 * POST /recommendations, text path. The route sits behind the Cognito authorizer, so the
 * caller's identity comes from the verified JWT claims rather than the body.
 */
export const recommend = async (event: APIGatewayProxyEvent): Promise<ApiResponse> => {
    const responseService = new ResponseService();

    try {
        const claims: Record<string, string | undefined> = event.requestContext?.authorizer?.claims ?? {};
        const userId = requireUserId(event);
        const request = await parseRequest(event.body, RecommendRequest);
        const filters: IRequestFilters = {
            maxRuntimeMin: request.maxRuntimeMin,
            genres: request.genres,
            releaseYearMin: request.releaseYearMin,
            minRating: request.minRating,
            language: request.language?.toLowerCase(),
        };
        const result = await recommendationService.recommend({
            userId,
            text: request.text,
            objective: request.objective,
            mediaTypes: request.mediaTypes,
            moods: request.moods,
            inputType: EInputType.TEXT,
            // Optional custom claims; the profile is used when the token does not carry them.
            country: claims["custom:country"],
            services: request.services ?? claims["custom:services"]?.split(",").map(service => service.trim()).filter(Boolean),
            filters: Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined)),
        });

        return responseService.success({ ...result });
    } catch (error: any) {
        return errorResponse(error, responseService, "Error recommending movies");
    }
};

/** GET /recommendations/history?limit=. The caller's past requests, newest first, with the titles each returned. */
export const history = async (event: APIGatewayProxyEvent): Promise<ApiResponse> => {
    const responseService = new ResponseService();

    try {
        const entries = await historyService.list(requireUserId(event), intParam(event, "limit"));

        return responseService.success({ entries });
    } catch (error: any) {
        return errorResponse(error, responseService, "Error reading recommendation history");
    }
};

/** PATCH /recommendations/{requestId}. Records the title the caller picked and/or how the results went. */
export const recordOutcome = async (event: APIGatewayProxyEvent): Promise<ApiResponse> => {
    const responseService = new ResponseService();

    try {
        const userId = requireUserId(event);
        const request = await RecordOutcomeRequest.fromBody(event.body);
        const entry = await historyService.recordOutcome(userId, pathParam(event, "requestId"), {
            selectedItemId: request.selectedItemId,
            feedback: request.feedback,
        });

        return responseService.success({ entry });
    } catch (error: any) {
        return errorResponse(error, responseService, "Error recording the recommendation outcome");
    }
};

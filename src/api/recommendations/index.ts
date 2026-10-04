import { ApiResponse, ResponseService } from "@novha/cdk-lib";
import { APIGatewayProxyEvent } from "aws-lambda";
import { errorResponse } from "../common/responses";
import { parseRequest } from "../../services/common/RequestParser";
import { UnauthorizedError } from "../../services/common/errors";
import { RecommendationServiceImpl } from "../../services/recommendations/RecommendationServiceImpl";
import { EInputType } from "../../services/recommendations/domain/types";
import { RecommendRequest } from "../../services/recommendations/dto/RecommendRequest";

// Created once per container so the Bedrock, OpenSearch and DynamoDB clients are reused.
const recommendationService = new RecommendationServiceImpl();

/**
 * POST /recommendations, text path. The route sits behind the Cognito authorizer, so the
 * caller's identity comes from the verified JWT claims rather than the body.
 */
export const recommend = async (event: APIGatewayProxyEvent): Promise<ApiResponse> => {
    const responseService = new ResponseService();

    try {
        const claims: Record<string, string | undefined> = event.requestContext?.authorizer?.claims ?? {};
        const userId = claims.sub;

        if (!userId) {
            throw new UnauthorizedError("Missing or invalid authorization");
        }

        const request = await parseRequest(event.body, RecommendRequest);
        const result = await recommendationService.recommend({
            userId,
            text: request.text,
            objective: request.objective,
            inputType: EInputType.TEXT,
            // Optional custom claims; the profile is used when the token does not carry them.
            country: claims["custom:country"],
            services: claims["custom:services"]?.split(",").map(service => service.trim()).filter(Boolean),
        });

        return responseService.success({ ...result });
    } catch (error: any) {
        return errorResponse(error, responseService, "Error recommending movies");
    }
};

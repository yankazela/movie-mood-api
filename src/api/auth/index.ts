import { ApiResponse, ResponseService } from "@novha/cdk-lib";
import { APIGatewayProxyEvent } from "aws-lambda";
import { errorResponse } from "../common/responses";
import { SessionServiceImpl } from "../../services/auth/SessionServiceImpl";
import { CompleteNewPasswordRequest } from "../../services/auth/dto/CompleteNewPasswordRequest";
import { SignInRequest } from "../../services/auth/dto/SignInRequest";
import { RefreshRequest } from "../../services/auth/dto/RefreshRequest";
import { AuthServiceImpl } from "../../services/auth/AuthServiceImpl";
import { parseRequest } from "../../services/common/RequestParser";

// Created once per container so the Cognito and DynamoDB clients are reused across invocations.
const authService = new AuthServiceImpl();
const sessionService = new SessionServiceImpl(authService);

/**
 * Email/password sign-in. Responds with tokens and the user's profile, or with a challenge and session when
 * Cognito requires the user to set a new password first (invited users on first sign-in).
 * Google and Apple users sign in through Cognito's hosted UI, not through this handler.
 */
export const signIn = async (event: APIGatewayProxyEvent): Promise<ApiResponse> => {
    const responseService = new ResponseService();

    try {
        const request = await parseRequest(event.body, SignInRequest);
        const result = await sessionService.signIn(request);

        return responseService.success({ ...result });
    } catch (error: any) {
        return errorResponse(error, responseService, "Error signing in");
    }
};

/** Completes the NEW_PASSWORD_REQUIRED challenge returned by signIn; responds like a successful signIn. */
export const completeNewPassword = async (event: APIGatewayProxyEvent): Promise<ApiResponse> => {
    const responseService = new ResponseService();

    try {
        const request = await parseRequest(event.body, CompleteNewPasswordRequest);
        const result = await sessionService.completeNewPassword(request);

        return responseService.success({ ...result });
    } catch (error: any) {
        return errorResponse(error, responseService, "Error completing new password");
    }
};

/** Exchanges a refresh token for fresh id and access tokens, so the app can keep a session alive past the one-hour token life. */
export const refresh = async (event: APIGatewayProxyEvent): Promise<ApiResponse> => {
    const responseService = new ResponseService();

    try {
        const request = await parseRequest(event.body, RefreshRequest);
        const result = await authService.refresh(request.refreshToken);

        return responseService.success({ ...result });
    } catch (error: any) {
        return errorResponse(error, responseService, "Error refreshing the session");
    }
};

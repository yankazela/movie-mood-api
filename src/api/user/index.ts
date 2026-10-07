import { ApiResponse, ResponseService } from "@novha/cdk-lib";
import { APIGatewayProxyEvent } from "aws-lambda";
import { errorResponse } from "../common/responses";
import { CreateUserRequest } from "../../services/users/dto/CreateUserRequest";
import { UpdateUserRequest } from "../../services/users/dto/UpdateUserRequest";
import { UnauthorizedError } from "../../services/common/errors";
import { UserServiceImpl } from "../../services/users/UserServiceImpl";

// Created once per container so the AWS SDK clients are reused across invocations.
const userService = new UserServiceImpl();

export const create = async (event: APIGatewayProxyEvent): Promise<ApiResponse> => {
    const responseService = new ResponseService();

    try {
        const request = await CreateUserRequest.fromBody(event.body);
        const user = await userService.createUser(request);

        return responseService.success({ user });
    } catch (error: any) {
        return errorResponse(error, responseService, "Error creating user");
    }
};

/**
 * PATCH /user. Updates the signed-in user's own profile; the route sits behind the Cognito
 * authorizer, so the user is identified by the verified token, never by the body.
 */
export const update = async (event: APIGatewayProxyEvent): Promise<ApiResponse> => {
    const responseService = new ResponseService();

    try {
        const claims: Record<string, string | undefined> = event.requestContext?.authorizer?.claims ?? {};
        const userId = claims.sub;

        if (!userId) {
            throw new UnauthorizedError("Missing or invalid authorization");
        }

        const request = await UpdateUserRequest.fromBody(event.body);
        const user = await userService.updateUser(userId, claims["cognito:username"], request);

        return responseService.success({ user });
    } catch (error: any) {
        return errorResponse(error, responseService, "Error updating user");
    }
};

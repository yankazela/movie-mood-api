import { ApiResponse, ResponseService } from "@novha/cdk-lib";
import { APIGatewayProxyEvent } from "aws-lambda";
import { errorResponse } from "../common/responses";
import { CreateUserRequest } from "../../services/users/dto/CreateUserRequest";
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

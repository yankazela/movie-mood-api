import { PostConfirmationTriggerEvent } from "aws-lambda";
import { identityFromCognitoUser } from "../../services/auth/CognitoIdentity";
import { UserServiceImpl } from "../../services/users/UserServiceImpl";

// Created once per container so the AWS SDK clients are reused across invocations.
const userService = new UserServiceImpl();

/**
 * Cognito post-confirmation trigger. Cognito creates the user pool entry itself for
 * Google, Apple and other federated sign-ins, so this is where their profile gets created.
 * Email/password users are created through the API instead, which does not fire this trigger.
 */
export const handle = async (event: PostConfirmationTriggerEvent): Promise<PostConfirmationTriggerEvent> => {
    if (event.triggerSource !== "PostConfirmation_ConfirmSignUp") {
        return event;
    }

    try {
        const identity = identityFromCognitoUser(event.userName, event.request.userAttributes);
        const user = await userService.createProfile(identity);

        console.log(`Profile ready for ${user.provider} user ${user.userId}`);
    } catch (error: any) {
        // Never block the sign-in: Cognito would reject it and, as the user is already
        // confirmed, would not fire this trigger again. Profile creation is idempotent,
        // so it can be retried from an authenticated endpoint instead.
        console.error(`Failed to create profile for Cognito user ${event.userName}:`, error.message);
    }

    return event;
};

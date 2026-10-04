import {
    AdminCreateUserCommand,
    AdminDeleteUserCommand,
    AdminInitiateAuthCommand,
    AdminRespondToAuthChallengeCommand,
    AdminSetUserPasswordCommand,
    AliasExistsException,
    AuthenticationResultType,
    CognitoIdentityProviderClient,
    InvalidParameterException,
    InvalidPasswordException,
    NotAuthorizedException,
    PasswordResetRequiredException,
    UserNotConfirmedException,
    UserNotFoundException,
    UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";
import { AuthService } from "./AuthService";
import { CognitoUserAttributes, identityFromCognitoUser } from "./CognitoIdentity";
import { EAuthChallenge, ICompleteNewPasswordInput, ISignInInput, ISignInResult } from "./domain/types";
import { IIdentity } from "../users/domain/types";
import { UnauthorizedError, UserAlreadyExistsError, ValidationError } from "../common/errors";

/** The part of Cognito's auth responses that sign-in and challenge completion share. */
interface CognitoAuthOutput {
    ChallengeName?: string;
    Session?: string;
    AuthenticationResult?: AuthenticationResultType;
}

export class AuthServiceImpl implements AuthService {
    private readonly client: CognitoIdentityProviderClient;
    private readonly userPoolId: string;
    private readonly clientId: string;

    constructor(
        client: CognitoIdentityProviderClient = new CognitoIdentityProviderClient({}),
        userPoolId: string = process.env.USER_POOL_ID || "",
        clientId: string = process.env.USER_POOL_CLIENT_ID || "",
    ) {
        this.client = client;
        this.userPoolId = userPoolId;
        this.clientId = clientId;
    }

    public async createUser(email: string, password?: string): Promise<IIdentity> {
        const identity = await this.adminCreateUser(email, Boolean(password));

        if (password) {
            try {
                await this.client.send(new AdminSetUserPasswordCommand({
                    UserPoolId: this.userPoolId,
                    Username: identity.username,
                    Password: password,
                    Permanent: true,
                }));
            } catch (error) {
                // Don't leave behind a user stuck with no usable password.
                await this.deleteUser(identity.username);
                throw this.translate(error, email);
            }
        }

        return identity;
    }

    public async deleteUser(username: string): Promise<void> {
        await this.client.send(new AdminDeleteUserCommand({
            UserPoolId: this.userPoolId,
            Username: username,
        }));
    }

    public async signIn(input: ISignInInput): Promise<ISignInResult> {
        const email = input.email.trim().toLowerCase();

        try {
            const result = await this.client.send(new AdminInitiateAuthCommand({
                UserPoolId: this.userPoolId,
                ClientId: this.clientId,
                AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
                AuthParameters: {
                    USERNAME: email,
                    PASSWORD: input.password,
                },
            }));

            return this.toSignInResult(result, email);
        } catch (error) {
            throw this.translate(error, email);
        }
    }

    public async completeNewPassword(input: ICompleteNewPasswordInput): Promise<ISignInResult> {
        const email = input.email.trim().toLowerCase();

        try {
            const result = await this.client.send(new AdminRespondToAuthChallengeCommand({
                UserPoolId: this.userPoolId,
                ClientId: this.clientId,
                ChallengeName: "NEW_PASSWORD_REQUIRED",
                ChallengeResponses: {
                    USERNAME: email,
                    NEW_PASSWORD: input.newPassword,
                },
                Session: input.session,
            }));

            return this.toSignInResult(result, email);
        } catch (error) {
            throw this.translate(error, email);
        }
    }

    private async adminCreateUser(email: string, suppressInvite: boolean): Promise<IIdentity> {
        try {
            const result = await this.client.send(new AdminCreateUserCommand({
                UserPoolId: this.userPoolId,
                Username: email,
                UserAttributes: [
                    { Name: "email", Value: email },
                    { Name: "email_verified", Value: "true" },
                ],
                // With a caller-supplied password there is no temporary password to deliver.
                MessageAction: suppressInvite ? "SUPPRESS" : undefined,
            }));

            const attributes: CognitoUserAttributes = {};

            for (const attribute of result.User?.Attributes ?? []) {
                if (attribute.Name) {
                    attributes[attribute.Name] = attribute.Value;
                }
            }

            // With email as the sign-in alias Cognito generates its own username.
            return identityFromCognitoUser(result.User?.Username ?? email, attributes);
        } catch (error) {
            throw this.translate(error, email);
        }
    }

    private toSignInResult(result: CognitoAuthOutput, email: string): ISignInResult {
        if (result.ChallengeName) {
            if (result.ChallengeName !== EAuthChallenge.NEW_PASSWORD_REQUIRED || !result.Session) {
                throw new Error(`Unsupported sign-in challenge for ${email}: ${result.ChallengeName}`);
            }

            return {
                outcome: "challenge",
                challenge: EAuthChallenge.NEW_PASSWORD_REQUIRED,
                session: result.Session,
            };
        }

        const tokens = result.AuthenticationResult;

        if (!tokens?.IdToken || !tokens.AccessToken) {
            throw new Error(`Cognito returned no tokens for ${email}`);
        }

        return {
            outcome: "authenticated",
            tokens: {
                idToken: tokens.IdToken,
                accessToken: tokens.AccessToken,
                refreshToken: tokens.RefreshToken,
                expiresIn: tokens.ExpiresIn ?? 3600,
                tokenType: tokens.TokenType ?? "Bearer",
            },
        };
    }

    private translate(error: unknown, email: string): unknown {
        // AliasExistsException covers an email already taken by a federated (Google/Apple) user.
        if (error instanceof UsernameExistsException || error instanceof AliasExistsException) {
            return new UserAlreadyExistsError(email);
        }

        if (error instanceof InvalidPasswordException || error instanceof InvalidParameterException) {
            return new ValidationError((error as Error).message);
        }

        // Cognito's own wording ("Incorrect username or password.", "Invalid session ...") is accurate
        // and does not reveal whether the account exists.
        if (
            error instanceof NotAuthorizedException ||
            error instanceof UserNotConfirmedException ||
            error instanceof PasswordResetRequiredException
        ) {
            return new UnauthorizedError((error as Error).message);
        }

        // Only reachable when the app client does not hide user-existence errors; keep it indistinguishable.
        if (error instanceof UserNotFoundException) {
            return new UnauthorizedError("Incorrect username or password.");
        }

        return error;
    }
}

import { AuthService } from "./AuthService";
import { AuthServiceImpl } from "./AuthServiceImpl";
import { SessionService } from "./SessionService";
import { ICompleteNewPasswordInput, ISignInInput, ISignInResult } from "./domain/types";
import { ISessionResult } from "./domain/session";
import { NotFoundError } from "../common/errors";
import { UserService } from "../users/UserService";
import { UserServiceImpl } from "../users/UserServiceImpl";

/** Signs users in through the auth provider and returns their profile with the tokens. */
export class SessionServiceImpl implements SessionService {
    private readonly authService: AuthService;
    private readonly userService: UserService;

    constructor(authService: AuthService = new AuthServiceImpl(), userService?: UserService) {
        this.authService = authService;
        this.userService = userService ?? new UserServiceImpl(authService);
    }

    public async signIn(input: ISignInInput): Promise<ISessionResult> {
        return this.withProfile(await this.authService.signIn(input));
    }

    public async completeNewPassword(input: ICompleteNewPasswordInput): Promise<ISessionResult> {
        return this.withProfile(await this.authService.completeNewPassword(input));
    }

    private async withProfile(result: ISignInResult): Promise<ISessionResult> {
        if (result.outcome !== "authenticated") {
            return result;
        }

        try {
            return { ...result, user: await this.userService.getUser(result.userId) };
        } catch (error) {
            // The tokens are valid either way; a missing profile should not block sign-in.
            if (error instanceof NotFoundError) {
                console.warn(`Signed-in user ${result.userId} has no profile`);
                return { ...result, user: null };
            }

            throw error;
        }
    }
}

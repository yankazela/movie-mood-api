import { AuthService } from "../auth/AuthService";
import { AuthServiceImpl } from "../auth/AuthServiceImpl";
import { ProfileAlreadyExistsError } from "../common/errors";
import { UserRepository } from "./UserRepository";
import { UserRepositoryImpl } from "./UserRepositoryImpl";
import { UserService } from "./UserService";
import { ICreateUserInput, IIdentity, IProfileInput, IUser } from "./domain/types";

export class UserServiceImpl implements UserService {
    private readonly authService: AuthService;
    private readonly userRepository: UserRepository;

    constructor(
        authService: AuthService = new AuthServiceImpl(),
        userRepository: UserRepository = new UserRepositoryImpl(),
    ) {
        this.authService = authService;
        this.userRepository = userRepository;
    }

    public async createUser(input: ICreateUserInput): Promise<IUser> {
        const email = input.email.trim().toLowerCase();
        const identity = await this.authService.createUser(email, input.password);

        try {
            return await this.createProfile(identity, input);
        } catch (error) {
            await this.rollbackIdentity(identity.username, email);
            throw error;
        }
    }

    public async createProfile(identity: IIdentity, input: IProfileInput = {}): Promise<IUser> {
        const user: IUser = {
            userId: identity.userId,
            email: identity.email,
            provider: identity.provider,
            country: input.country?.toUpperCase(),
            services: input.services ?? [],
            ratingsAllowed: input.ratingsAllowed ?? [],
            genrePrefs: input.genrePrefs ?? {},
            votes: {},
            createdAt: new Date().toISOString(),
            dailyCount: 0,
        };

        try {
            await this.userRepository.create(user);
        } catch (error) {
            if (error instanceof ProfileAlreadyExistsError) {
                const existing = await this.userRepository.findById(identity.userId);

                if (existing) {
                    return existing;
                }
            }

            throw error;
        }

        return user;
    }

    private async rollbackIdentity(username: string, email: string): Promise<void> {
        try {
            await this.authService.deleteUser(username);
        } catch (rollbackError: any) {
            console.error(
                `Failed to remove Cognito user ${email} after the profile could not be saved:`,
                rollbackError.message,
            );
        }
    }
}

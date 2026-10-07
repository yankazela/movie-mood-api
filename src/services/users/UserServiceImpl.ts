import { AuthService } from "../auth/AuthService";
import { AuthServiceImpl } from "../auth/AuthServiceImpl";
import { NotFoundError, ProfileAlreadyExistsError, ValidationError } from "../common/errors";
import { UserRepository } from "./UserRepository";
import { UserRepositoryImpl } from "./UserRepositoryImpl";
import { UserService } from "./UserService";
import { ICreateUserInput, IIdentity, IProfileInput, IUpdateUserInput, IUser, IVote } from "./domain/types";
import { UserFieldChanges } from "./UserRepository";
import { isFullyOnboarded } from "./onboarding";

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
        const fullName = input.fullName.trim();
        const identity = await this.authService.createUser(email, fullName, input.password);

        try {
            return await this.createProfile({ ...identity, fullName }, input);
        } catch (error) {
            await this.rollbackIdentity(identity.username, email);
            throw error;
        }
    }

    public async createProfile(identity: IIdentity, input: IProfileInput = {}): Promise<IUser> {
        const now = new Date().toISOString();
        const user: IUser = {
            userId: identity.userId,
            email: identity.email,
            fullName: identity.fullName,
            provider: identity.provider,
            country: input.country?.toUpperCase(),
            services: input.services ?? [],
            ratingsAllowed: input.ratingsAllowed ?? [],
            genrePrefs: input.genrePrefs ?? {},
            votes: {},
            createdAt: now,
            dailyCount: 0,
            fullyOnboarded: false,
        };

        user.fullyOnboarded = isFullyOnboarded(user);
        user.onboardedAt = user.fullyOnboarded ? now : undefined;

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

    public async updateUser(userId: string, username: string | undefined, input: IUpdateUserInput): Promise<IUser> {
        const current = await this.userRepository.findById(userId);

        if (!current) {
            throw new NotFoundError("No profile found for this user. Complete sign-up first.");
        }

        const now = new Date().toISOString();
        const changes: UserFieldChanges = {
            fullName: input.fullName?.trim(),
            country: input.country?.toUpperCase(),
            services: input.services,
            ratingsAllowed: input.ratingsAllowed,
            genrePrefs: input.genrePrefs,
        };
        const votes: Record<string, IVote> = Object.fromEntries(
            Object.entries(input.votes ?? {}).map(([itemId, vote]) => [itemId, { vote: vote.vote, requestId: vote.requestId, at: now }]),
        );

        if (Object.values(changes).every(value => value === undefined) && Object.keys(votes).length === 0) {
            throw new ValidationError("Provide at least one field to update");
        }

        // Onboarding is derived from the profile as it will be after this update.
        const fullyOnboarded = isFullyOnboarded({
            services: changes.services ?? current.services,
            ratingsAllowed: changes.ratingsAllowed ?? current.ratingsAllowed,
            genrePrefs: changes.genrePrefs ?? current.genrePrefs,
        });
        changes.fullyOnboarded = fullyOnboarded;

        if (fullyOnboarded && !current.onboardedAt) {
            changes.onboardedAt = now;
        }

        const previousName = current.fullName;
        const updated = await this.userRepository.update(userId, changes, votes);

        if (changes.fullName && changes.fullName !== previousName && username) {
            // The profile is the source of truth; a stale token name is not worth failing the update.
            await this.authService.updateName(username, changes.fullName).catch((error: Error) => {
                console.error(`Could not update the Cognito name for ${userId}:`, error.message);
            });
        }

        return updated;
    }

    public async getUser(userId: string): Promise<IUser> {
        const user = await this.userRepository.findById(userId);

        if (!user) {
            throw new NotFoundError("No profile found for this user. Complete sign-up first.");
        }

        // Profiles saved before fullyOnboarded existed get it derived on read.
        return { ...user, fullyOnboarded: user.fullyOnboarded ?? isFullyOnboarded(user) };
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

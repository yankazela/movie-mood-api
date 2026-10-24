import { ulid } from "ulid";
import { CandidateRetriever } from "./CandidateRetriever";
import { Embedder } from "./Embedder";
import { ExplanationService } from "./ExplanationService";
import { MoodResolver } from "./MoodResolver";
import { RecommendationService } from "./RecommendationService";
import { RequestRepository } from "./RequestRepository";
import { BedrockExplanationServiceImpl } from "./BedrockExplanationServiceImpl";
import { BedrockMoodResolverImpl } from "./BedrockMoodResolverImpl";
import { S3VectorsCandidateRetrieverImpl } from "./S3VectorsCandidateRetrieverImpl";
import { UnconfiguredCandidateRetriever } from "./UnconfiguredCandidateRetriever";
import { RequestRepositoryImpl } from "./RequestRepositoryImpl";
import { TitanEmbedderImpl } from "./TitanEmbedderImpl";
import { applyObjective, renderTargetSentence } from "./targeting";
import { rerank, selectDiverse } from "./ranking";
import { expandGenres, expandRatings, expandServices } from "./preferences";
import {
    CANDIDATE_COUNT,
    DEFAULT_SUPPORTIVE_MESSAGE,
    MAX_PER_GENRE,
    REQUEST_TTL_DAYS,
    RESULT_COUNT,
    dailyCapFromEnvironment,
} from "./config";
import {
    EInputType,
    ICandidate,
    IRankedCandidate,
    IRecommendInput,
    IRecommendationResult,
    IRecommendedItem,
    IRequestFilters,
    IRetrievalFilters,
} from "./domain/types";
import { CatalogItemRepository } from "../catalog/store/CatalogItemRepository";
import { CatalogStore } from "../catalog/store/CatalogStore";
import { toRecommendedItem } from "../catalog/presenter";
import { ACTIVE_MEDIA_TYPES } from "../media/MediaType";
import { UserRepository } from "../users/UserRepository";
import { UserRepositoryImpl } from "../users/UserRepositoryImpl";
import { IUser } from "../users/domain/types";
import { NotFoundError, RateLimitError, SafetyError, ValidationError } from "../common/errors";
import { S3VectorsIndexImpl } from "../vectors/S3VectorsIndexImpl";

export interface RecommendationDependencies {
    userRepository?: UserRepository;
    moodResolver?: MoodResolver;
    embedder?: Embedder;
    candidateRetriever?: CandidateRetriever;
    catalogStore?: CatalogItemRepository;
    explanationService?: ExplanationService;
    requestRepository?: RequestRepository;
    dailyCap?: number;
}

export class RecommendationServiceImpl implements RecommendationService {
    private readonly userRepository: UserRepository;
    private readonly moodResolver: MoodResolver;
    private readonly embedder: Embedder;
    private readonly candidateRetriever: CandidateRetriever;
    private readonly catalogStore: CatalogItemRepository;
    private readonly explanationService: ExplanationService;
    private readonly requestRepository: RequestRepository;
    private readonly dailyCap: number;

    constructor(dependencies: RecommendationDependencies = {}) {
        this.userRepository = dependencies.userRepository ?? new UserRepositoryImpl();
        this.moodResolver = dependencies.moodResolver ?? new BedrockMoodResolverImpl();
        this.embedder = dependencies.embedder ?? new TitanEmbedderImpl();
        this.candidateRetriever = dependencies.candidateRetriever ?? defaultCandidateRetriever();
        this.catalogStore = dependencies.catalogStore ?? CatalogStore.fromEnvironment();
        this.explanationService = dependencies.explanationService ?? new BedrockExplanationServiceImpl(this.catalogStore);
        this.requestRepository = dependencies.requestRepository ?? new RequestRepositoryImpl();
        this.dailyCap = dependencies.dailyCap ?? dailyCapFromEnvironment();
    }

    public async recommend(input: IRecommendInput): Promise<IRecommendationResult> {
        const startedAt = new Date();
        const today = startedAt.toISOString().slice(0, 10);

        // Guard: daily cap and profile.
        const user = await this.userRepository.findById(input.userId);

        if (!user) {
            throw new NotFoundError("No profile found for this user. Complete sign-up first.");
        }

        const usedToday = user.dailyCountDate === today ? user.dailyCount : 0;

        if (usedToday >= this.dailyCap) {
            throw new RateLimitError(`Daily limit of ${this.dailyCap} recommendation requests reached. Try again tomorrow.`);
        }

        const country = (input.country ?? user.country)?.toUpperCase();

        if (!country) {
            throw new ValidationError("Set your country in your profile before requesting recommendations.");
        }

        const services = expandServices(input.services ?? user.services ?? []);
        const requested = input.filters ?? {};

        // Resolve: one model call turns the text, and any moods the user ticked, into a mood profile.
        const moodProfile = await this.moodResolver.resolve(resolverText(input.text, input.moods));

        if (moodProfile.safety_flag) {
            throw new SafetyError(moodProfile.supportive_message || DEFAULT_SUPPORTIVE_MESSAGE);
        }

        // Target: apply the objective to the mood vector.
        const target = applyObjective(moodProfile, input.objective);

        // Embed and retrieve, then re-rank; constraints relax if too few titles survive.
        const vector = await this.embedder.embed(renderTargetSentence(target, moodProfile));
        const filters: IRetrievalFilters = {
            mediaTypes: input.mediaTypes?.length ? input.mediaTypes : ACTIVE_MEDIA_TYPES,
            country,
            services,
            ratingsAllowed: expandRatings(country, user.ratingsAllowed ?? []),
            maxRuntimeMin: smallest(moodProfile.constraints.max_runtime_min, requested.maxRuntimeMin),
            genres: requested.genres?.length ? expandGenres(requested.genres) : undefined,
            minYear: requested.releaseYearMin,
        };
        const { chosen, notice } = await this.retrieveAndRank(vector, filters, user, requested);

        // Explain: metadata, availability and why lines.
        const items = await this.catalogStore.findByIds(chosen.map(candidate => candidate.itemId));
        const whyLines = await this.explanationService.explain(items, moodProfile, input.objective);
        const results = chosen.flatMap((candidate): IRecommendedItem[] => {
            const item = items.find(found => found.itemId === candidate.itemId);

            if (!item) {
                return [];
            }

            return [{
                ...toRecommendedItem(item, country),
                why: whyLines.get(item.itemId),
                matchScore: Math.min(99, Math.max(1, Math.round(candidate.score * 100))),
            }];
        });

        // Persist and respond.
        const latencyMs = Date.now() - startedAt.getTime();
        const requestId = ulid(startedAt.getTime());

        await this.requestRepository.save({
            userId: input.userId,
            requestedAt: startedAt.toISOString(),
            requestId,
            inputType: input.inputType ?? EInputType.TEXT,
            text: input.text,
            objective: input.objective,
            moodProfile,
            target,
            resultIds: results.map(result => result.itemId),
            resolver: this.moodResolver.name,
            latencyMs,
            moods: input.moods?.length ? input.moods : undefined,
            filters: Object.keys(requested).length > 0 ? requested : undefined,
            ttl: Math.floor(startedAt.getTime() / 1000) + REQUEST_TTL_DAYS * 24 * 60 * 60,
        });
        await this.userRepository.incrementDailyCount(input.userId, today);

        return { requestId, moodProfile, target, results, notice, latencyMs };
    }

    /**
     * Retrieves with the full filters first. If fewer than RESULT_COUNT titles survive re-ranking,
     * the runtime constraint is dropped, then the rating constraint, each time retrieving again and
     * merging into the candidate pool. A "few_matches" notice is returned if that still falls short.
     */
    private async retrieveAndRank(
        vector: number[],
        filters: IRetrievalFilters,
        user: IUser,
        requested: IRequestFilters,
    ): Promise<{ chosen: IRankedCandidate[]; notice?: "few_matches" }> {
        const personal = { genrePrefs: user.genrePrefs ?? {}, votes: user.votes ?? {}, watched: user.watched ?? [] };
        const pool = new Map<string, ICandidate>();
        let chosen: IRankedCandidate[] = [];

        for (const stage of relaxationStages(filters)) {
            const candidates = await this.meetsScoreAndLanguage(
                await this.candidateRetriever.retrieve(vector, stage, CANDIDATE_COUNT),
                requested,
            );

            for (const candidate of candidates) {
                if (!pool.has(candidate.itemId)) {
                    pool.set(candidate.itemId, candidate);
                }
            }

            chosen = selectDiverse(rerank([...pool.values()], personal), RESULT_COUNT, MAX_PER_GENRE);

            if (chosen.length >= RESULT_COUNT) {
                return { chosen };
            }
        }

        return { chosen, notice: "few_matches" };
    }

    /** Drops candidates whose catalogue entry says they miss the score or language asked for; unknowns pass. */
    private async meetsScoreAndLanguage(candidates: ICandidate[], requested: IRequestFilters): Promise<ICandidate[]> {
        if ((requested.minRating === undefined && !requested.language) || candidates.length === 0) {
            return candidates;
        }

        const items = new Map((await this.catalogStore.findByIds(candidates.map(candidate => candidate.itemId))).map(item => [item.itemId, item]));

        return candidates.filter(candidate => {
            const details = (items.get(candidate.itemId)?.details ?? {}) as { voteAverage?: unknown; originalLanguage?: unknown };

            if (requested.minRating !== undefined && typeof details.voteAverage === "number" && details.voteAverage < requested.minRating) {
                return false;
            }

            return !requested.language || typeof details.originalLanguage !== "string" || details.originalLanguage === requested.language;
        });
    }
}

/** What the mood resolver reads: the user's words, plus the moods they ticked. */
export function resolverText(text: string, moods: string[] | undefined): string {
    return moods?.length ? `${text}\nMoods I selected: ${moods.join(", ")}` : text;
}

function smallest(...values: (number | undefined)[]): number | undefined {
    const defined = values.filter((value): value is number => value !== undefined);

    return defined.length > 0 ? Math.min(...defined) : undefined;
}

function defaultCandidateRetriever(): CandidateRetriever {
    const index = S3VectorsIndexImpl.fromEnvironment();

    return index ? new S3VectorsCandidateRetrieverImpl(index) : new UnconfiguredCandidateRetriever();
}

/** Full filters, then without runtime, then without runtime and rating; identical stages are skipped. */
export function relaxationStages(filters: IRetrievalFilters): IRetrievalFilters[] {
    const stages: IRetrievalFilters[] = [filters];

    if (filters.maxRuntimeMin !== undefined) {
        stages.push({ ...filters, maxRuntimeMin: undefined });
    }

    if (filters.ratingsAllowed.length > 0) {
        stages.push({ ...filters, maxRuntimeMin: undefined, ratingsAllowed: [] });
    }

    return stages;
}

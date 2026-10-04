import { ulid } from "ulid";
import { CandidateRetriever } from "./CandidateRetriever";
import { Embedder } from "./Embedder";
import { ExplanationService } from "./ExplanationService";
import { MoodResolver } from "./MoodResolver";
import { RecommendationService } from "./RecommendationService";
import { RequestRepository } from "./RequestRepository";
import { BedrockExplanationServiceImpl } from "./BedrockExplanationServiceImpl";
import { BedrockMoodResolverImpl } from "./BedrockMoodResolverImpl";
import { OpenSearchCandidateRetrieverImpl, UnconfiguredCandidateRetriever } from "./OpenSearchCandidateRetrieverImpl";
import { RequestRepositoryImpl } from "./RequestRepositoryImpl";
import { TitanEmbedderImpl } from "./TitanEmbedderImpl";
import { applyObjective, renderTargetSentence } from "./targeting";
import { rerank, selectDiverse } from "./ranking";
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
    IRecommendedMovie,
    IRetrievalFilters,
} from "./domain/types";
import { MovieRepository } from "../movies/MovieRepository";
import { MovieRepositoryImpl } from "../movies/MovieRepositoryImpl";
import { UserRepository } from "../users/UserRepository";
import { UserRepositoryImpl } from "../users/UserRepositoryImpl";
import { IUser } from "../users/domain/types";
import { NotFoundError, RateLimitError, SafetyError, ValidationError } from "../common/errors";

export interface RecommendationDependencies {
    userRepository?: UserRepository;
    moodResolver?: MoodResolver;
    embedder?: Embedder;
    candidateRetriever?: CandidateRetriever;
    movieRepository?: MovieRepository;
    explanationService?: ExplanationService;
    requestRepository?: RequestRepository;
    dailyCap?: number;
}

export class RecommendationServiceImpl implements RecommendationService {
    private readonly userRepository: UserRepository;
    private readonly moodResolver: MoodResolver;
    private readonly embedder: Embedder;
    private readonly candidateRetriever: CandidateRetriever;
    private readonly movieRepository: MovieRepository;
    private readonly explanationService: ExplanationService;
    private readonly requestRepository: RequestRepository;
    private readonly dailyCap: number;

    constructor(dependencies: RecommendationDependencies = {}) {
        this.userRepository = dependencies.userRepository ?? new UserRepositoryImpl();
        this.moodResolver = dependencies.moodResolver ?? new BedrockMoodResolverImpl();
        this.embedder = dependencies.embedder ?? new TitanEmbedderImpl();
        this.candidateRetriever = dependencies.candidateRetriever
            ?? OpenSearchCandidateRetrieverImpl.fromEnvironment()
            ?? new UnconfiguredCandidateRetriever();
        this.movieRepository = dependencies.movieRepository ?? new MovieRepositoryImpl();
        this.explanationService = dependencies.explanationService ?? new BedrockExplanationServiceImpl(this.movieRepository);
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

        const services = input.services ?? user.services ?? [];

        // Resolve: one model call turns the text into a mood profile.
        const moodProfile = await this.moodResolver.resolve(input.text);

        if (moodProfile.safety_flag) {
            throw new SafetyError(moodProfile.supportive_message || DEFAULT_SUPPORTIVE_MESSAGE);
        }

        // Target: apply the objective to the mood vector.
        const target = applyObjective(moodProfile, input.objective);

        // Embed and retrieve, then re-rank; constraints relax if too few titles survive.
        const vector = await this.embedder.embed(renderTargetSentence(target, moodProfile));
        const filters: IRetrievalFilters = {
            country,
            services,
            ratingsAllowed: user.ratingsAllowed ?? [],
            maxRuntimeMin: moodProfile.constraints.max_runtime_min,
        };
        const { chosen, notice } = await this.retrieveAndRank(vector, filters, user);

        // Explain: metadata, availability and why lines.
        const movies = await this.movieRepository.findByIds(chosen.map(candidate => candidate.movieId));
        const whyLines = await this.explanationService.explain(movies, moodProfile, input.objective);
        const results = chosen.flatMap((candidate): IRecommendedMovie[] => {
            const movie = movies.find(item => item.movieId === candidate.movieId);

            if (!movie) {
                return [];
            }

            return [{
                movieId: movie.movieId,
                title: movie.title,
                year: movie.year,
                runtime: movie.runtime,
                genres: movie.genres ?? [],
                posterKey: movie.posterKey,
                availability: movie.availability?.[country],
                why: whyLines.get(movie.movieId),
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
            resultIds: results.map(result => result.movieId),
            resolver: this.moodResolver.name,
            latencyMs,
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
    ): Promise<{ chosen: IRankedCandidate[]; notice?: "few_matches" }> {
        const personal = { genrePrefs: user.genrePrefs ?? {}, votes: user.votes ?? {} };
        const pool = new Map<string, ICandidate>();
        let chosen: IRankedCandidate[] = [];

        for (const stage of relaxationStages(filters)) {
            const candidates = await this.candidateRetriever.retrieve(vector, stage, CANDIDATE_COUNT);

            for (const candidate of candidates) {
                if (!pool.has(candidate.movieId)) {
                    pool.set(candidate.movieId, candidate);
                }
            }

            chosen = selectDiverse(rerank([...pool.values()], personal), RESULT_COUNT, MAX_PER_GENRE);

            if (chosen.length >= RESULT_COUNT) {
                return { chosen };
            }
        }

        return { chosen, notice: "few_matches" };
    }
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

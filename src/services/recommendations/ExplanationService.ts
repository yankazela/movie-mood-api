import { EObjective, IMoodProfile } from "./domain/types";
import { IMovie } from "../movies/domain/types";

export interface ExplanationService {
    /**
     * Returns a one-line "why this film" for each movie, by movie id. Fresh cached lines are
     * reused; missing or stale ones are generated and written back to the movie's `why` map.
     */
    explain(movies: IMovie[], mood: IMoodProfile, objective: EObjective): Promise<Map<string, string>>;
}

import {
    ArrayUnique,
    IsArray,
    IsISO31661Alpha2,
    IsNotEmpty,
    IsObject,
    IsOptional,
    IsString,
    MaxLength,
} from "class-validator";
import { ValidationService } from "@novha/cdk-lib";
import { EVote, IUpdateUserInput, IVoteInput } from "../domain/types";
import { EFeedback } from "../../recommendations/domain/types";
import { parseRequest } from "../../common/RequestParser";
import { ValidationError } from "../../common/errors";
import { parseItemId } from "../../media/MediaType";

/** PATCH /user body. Every field is optional; at least one must be present. */
export class UpdateUserRequest extends ValidationService implements IUpdateUserInput {
    @IsOptional()
    @IsString()
    @IsNotEmpty()
    @MaxLength(100)
    fullName?: string;

    @IsOptional()
    @IsString()
    @IsISO31661Alpha2()
    country?: string;

    @IsOptional()
    @IsArray()
    @ArrayUnique()
    @IsString({ each: true })
    services?: string[];

    @IsOptional()
    @IsArray()
    @ArrayUnique()
    @IsString({ each: true })
    ratingsAllowed?: string[];

    @IsOptional()
    @IsObject()
    genrePrefs?: Record<string, number>;

    @IsOptional()
    @IsObject()
    votes?: Record<string, IVoteInput>;

    @IsOptional()
    @IsArray()
    @ArrayUnique()
    @IsString({ each: true })
    myMovies?: string[];

    @IsOptional()
    @IsArray()
    @ArrayUnique()
    @IsString({ each: true })
    watched?: string[];

    @IsOptional()
    @IsObject()
    ratings?: Record<string, EFeedback>;

    @IsOptional()
    @IsArray()
    @ArrayUnique()
    @IsString({ each: true })
    removeVotes?: string[];

    /** Parses and validates a raw API Gateway body. Throws ValidationError on bad input. */
    public static async fromBody(body: string | null): Promise<UpdateUserRequest> {
        const request = await parseRequest(body, UpdateUserRequest);
        const errors = [
            ...genrePrefErrors(request.genrePrefs),
            ...voteErrors(request.votes),
            ...itemIdErrors("myMovies", request.myMovies),
            ...itemIdErrors("watched", request.watched),
            ...itemIdErrors("removeVotes", request.removeVotes),
            ...ratingErrors(request.ratings),
        ];

        if (errors.length > 0) {
            throw new ValidationError(errors.join(", "));
        }

        return request;
    }
}

function genrePrefErrors(genrePrefs: Record<string, unknown> | undefined): string[] {
    return Object.entries(genrePrefs ?? {})
        .filter(([genre, weight]) => !genre.trim() || typeof weight !== "number" || weight < 0 || weight > 1)
        .map(([genre]) => `genrePrefs.${genre} must be a number between 0 and 1`);
}

function itemIdErrors(field: string, itemIds: string[] | undefined): string[] {
    const errors: string[] = [];

    for (const itemId of itemIds ?? []) {
        try {
            parseItemId(itemId);
        } catch {
            errors.push(`${field} entry ${itemId} is not a valid item id`);
        }
    }

    return errors;
}

function ratingErrors(ratings: Record<string, unknown> | undefined): string[] {
    const errors: string[] = [];

    for (const [itemId, rating] of Object.entries(ratings ?? {})) {
        try {
            parseItemId(itemId);
        } catch {
            errors.push(`ratings key ${itemId} is not a valid item id`);
            continue;
        }

        if (!Object.values(EFeedback).includes(rating as EFeedback)) {
            errors.push(`ratings.${itemId} must be one of: ${Object.values(EFeedback).join(", ")}`);
        }
    }

    return errors;
}

function voteErrors(votes: Record<string, unknown> | undefined): string[] {
    const errors: string[] = [];

    for (const [itemId, vote] of Object.entries(votes ?? {})) {
        try {
            parseItemId(itemId);
        } catch {
            errors.push(`votes key ${itemId} is not a valid item id`);
            continue;
        }

        const { vote: value, requestId } = (vote ?? {}) as Partial<IVoteInput>;

        if (!Object.values(EVote).includes(value as EVote)) {
            errors.push(`votes.${itemId}.vote must be one of: ${Object.values(EVote).join(", ")}`);
        }

        if (requestId !== undefined && (typeof requestId !== "string" || !requestId.trim())) {
            errors.push(`votes.${itemId}.requestId must be a non-empty string when given`);
        }
    }

    return errors;
}

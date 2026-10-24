import {
    ArrayMaxSize,
    ArrayUnique,
    IsArray,
    IsEnum,
    IsIn,
    IsInt,
    IsNumber,
    IsOptional,
    IsString,
    Length,
    Max,
    MaxLength,
    Min,
} from "class-validator";
import { ValidationService } from "@novha/cdk-lib";
import { EObjective } from "../domain/types";
import { ACTIVE_MEDIA_TYPES, EMediaType } from "../../media/MediaType";

export class RecommendRequest extends ValidationService {
    /** What the user said about how they feel. */
    @IsString()
    @Length(3, 500)
    text: string;

    @IsEnum(EObjective)
    objective: EObjective;

    /** Which media to recommend. Omit for all active types. Only active types are accepted. */
    @IsOptional()
    @IsArray()
    @ArrayUnique()
    @IsIn(ACTIVE_MEDIA_TYPES, { each: true })
    mediaTypes?: EMediaType[];

    /** Moods the user ticked in the app, e.g. "tired". Shown to the mood resolver and kept in the history. */
    @IsOptional()
    @IsArray()
    @ArrayUnique()
    @ArrayMaxSize(8)
    @IsString({ each: true })
    @MaxLength(40, { each: true })
    moods?: string[];

    /** Overrides the profile's streaming services for this request. */
    @IsOptional()
    @IsArray()
    @ArrayUnique()
    @ArrayMaxSize(30)
    @IsString({ each: true })
    services?: string[];

    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(600)
    maxRuntimeMin?: number;

    @IsOptional()
    @IsArray()
    @ArrayUnique()
    @ArrayMaxSize(20)
    @IsString({ each: true })
    @MaxLength(40, { each: true })
    genres?: string[];

    @IsOptional()
    @IsInt()
    @Min(1888)
    @Max(2100)
    releaseYearMin?: number;

    @IsOptional()
    @IsNumber()
    @Min(0)
    @Max(10)
    minRating?: number;

    /** ISO 639-1 code of the original language. */
    @IsOptional()
    @IsString()
    @Length(2, 3)
    language?: string;
}

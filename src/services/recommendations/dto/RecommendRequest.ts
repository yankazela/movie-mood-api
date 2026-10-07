import { ArrayUnique, IsArray, IsEnum, IsIn, IsOptional, IsString, Length } from "class-validator";
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
}

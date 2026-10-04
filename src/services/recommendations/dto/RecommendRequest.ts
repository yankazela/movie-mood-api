import { IsEnum, IsString, Length } from "class-validator";
import { ValidationService } from "@novha/cdk-lib";
import { EObjective } from "../domain/types";

export class RecommendRequest extends ValidationService {
    /** What the user said about how they feel. */
    @IsString()
    @Length(3, 500)
    text: string;

    @IsEnum(EObjective)
    objective: EObjective;
}

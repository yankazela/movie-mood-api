import { IsEnum, IsOptional, IsString, MaxLength } from "class-validator";
import { ValidationService } from "@novha/cdk-lib";
import { EFeedback } from "../domain/types";
import { parseRequest } from "../../common/RequestParser";
import { ValidationError } from "../../common/errors";
import { parseItemId } from "../../media/MediaType";

/** PATCH /recommendations/{requestId} body: what the user did with the results. At least one field is required. */
export class RecordOutcomeRequest extends ValidationService {
    /** The title they chose to watch; must be one of the request's results. */
    @IsOptional()
    @IsString()
    @MaxLength(200)
    selectedItemId?: string;

    @IsOptional()
    @IsEnum(EFeedback)
    feedback?: EFeedback;

    public static async fromBody(body: string | null): Promise<RecordOutcomeRequest> {
        const request = await parseRequest(body, RecordOutcomeRequest);

        if (request.selectedItemId === undefined && request.feedback === undefined) {
            throw new ValidationError("Provide selectedItemId or feedback");
        }

        if (request.selectedItemId !== undefined) {
            try {
                parseItemId(request.selectedItemId);
            } catch {
                throw new ValidationError(`selectedItemId ${request.selectedItemId} is not a valid item id`);
            }
        }

        return request;
    }
}

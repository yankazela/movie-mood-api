import {
    ArrayUnique,
    IsArray,
    IsEmail,
    IsISO31661Alpha2,
    IsObject,
    IsOptional,
    IsNotEmpty,
    IsString,
    MaxLength,
    MinLength,
} from "class-validator";
import { ValidationService } from "@novha/cdk-lib";
import { ICreateUserInput } from "../domain/types";
import { parseRequest } from "../../common/RequestParser";

export class CreateUserRequest extends ValidationService implements ICreateUserInput {
    @IsEmail()
    email: string;

    @IsString()
    @IsNotEmpty()
    @MaxLength(100)
    fullName: string;

    @IsString()
    @IsISO31661Alpha2()
    country: string;

    @IsOptional()
    @IsString()
    @MinLength(8)
    password?: string;

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

    /** Parses and validates a raw API Gateway body. Throws ValidationError on bad input. */
    public static fromBody(body: string | null): Promise<CreateUserRequest> {
        return parseRequest(body, CreateUserRequest);
    }
}

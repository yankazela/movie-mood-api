import { IsEmail, IsString, MinLength } from "class-validator";
import { ValidationService } from "@novha/cdk-lib";
import { ISignInInput } from "../domain/types";

export class SignInRequest extends ValidationService implements ISignInInput {
    @IsEmail()
    email: string;

    @IsString()
    @MinLength(1)
    password: string;
}

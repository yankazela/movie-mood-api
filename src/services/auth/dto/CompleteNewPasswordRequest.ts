import { IsEmail, IsString, MinLength } from "class-validator";
import { ValidationService } from "@novha/cdk-lib";
import { ICompleteNewPasswordInput } from "../domain/types";

export class CompleteNewPasswordRequest extends ValidationService implements ICompleteNewPasswordInput {
    @IsEmail()
    email: string;

    @IsString()
    @MinLength(8)
    newPassword: string;

    @IsString()
    @MinLength(1)
    session: string;
}

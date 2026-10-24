import { IsNotEmpty, IsString } from "class-validator";
import { ValidationService } from "@novha/cdk-lib";

export class RefreshRequest extends ValidationService {
    @IsString()
    @IsNotEmpty()
    refreshToken: string;
}

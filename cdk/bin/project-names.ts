import { StackProps} from "aws-cdk-lib";
export const projectName = 'movie-mood';

export interface CommonProps extends StackProps {
    stage: string;
    projectName: string;
    env: {
        account: string;
        region: string;
    },
    /** Short role of the stack within the app, e.g. "storage" or "auth". */
    name?: string;
}
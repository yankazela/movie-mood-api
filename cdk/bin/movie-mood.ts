import 'source-map-support/register';
import { App } from 'aws-cdk-lib';
import { MovieMoodApiStack } from '../lib/app/movie-mood-stack';
import { projectName } from './project-names';

const app = new App();
const stage = (app.node.tryGetContext('stage') as string) || "dev";

new MovieMoodApiStack(app, `${projectName}-stack-${stage}`, {
    projectName,
    stage,
    name: "api",
    env: {
        account: process.env.CDK_DEFAULT_ACCOUNT || "",
        region: process.env.CDK_DEFAULT_REGION || "us-east-1"
    },
});

app.synth();

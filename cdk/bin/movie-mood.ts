import 'source-map-support/register';
import { App } from 'aws-cdk-lib';
import { MovieMoodApiStack } from '../lib/app/movie-mood-stack';
import { MovieMoodCatalogStack } from '../lib/app/catalog-stack';
import { projectName } from './project-names';

const app = new App();
const stage = (app.node.tryGetContext('stage') as string) || "dev";
const stackProps = {
    projectName,
    stage,
    env: {
        account: process.env.CDK_DEFAULT_ACCOUNT || "",
        region: process.env.CDK_DEFAULT_REGION || "us-east-1"
    },
};

new MovieMoodApiStack(app, `${projectName}-stack-${stage}`, { ...stackProps, name: "api" });
new MovieMoodCatalogStack(app, `${projectName}-catalog-${stage}`, { ...stackProps, name: "catalog" });

app.synth();

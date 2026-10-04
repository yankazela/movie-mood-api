import { App } from 'aws-cdk-lib';
import { projectName } from './project-names';
import { StorageStack } from '../lib/infrastructure/storages-stack';
import { AuthStack } from '../lib/infrastructure/auth-stack';

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

const storage = new StorageStack(app, `${projectName}-storage-${stage}`, { ...stackProps, name: "storage" });

new AuthStack(app, `${projectName}-auth-${stage}`, {
    ...stackProps,
    name: "auth",
    usersTable: storage.users,
});

app.synth();

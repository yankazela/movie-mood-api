import path = require("path");
import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { AccountRecovery, UserPool, UserPoolClient, UserPoolOperation } from 'aws-cdk-lib/aws-cognito';
import { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { Code, Function, Runtime } from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { CommonProps } from '../../bin/project-names';

export interface AuthStackProps extends CommonProps {
	/** Users table that receives a profile for every confirmed identity. */
	usersTable: ITable;
}

export class AuthStack extends Stack {
	public readonly userPool: UserPool;
	public readonly apiClient: UserPoolClient;

	constructor(scope: Construct, id: string, props: AuthStackProps) {
		super(scope, id, props);

		// Email/password users are created server-side by the create-user API, so self
		// sign-up stays off. Federated sign-in (Google, Apple) is unaffected by this flag.
		this.userPool = new UserPool(this, 'UserPool', {
			userPoolName: `${props.projectName}-users-${props.stage}`,
			selfSignUpEnabled: false,
			signInAliases: { email: true },
			autoVerify: { email: true },
			standardAttributes: {
				email: { required: true, mutable: true },
			},
			accountRecovery: AccountRecovery.EMAIL_ONLY,
			removalPolicy: RemovalPolicy.RETAIN,
		});

		// App client used by the sign-in API. ADMIN_USER_PASSWORD_AUTH lets the backend verify
		// a password server-side; SRP is enabled for clients that sign in with the Cognito SDK.
		// No client secret: the admin flow is called from Lambda with IAM, not from devices.
		this.apiClient = this.userPool.addClient('ApiClient', {
			userPoolClientName: `${props.projectName}-api-${props.stage}`,
			authFlows: { adminUserPassword: true, userSrp: true },
			generateSecret: false,
			// Report wrong email and wrong password identically, so callers can't probe for accounts.
			preventUserExistenceErrors: true,
		});

		// Cognito creates the user pool entry itself for Google/Apple sign-ins, so their
		// profile is created from this trigger rather than through the create-user API.
		// The bundle is produced by `npm run build` from src/api/user-confirmed.
		const userConfirmedHandler = new Function(this, 'UserConfirmedHandler', {
			runtime: Runtime.NODEJS_22_X,
			handler: 'index.handle',
			code: Code.fromAsset(path.resolve(__dirname, '../../../dist/api/user-confirmed')),
			// Cognito waits at most 5 seconds for a trigger to respond.
			timeout: Duration.seconds(5),
			memorySize: 512,
			environment: {
				USERS_TABLE_NAME: props.usersTable.tableName,
			},
		});
		props.usersTable.grantReadWriteData(userConfirmedHandler);
		this.userPool.addTrigger(UserPoolOperation.POST_CONFIRMATION, userConfirmedHandler);

		new CfnOutput(this, 'UserPoolId', {
			value: this.userPool.userPoolId,
			exportName: `${props.projectName}-UserPoolId-${props.stage}`,
		});

		new CfnOutput(this, 'UserPoolArn', {
			value: this.userPool.userPoolArn,
			exportName: `${props.projectName}-UserPoolArn-${props.stage}`,
		});

		new CfnOutput(this, 'UserPoolClientId', {
			value: this.apiClient.userPoolClientId,
			exportName: `${props.projectName}-UserPoolClientId-${props.stage}`,
		});
	}
}

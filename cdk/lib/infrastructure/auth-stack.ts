import path = require("path");
import { CfnOutput, CfnParameter, Duration, RemovalPolicy, SecretValue, Stack } from 'aws-cdk-lib';
import { AccountRecovery, UserPool, UserPoolClient, UserPoolOperation, UserPoolIdentityProviderGoogle, ProviderAttribute, UserPoolClientIdentityProvider, OAuthScope } from 'aws-cdk-lib/aws-cognito';
import { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { Code, Function, Runtime } from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { CommonProps } from '../../bin/project-names';

export interface AuthStackProps extends CommonProps {
	/** Users table that receives a profile for every confirmed identity. */
	usersTable: ITable;
	/** HTTPS origin of the deployed frontend, without a trailing slash. Cognito rejects http:// URLs other than localhost. */
	frontendUrl: string;
}

export class AuthStack extends Stack {
	public readonly userPool: UserPool;
	public readonly apiClient: UserPoolClient;

	constructor(scope: Construct, id: string, props: AuthStackProps) {
		super(scope, id, props);

		const googleClientId = new CfnParameter(this, "GoogleClientId", {
			type: "String",
			description: "Google OAuth client ID",
			minLength: 1,
		});

		// noEcho keeps the secret out of the console, describe-stacks output and synthesized templates.
		const googleClientSecret = new CfnParameter(this, "GoogleClientSecret", {
			type: "String",
			description: "Google OAuth client secret",
			noEcho: true,
			minLength: 1,
		});

		// Self sign-up is on so the hosted UI can register email/password users too. Those users
		// get their profile from the post-confirmation trigger, like Google users, without a country.
		this.userPool = new UserPool(this, 'UserPool', {
			userPoolName: `${props.projectName}-users-${props.stage}`,
			selfSignUpEnabled: true,
			signInAliases: { email: true },
			autoVerify: { email: true },
			// Only email is declared. Standard attributes such as `name` are always available, and
			// Cognito rejects schema changes on an existing pool, so don't add attributes here.
			standardAttributes: {
				email: { required: true, mutable: true },
			},
			accountRecovery: AccountRecovery.EMAIL_ONLY,
			removalPolicy: RemovalPolicy.RETAIN,
		});

		// Hosted UI domain: https://movie-mood-dev.auth.<region>.amazoncognito.com
		const domain = this.userPool.addDomain('Domain', {
			cognitoDomain: { domainPrefix: `${props.projectName}-${props.stage}` },
		});

		const google = new UserPoolIdentityProviderGoogle(this, 'Google', {
			userPool: this.userPool,
			clientId: googleClientId.valueAsString,
			clientSecretValue: SecretValue.cfnParameter(googleClientSecret),
			scopes: ['openid', 'email', 'profile'],
			attributeMapping: {
				email: ProviderAttribute.GOOGLE_EMAIL,
				fullname: ProviderAttribute.GOOGLE_NAME,
				profilePicture: ProviderAttribute.GOOGLE_PICTURE,
			},
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
			supportedIdentityProviders: [
				UserPoolClientIdentityProvider.GOOGLE,
				UserPoolClientIdentityProvider.COGNITO, // keep if you also want email/password
			],
			oAuth: {
				flows: { authorizationCodeGrant: true },
				scopes: [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE],
				// The exported site uses trailing slashes (/auth/callback/), and Cognito matches URLs exactly.
				callbackUrls: [
					'http://localhost:3000/',
					'http://localhost:3000/auth/callback',
					props.frontendUrl,
					`${props.frontendUrl}/`,
					`${props.frontendUrl}/auth/callback`,
					`${props.frontendUrl}/auth/callback/`,
					// The iOS and Android apps: the Hosted UI opens in the system browser and comes back by URL scheme.
					'upmymood://auth/callback',
				],
				logoutUrls: [
					'http://localhost:3000/',
					'http://localhost:3000/login',
					`${props.frontendUrl}/`,
					`${props.frontendUrl}/login`,
					`${props.frontendUrl}/login/`,
				],
			}
		});
		// The client names Google as a provider, so the provider must exist first or the deploy fails.
		this.apiClient.node.addDependency(google);

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

		new CfnOutput(this, 'HostedUiDomain', {
			value: domain.baseUrl(),
			description: 'Base URL of the Cognito hosted UI; add it as an authorised redirect origin in Google Cloud',
		});
	}
}

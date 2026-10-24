import path = require("path");
import { Stack, Duration, Fn } from "aws-cdk-lib";
import { Function } from "aws-cdk-lib/aws-lambda";
import { Lambda, Network, CommonProps} from "@novha/cdk-lib";
import { Construct } from "constructs";
import { VECTOR_INDEX_NAME, vectorBucketName, vectorIndexArn as buildVectorIndexArn } from "../shared/vector-store";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Table } from "aws-cdk-lib/aws-dynamodb";
import { UserPool } from "aws-cdk-lib/aws-cognito";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import {
	AuthorizationType,
	CognitoUserPoolsAuthorizer,
	LambdaIntegration,
	RestApi,
	CfnAuthorizer,
	IResource,
	ResponseType
} from "aws-cdk-lib/aws-apigateway";


export class MovieMoodApiStack extends Stack {
	private readonly apiGateway: RestApi;

	constructor(scope: Construct, id: string, props: CommonProps) {
		super(scope, id, props);

		const resourcePath = '/api/v1/movie-mood';

		this.apiGateway = new RestApi(this, "ApiGateway", {
            restApiName: `${props.projectName}-gateway-${props.stage}`,
            description: "Soccer API Gateway",
			deployOptions: {
				stageName: props.stage,
			},
			defaultCorsPreflightOptions: {
                allowOrigins: ['*'],
                allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
                allowHeaders: ['Content-Type', 'X-Amz-Date', 'Authorization', 'X-Api-Key', 'X-Amz-Security-Token'],
            },
        });

		// Errors API Gateway raises itself (a rejected token, a throttled call) never reach a Lambda, so
		// they carry no CORS headers unless added here; without them the browser hides the 401 the app
		// needs to see in order to refresh an expired session.
		const corsHeaders = {
			'Access-Control-Allow-Origin': "'*'",
			'Access-Control-Allow-Headers': "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'",
		};
		this.apiGateway.addGatewayResponse('Default4xx', { type: ResponseType.DEFAULT_4XX, responseHeaders: corsHeaders });
		this.apiGateway.addGatewayResponse('Default5xx', { type: ResponseType.DEFAULT_5XX, responseHeaders: corsHeaders });

		const rootResource = this.apiGateway.root;
		const baseResource = rootResource.resourceForPath(resourcePath);
        
		const lambdaIndex = "index.fetch";
		// @novha/cdk-lib resolves `folder` relative to its own dist/lambda directory inside
		// node_modules, so derive the hop from there to this project's dist/api instead of
		// hard-coding "../" segments that break whenever the package's install depth changes.
		const novhaLambdaDir = path.join(path.dirname(require.resolve("@novha/cdk-lib")), "lambda");
		const buildFolder = path.relative(novhaLambdaDir, path.resolve(__dirname, "../../../dist/api"));
		// No VPC for now: @novha/cdk-lib's Network imports the `predikt-global-config-vpc-<stage>`,
		// `-subnets-` and `-azs-` exports, which this account does not provide. Handlers run outside
		// a VPC until those exports exist; pass a Network to createHandler to opt a handler in.
		// const userPoolArn = Fn.importValue(`UserPoolArn-${props.stage}`);
		// const secretname = Fn.importValue(`predikt-global-config-SecretName-${props.stage}`);
		// const redisEndpoint = Fn.importValue(`RedisEndpoint${props.stage}`);
		// const redisPort = Fn.importValue(`RedisPort${props.stage}`);

		const pingHandler = this.createHandler(
            "index.get",
            path.join(buildFolder, "ping"),
            `${props.projectName}-ping-${props.stage}`
		);

		baseResource
			.addResource('ping')
			.addMethod(
				'GET',
				new LambdaIntegration(pingHandler)
			);

		// Users table and user pool come from the infrastructure app (storage + auth stacks).
		const usersTable = Table.fromTableArn(
			this,
			"UsersTable",
			Fn.importValue(`${props.projectName}-UsersTableArn-${props.stage}`)
		);
		// Profiles are returned with their saved movies, read from the Movies table.
		const moviesTable = Table.fromTableArn(
			this,
			"MoviesTable",
			Fn.importValue(`${props.projectName}-MoviesTableArn-${props.stage}`)
		);
		const moviesTableName = Fn.importValue(`${props.projectName}-MoviesTableName-${props.stage}`);
		const userPool = UserPool.fromUserPoolArn(
			this,
			"UserPool",
			Fn.importValue(`${props.projectName}-UserPoolArn-${props.stage}`)
		);

		const createUserHandler = this.createHandler(
            "index.create",
            path.join(buildFolder, "user"),
            `${props.projectName}-create-user-${props.stage}`,
            {
                USERS_TABLE_NAME: Fn.importValue(`${props.projectName}-UsersTableName-${props.stage}`),
                USER_POOL_ID: userPool.userPoolId,
            }
		);
		usersTable.grantReadWriteData(createUserHandler);
		userPool.grant(
			createUserHandler,
			"cognito-idp:AdminCreateUser",
			"cognito-idp:AdminSetUserPassword",
			"cognito-idp:AdminDeleteUser"
		);

		// API Gateway validates the Cognito JWT on authenticated routes; handlers read the caller's
		// identity from the verified claims rather than from the body.
		const authorizer = new CognitoUserPoolsAuthorizer(this, "CognitoAuthorizer", {
			cognitoUserPools: [userPool],
		});

		const updateUserHandler = this.createHandler(
            "index.update",
            path.join(buildFolder, "user"),
            `${props.projectName}-update-user-${props.stage}`,
            {
                USERS_TABLE_NAME: Fn.importValue(`${props.projectName}-UsersTableName-${props.stage}`),
                MOVIES_TABLE_NAME: moviesTableName,
                USER_POOL_ID: userPool.userPoolId,
            }
		);
		usersTable.grantReadWriteData(updateUserHandler);
		moviesTable.grantReadData(updateUserHandler);
		userPool.grant(updateUserHandler, "cognito-idp:AdminUpdateUserAttributes");

		const userResource = baseResource.addResource('user');
		userResource.addMethod('POST', new LambdaIntegration(createUserHandler));
		userResource.addMethod('PATCH', new LambdaIntegration(updateUserHandler), {
			authorizer,
			authorizationType: AuthorizationType.COGNITO,
		});

		const meHandler = this.createHandler(
            "index.me",
            path.join(buildFolder, "user"),
            `${props.projectName}-get-me-${props.stage}`,
            {
                USERS_TABLE_NAME: Fn.importValue(`${props.projectName}-UsersTableName-${props.stage}`),
                MOVIES_TABLE_NAME: moviesTableName,
                USER_POOL_ID: userPool.userPoolId,
            }
		);
		usersTable.grantReadData(meHandler);
		moviesTable.grantReadData(meHandler);
		userResource.addResource('me').addMethod('GET', new LambdaIntegration(meHandler), {
			authorizer,
			authorizationType: AuthorizationType.COGNITO,
		});

		// Email/password sign-in. Google/Apple users sign in through Cognito's hosted UI instead.
		// Both handlers come from the same bundle (src/api/auth).
		const authEnvironment = {
			USERS_TABLE_NAME: Fn.importValue(`${props.projectName}-UsersTableName-${props.stage}`),
			MOVIES_TABLE_NAME: moviesTableName,
			USER_POOL_ID: userPool.userPoolId,
			USER_POOL_CLIENT_ID: Fn.importValue(`${props.projectName}-UserPoolClientId-${props.stage}`),
		};
		const signInHandler = this.createHandler(
            "index.signIn",
            path.join(buildFolder, "auth"),
            `${props.projectName}-signin-${props.stage}`,
            authEnvironment
		);
		const newPasswordHandler = this.createHandler(
            "index.completeNewPassword",
            path.join(buildFolder, "auth"),
            `${props.projectName}-new-password-${props.stage}`,
            authEnvironment
		);
		userPool.grant(signInHandler, "cognito-idp:AdminInitiateAuth");
		userPool.grant(newPasswordHandler, "cognito-idp:AdminRespondToAuthChallenge");
		// Refresh-token sign-in lets the app keep a session alive without asking for the password again.
		const refreshHandler = this.createHandler(
            "index.refresh",
            path.join(buildFolder, "auth"),
            `${props.projectName}-refresh-${props.stage}`,
            {
                USER_POOL_ID: userPool.userPoolId,
                USER_POOL_CLIENT_ID: Fn.importValue(`${props.projectName}-UserPoolClientId-${props.stage}`),
                USERS_TABLE_NAME: Fn.importValue(`${props.projectName}-UsersTableName-${props.stage}`),
                MOVIES_TABLE_NAME: moviesTableName,
            }
		);
		userPool.grant(refreshHandler, "cognito-idp:AdminInitiateAuth");
		// Both return the signed-in user's profile alongside the tokens.
		usersTable.grantReadData(signInHandler);
		usersTable.grantReadData(newPasswordHandler);
		moviesTable.grantReadData(signInHandler);
		moviesTable.grantReadData(newPasswordHandler);

		const authResource = baseResource.addResource('auth');
		authResource
			.addResource('signin')
			.addMethod('POST', new LambdaIntegration(signInHandler));
		authResource
			.addResource('new-password')
			.addMethod('POST', new LambdaIntegration(newPasswordHandler));
		authResource
			.addResource('refresh')
			.addMethod('POST', new LambdaIntegration(refreshHandler));

		// Recommendations, text path, behind the same Cognito authorizer.
		const requestsTable = Table.fromTableArn(
			this,
			"RequestsTable",
			Fn.importValue(`${props.projectName}-RequestsTableArn-${props.stage}`)
		);
		// Embeddings are queried from the S3 Vectors index owned by the storage stack. Its names are
		// computed, not imported, so the storage stack stays free to change them.
		const vectorIndexArn = buildVectorIndexArn(props, this.region, this.account);

		const recommendHandler = this.createHandler(
            "index.recommend",
            path.join(buildFolder, "recommendations"),
            `${props.projectName}-recommend-${props.stage}`,
            {
                USERS_TABLE_NAME: Fn.importValue(`${props.projectName}-UsersTableName-${props.stage}`),
                REQUESTS_TABLE_NAME: Fn.importValue(`${props.projectName}-RequestsTableName-${props.stage}`),
                MOVIES_TABLE_NAME: moviesTableName,
                MOOD_MODEL_ID: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
                EMBEDDING_MODEL_ID: "amazon.titan-embed-text-v2:0",
                DAILY_REQUEST_CAP: "20",
                VECTOR_BUCKET_NAME: vectorBucketName(props),
                VECTOR_INDEX_NAME: VECTOR_INDEX_NAME,
            },
            undefined,
            1024
		);
		usersTable.grantReadWriteData(recommendHandler);
		requestsTable.grantWriteData(recommendHandler);
		moviesTable.grantReadWriteData(recommendHandler);
		// Bedrock runtime: Claude Haiku 4.5 through its US cross-region inference profile (which needs
		// the profile plus the underlying model in every region it routes to) and Titan embeddings.
		recommendHandler.addToRolePolicy(new PolicyStatement({
			actions: ["bedrock:InvokeModel"],
			resources: [
				`arn:aws:bedrock:${this.region}:${this.account}:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0`,
				"arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0",
				`arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
			],
		}));
		// Filtered queries need GetVectors as well as QueryVectors.
		recommendHandler.addToRolePolicy(new PolicyStatement({
			actions: ["s3vectors:QueryVectors", "s3vectors:GetVectors"],
			resources: [vectorIndexArn],
		}));

		const authorized = { authorizer, authorizationType: AuthorizationType.COGNITO };
		const recommendationsResource = baseResource.addResource('recommendations');
		recommendationsResource.addMethod('POST', new LambdaIntegration(recommendHandler), authorized);

		// History: the caller's past requests, and what they did with each one.
		const historyEnvironment = {
			USERS_TABLE_NAME: Fn.importValue(`${props.projectName}-UsersTableName-${props.stage}`),
			REQUESTS_TABLE_NAME: Fn.importValue(`${props.projectName}-RequestsTableName-${props.stage}`),
			MOVIES_TABLE_NAME: moviesTableName,
		};
		const historyHandler = this.createHandler(
			"index.history",
			path.join(buildFolder, "recommendations"),
			`${props.projectName}-history-${props.stage}`,
			historyEnvironment
		);
		const outcomeHandler = this.createHandler(
			"index.recordOutcome",
			path.join(buildFolder, "recommendations"),
			`${props.projectName}-recommendation-outcome-${props.stage}`,
			historyEnvironment
		);
		for (const handler of [historyHandler, outcomeHandler]) {
			usersTable.grantReadData(handler);
			moviesTable.grantReadData(handler);
		}
		requestsTable.grantReadData(historyHandler);
		requestsTable.grantReadWriteData(outcomeHandler);
		recommendationsResource.addResource('history').addMethod('GET', new LambdaIntegration(historyHandler), authorized);
		recommendationsResource.addResource('{requestId}').addMethod('PATCH', new LambdaIntegration(outcomeHandler), authorized);

		// Catalogue lookups: by id, by search and by popularity. The four handlers share one bundle.
		const moviesEnvironment = {
			USERS_TABLE_NAME: Fn.importValue(`${props.projectName}-UsersTableName-${props.stage}`),
			MOVIES_TABLE_NAME: moviesTableName,
		};
		const moviesResource = baseResource.addResource('movies');
		const movieRoutes: { handler: string; name: string; resource: IResource }[] = [
			{ handler: "index.getMany", name: "get-movies", resource: moviesResource },
			{ handler: "index.search", name: "search-movies", resource: moviesResource.addResource('search') },
			{ handler: "index.popular", name: "popular-movies", resource: moviesResource.addResource('popular') },
			{ handler: "index.get", name: "get-movie", resource: moviesResource.addResource('{itemId}') },
		];
		for (const route of movieRoutes) {
			const handler = this.createHandler(
				route.handler,
				path.join(buildFolder, "movies"),
				`${props.projectName}-${route.name}-${props.stage}`,
				moviesEnvironment,
				undefined,
				512
			);
			usersTable.grantReadData(handler);
			moviesTable.grantReadData(handler);
			route.resource.addMethod('GET', new LambdaIntegration(handler), authorized);
		}
	}

	private createHandler(
		codePath: string,
        folder: string,
		name: string,
		environmentVariables?: {
			[key: string]: string
		},
		network?: Network,
		memorySize?: number
	): Function {
		const handler = new Lambda(this, {
			network,
			codePath,
            folder,
            timeout: 60 * 5,
			name,
			environmentVariables,
			memorySize
		}).func;

        return handler;
	}
}

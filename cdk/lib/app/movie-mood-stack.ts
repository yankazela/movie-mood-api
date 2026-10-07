import path = require("path");
import { Stack, Duration, Fn } from "aws-cdk-lib";
import { Function } from "aws-cdk-lib/aws-lambda";
import { Lambda, Network, CommonProps} from "@novha/cdk-lib";
import { Construct } from "constructs";
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
	CfnAuthorizer
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

		// const userPool = UserPool.fromUserPoolArn(
		// 	this,
        //     "UserPool",
        //     userPoolArn,
		// );

		
		// const cognitoAuthorizer = new CfnAuthorizer(this, `${props.projectName}-auth-${props.stage}`, {
		// 	restApiId: this.apiGateway.restApiId,
		// 	type: 'COGNITO_USER_POOLS',
        //     identitySource: 'method.request.header.Authorization',
        //     providerArns: [userPool.userPoolArn],
		// 	name: `authorizer-${props.stage}`
		// })

		// baseResource
		// 	.addResource('live-games')
		// 	.addMethod(
		// 		'GET',
		// 		new LambdaIntegration(getCachedGamesHandler),
		// 		{
		// 			authorizer: {
		// 				authorizerId: cognitoAuthorizer.ref,
		// 			},
		// 			authorizationType: AuthorizationType.COGNITO,
		// 		}
		// 	);

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
                USER_POOL_ID: userPool.userPoolId,
            }
		);
		usersTable.grantReadWriteData(updateUserHandler);
		userPool.grant(updateUserHandler, "cognito-idp:AdminUpdateUserAttributes");

		const userResource = baseResource.addResource('user');
		userResource.addMethod('POST', new LambdaIntegration(createUserHandler));
		userResource.addMethod('PATCH', new LambdaIntegration(updateUserHandler), {
			authorizer,
			authorizationType: AuthorizationType.COGNITO,
		});

		// Email/password sign-in. Google/Apple users sign in through Cognito's hosted UI instead.
		// Both handlers come from the same bundle (src/api/auth).
		const authEnvironment = {
			USERS_TABLE_NAME: Fn.importValue(`${props.projectName}-UsersTableName-${props.stage}`),
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
		// Both return the signed-in user's profile alongside the tokens.
		usersTable.grantReadData(signInHandler);
		usersTable.grantReadData(newPasswordHandler);

		const authResource = baseResource.addResource('auth');
		authResource
			.addResource('signin')
			.addMethod('POST', new LambdaIntegration(signInHandler));
		authResource
			.addResource('new-password')
			.addMethod('POST', new LambdaIntegration(newPasswordHandler));

		// Recommendations, text path, behind the same Cognito authorizer.
		const requestsTable = Table.fromTableArn(
			this,
			"RequestsTable",
			Fn.importValue(`${props.projectName}-RequestsTableArn-${props.stage}`)
		);
		const moviesTable = Table.fromTableArn(
			this,
			"MoviesTable",
			Fn.importValue(`${props.projectName}-MoviesTableArn-${props.stage}`)
		);
		// Movie embeddings are queried from the S3 Vectors index owned by the storage stack.
		const vectorIndexArn = Fn.importValue(`${props.projectName}-VectorIndexArn-${props.stage}`);

		const recommendHandler = this.createHandler(
            "index.recommend",
            path.join(buildFolder, "recommendations"),
            `${props.projectName}-recommend-${props.stage}`,
            {
                USERS_TABLE_NAME: Fn.importValue(`${props.projectName}-UsersTableName-${props.stage}`),
                REQUESTS_TABLE_NAME: Fn.importValue(`${props.projectName}-RequestsTableName-${props.stage}`),
                MOVIES_TABLE_NAME: Fn.importValue(`${props.projectName}-MoviesTableName-${props.stage}`),
                MOOD_MODEL_ID: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
                EMBEDDING_MODEL_ID: "amazon.titan-embed-text-v2:0",
                DAILY_REQUEST_CAP: "20",
                VECTOR_BUCKET_NAME: Fn.importValue(`${props.projectName}-VectorBucketName-${props.stage}`),
                VECTOR_INDEX_NAME: Fn.importValue(`${props.projectName}-VectorIndexName-${props.stage}`),
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

		baseResource
			.addResource('recommendations')
			.addMethod('POST', new LambdaIntegration(recommendHandler), {
				authorizer,
				authorizationType: AuthorizationType.COGNITO,
			});
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

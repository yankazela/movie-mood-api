import path = require("path");
import { Duration, Fn, SecretValue, Stack } from "aws-cdk-lib";
import { Table } from "aws-cdk-lib/aws-dynamodb";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Code, Function, Runtime } from "aws-cdk-lib/aws-lambda";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { CommonProps } from "@novha/cdk-lib";
import { Construct } from "constructs";

/**
 * The nightly catalog-refresh job: pulls popular streamable films from TMDB, writes metadata,
 * availability and posters, and embeds each film's mood into the S3 Vectors index.
 */
export class MovieMoodCatalogStack extends Stack {
	constructor(scope: Construct, id: string, props: CommonProps) {
		super(scope, id, props);

		const importName = (name: string) => Fn.importValue(`${props.projectName}-${name}-${props.stage}`);

		const moviesTable = Table.fromTableArn(this, "MoviesTable", importName("MoviesTableArn"));
		const providersTable = Table.fromTableArn(this, "ProvidersTable", importName("ProvidersTableArn"));
		const configTable = Table.fromTableArn(this, "ConfigTable", importName("ConfigTableArn"));
		const assetsBucket = Bucket.fromBucketName(this, "AssetsBucket", importName("MovieMoodBucketName"));
		const vectorIndexArn = importName("VectorIndexArn");

		// Holds the TMDB v3 API key or v4 read access token. Deployed as a placeholder; set the real
		// value in the console or with `aws secretsmanager put-secret-value`.
		const tmdbSecret = new Secret(this, "TmdbSecret", {
			secretName: `${props.projectName}/tmdb-${props.stage}`,
			description: "TMDB API key or read access token used by catalog-refresh",
			secretStringValue: SecretValue.unsafePlainText(""),
		});

		// A fixed name lets the function grant itself invoke permission without a circular reference.
		const functionName = `${props.projectName}-catalog-refresh-${props.stage}`;
		const handler = new Function(this, "CatalogRefreshHandler", {
			functionName,
			runtime: Runtime.NODEJS_22_X,
			handler: "index.run",
			code: Code.fromAsset(path.resolve(__dirname, "../../../dist/api/catalog-refresh")),
			timeout: Duration.minutes(15),
			memorySize: 1024,
			environment: {
				MOVIES_TABLE_NAME: importName("MoviesTableName"),
				PROVIDERS_TABLE_NAME: importName("ProvidersTableName"),
				CONFIG_TABLE_NAME: importName("ConfigTableName"),
				ASSETS_BUCKET_NAME: importName("MovieMoodBucketName"),
				VECTOR_BUCKET_NAME: importName("VectorBucketName"),
				VECTOR_INDEX_NAME: importName("VectorIndexName"),
				TMDB_SECRET_ARN: tmdbSecret.secretArn,
				MOOD_MODEL_ID: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
				EMBEDDING_MODEL_ID: "amazon.titan-embed-text-v2:0",
				// Comma-separated ISO country codes to catalog, in order.
				CATALOG_COUNTRIES: "ZA,US,CA",
				// Discover pages per country per run (20 films each).
				CATALOG_MAX_PAGES: "10",
			},
		});

		moviesTable.grantReadWriteData(handler);
		providersTable.grantWriteData(handler);
		configTable.grantReadWriteData(handler);
		assetsBucket.grantReadWrite(handler);
		tmdbSecret.grantRead(handler);
		handler.addToRolePolicy(new PolicyStatement({
			actions: ["s3vectors:PutVectors", "s3vectors:DeleteVectors", "s3vectors:QueryVectors", "s3vectors:GetVectors", "s3vectors:ListVectors"],
			resources: [vectorIndexArn],
		}));
		handler.addToRolePolicy(new PolicyStatement({
			actions: ["bedrock:InvokeModel"],
			resources: [
				`arn:aws:bedrock:${this.region}:${this.account}:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0`,
				"arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0",
				`arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
			],
		}));
		// Continue a paused run by invoking itself asynchronously.
		handler.addToRolePolicy(new PolicyStatement({
			actions: ["lambda:InvokeFunction"],
			resources: [`arn:aws:lambda:${this.region}:${this.account}:function:${functionName}`],
		}));

		new Rule(this, "NightlyRefresh", {
			description: "Refresh the MovieMood catalog every night",
			schedule: Schedule.cron({ minute: "0", hour: "2" }),
			targets: [new LambdaFunction(handler)],
			enabled: false,
		});
	}
}

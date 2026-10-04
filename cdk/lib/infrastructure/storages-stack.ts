import { CfnOutput, Fn, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { BlockPublicAccess, Bucket } from 'aws-cdk-lib/aws-s3';
import { Function } from "aws-cdk-lib/aws-lambda";
import { Construct } from 'constructs';
import { CommonProps } from "../../bin/project-names";
import { Attribute, AttributeType, BillingMode, CfnTable, ProjectionType, Table } from 'aws-cdk-lib/aws-dynamodb';
import { CfnIndex, CfnVectorBucket } from 'aws-cdk-lib/aws-s3vectors';

interface TableSpec {
	/** Short lowercase name, e.g. "users". Drives the construct id, table name and exports. */
	name: string;
	partitionKey: Attribute;
	sortKey?: Attribute;
	/** Epoch-seconds attribute DynamoDB reads to expire items. The writer decides the window. */
	timeToLiveAttribute?: string;
	pointInTimeRecovery?: boolean;
	deletionProtection?: boolean;
}

export class StorageStack extends Stack {
	private readonly bucket: Bucket;
	public readonly users: Table;
	public readonly requests: Table;
	public readonly jobs: Table;
	public readonly movies: Table;
	public readonly providers: Table;
	public readonly config: Table;

	constructor(scope: Construct, id: string, props: CommonProps) {
		super(scope, id, props);

		// Encryption is left at the DynamoDB default (AWS-owned key). The customer-managed
		// KMS key from the data model is intentionally not provisioned here.

		// Users: profile + feedback (email, country, services, genrePrefs, votes, ...).
		this.users = this.createTable(props, {
			name: 'users',
			partitionKey: { name: 'userId', type: AttributeType.STRING },
			pointInTimeRecovery: true,
			deletionProtection: true,
		});

		// Requests: one item per recommendation request, keyed by user and ISO timestamp.
		// Items expire 90 days after being written; the writer sets `ttl` (epoch seconds).
		this.requests = this.createTable(props, {
			name: 'requests',
			partitionKey: { name: 'userId', type: AttributeType.STRING },
			sortKey: { name: 'requestedAt', type: AttributeType.STRING },
			timeToLiveAttribute: 'ttl',
			pointInTimeRecovery: true,
		});

		// Jobs: transient transcription / recommendation jobs. Expire 1 day after being written.
		this.jobs = this.createTable(props, {
			name: 'jobs',
			partitionKey: { name: 'jobId', type: AttributeType.STRING },
			timeToLiveAttribute: 'ttl',
		});

		// Movies: catalog metadata, availability and "why" text. Rebuilt nightly by catalog-refresh.
		this.movies = this.createTable(props, {
			name: 'movies',
			partitionKey: { name: 'movieId', type: AttributeType.STRING },
		});

		// Providers: streaming providers per country, written by catalog-refresh.
		this.providers = this.createTable(props, {
			name: 'providers',
			partitionKey: { name: 'country', type: AttributeType.STRING },
		});

		// Config: catalog cursor and feature flags, written by catalog-refresh and operators.
		this.config = this.createTable(props, {
			name: 'config',
			partitionKey: { name: 'configKey', type: AttributeType.STRING },
		});

		this.bucket = new Bucket(this, "MovieMoodBucket", {
			bucketName: `${props.projectName}-storage-${props.stage}`,
			blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
			versioned: false,
			publicReadAccess: false
		});

		new CfnOutput(this, "MovieMoodBucketName", {
			value: this.bucket.bucketName,
			exportName: `${props.projectName}-MovieMoodBucketName-${props.stage}`,
		});

		// Movie embeddings live in an S3 Vectors index: float32, cosine distance, and the dimension
		// count of the Titan v2 embedder. Rebuilt nightly by catalog-refresh, so no retention needed.
		const vectorBucketName = `${props.projectName}-vectors-${props.stage}`;
		const vectorIndexName = 'movies';
		const vectorBucket = new CfnVectorBucket(this, 'VectorBucket', { vectorBucketName });
		const vectorIndex = new CfnIndex(this, 'MoviesVectorIndex', {
			vectorBucketName,
			indexName: vectorIndexName,
			dataType: 'float32',
			dimension: 1024,
			distanceMetric: 'cosine',
		});
		vectorIndex.addResourceDependency(vectorBucket);

		new CfnOutput(this, 'VectorBucketName', {
			value: vectorBucketName,
			exportName: `${props.projectName}-VectorBucketName-${props.stage}`,
		});
		new CfnOutput(this, 'VectorIndexName', {
			value: vectorIndexName,
			exportName: `${props.projectName}-VectorIndexName-${props.stage}`,
		});
		new CfnOutput(this, 'VectorIndexArn', {
			value: `arn:aws:s3vectors:${this.region}:${this.account}:bucket/${vectorBucketName}/index/${vectorIndexName}`,
			exportName: `${props.projectName}-VectorIndexArn-${props.stage}`,
		});
	}

	private createTable(props: CommonProps, spec: TableSpec): Table {
		const pascalName = spec.name.charAt(0).toUpperCase() + spec.name.slice(1);
		const isProtected = spec.pointInTimeRecovery === true || spec.deletionProtection === true;

		const table = new Table(this, `${pascalName}Table`, {
			tableName: `${props.projectName}-${spec.name}-${props.stage}`,
			partitionKey: spec.partitionKey,
			sortKey: spec.sortKey,
			billingMode: BillingMode.PAY_PER_REQUEST,
			timeToLiveAttribute: spec.timeToLiveAttribute,
			pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: spec.pointInTimeRecovery ?? false },
			deletionProtection: spec.deletionProtection ?? false,
			// Tables holding protected data survive a stack delete; rebuildable or
			// ephemeral tables are removed with the stack.
			removalPolicy: isProtected ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
		});

		// DynamoDB cannot rename a TTL attribute in place: TTL must be disabled first, then enabled
		// on the new name in a later update. To migrate, deploy once with
		//   -c disableTtlAttribute=<current attribute name>
		// wait until describe-time-to-live reports DISABLED, then deploy again without the flag.
		const disableTtlAttribute = this.node.tryGetContext('disableTtlAttribute') as string | undefined;

		if (spec.timeToLiveAttribute && disableTtlAttribute) {
			(table.node.defaultChild as CfnTable).timeToLiveSpecification = {
				enabled: false,
				attributeName: disableTtlAttribute,
			};
		}

		new CfnOutput(this, `${pascalName}TableName`, {
			value: table.tableName,
			exportName: `${props.projectName}-${pascalName}TableName-${props.stage}`,
		});

		new CfnOutput(this, `${pascalName}TableArn`, {
			value: table.tableArn,
			exportName: `${props.projectName}-${pascalName}TableArn-${props.stage}`,
		});

		return table;
	}
}

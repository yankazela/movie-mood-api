import { CfnOutput, Duration, Stack } from 'aws-cdk-lib';
import { Distribution, OriginProtocolPolicy, PriceClass, ViewerProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { HttpOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { CommonProps } from '../../bin/project-names';

export interface WebStackProps extends CommonProps {
	/** Existing bucket holding the exported site, with static website hosting on. */
	siteBucketName: string;
}

/**
 * HTTPS front door for the exported Next app. Cognito only accepts https:// callback URLs (apart from
 * localhost), and an S3 website endpoint is http-only, so CloudFront sits in front of it.
 */
export class WebStack extends Stack {
	public readonly distribution: Distribution;

	constructor(scope: Construct, id: string, props: WebStackProps) {
		super(scope, id, props);

		const bucket = Bucket.fromBucketName(this, 'SiteBucket', props.siteBucketName);

		this.distribution = new Distribution(this, 'SiteDistribution', {
			comment: `${props.projectName}-web-${props.stage}`,
			defaultRootObject: 'index.html',
			priceClass: PriceClass.PRICE_CLASS_100,
			defaultBehavior: {
				// The website endpoint resolves /login/ to login/index.html, which the plain S3 REST origin does not.
				origin: new HttpOrigin(bucket.bucketWebsiteDomainName, { protocolPolicy: OriginProtocolPolicy.HTTP_ONLY }),
				viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
			},
			errorResponses: [{ httpStatus: 404, responseHttpStatus: 404, responsePagePath: '/404.html', ttl: Duration.seconds(10) }],
		});

		new CfnOutput(this, 'WebUrl', {
			value: `https://${this.distribution.distributionDomainName}`,
			description: 'Set as the frontend base URL; deploy the site with `npm run deploy`, then invalidate /* on this distribution',
		});
		new CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
	}
}

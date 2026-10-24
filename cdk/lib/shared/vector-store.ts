/**
 * Names of the shared S3 Vectors bucket and index, computed rather than imported.
 *
 * The storage stack owns these resources, but the API and catalog stacks derive the names here
 * instead of using Fn.importValue. CloudFormation refuses to change an export while another stack
 * imports it, so importing would lock the index name (and anything derived from it) in place.
 */
export const VECTOR_INDEX_NAME = "catalog";

interface NamingProps {
	projectName: string;
	stage: string;
}

export function vectorBucketName(props: NamingProps): string {
	return `${props.projectName}-vectors-${props.stage}`;
}

export function vectorIndexArn(props: NamingProps, region: string, account: string): string {
	return `arn:aws:s3vectors:${region}:${account}:bucket/${vectorBucketName(props)}/index/${VECTOR_INDEX_NAME}`;
}

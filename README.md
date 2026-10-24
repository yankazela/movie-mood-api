# 0. Load TMDB_API_TOKEN and the Google credentials from .env into this shell
#    (set -a exports them; without it the deploy sees empty parameters)
set -a; source .env; set +a
test -n "$TMDB_API_TOKEN" || echo "TMDB_API_TOKEN is empty" >&2

set -a; source .env; set +a
test -n "$GOOGLE_CLIENT_ID" || echo "GOOGLE_CLIENT_ID is empty" >&2
test -n "$GOOGLE_CLIENT_SECRET" || echo "GOOGLE_CLIENT_SECRET is empty" >&2
test -n "$FE_BASE_URL" || echo "FE_BASE_URL" 

# 1. API and catalog stacks: stop importing the vector exports
AWS_REGION=us-east-1 npx cdk deploy --profile private --all \
  --parameters movie-mood-catalog-dev:TmdbApiToken="$TMDB_API_TOKEN"

# 2. Storage and auth stacks: now free to replace the index
AWS_REGION=us-east-1 npx cdk deploy --profile private --all \
  --app "npx ts-node --prefer-ts-exts cdk/bin/infrastructure.ts" \
  --parameters movie-mood-auth-dev:GoogleClientId="$GOOGLE_CLIENT_ID" \
  --parameters movie-mood-auth-dev:GoogleClientSecret="$GOOGLE_CLIENT_SECRET"

# 3. Reload the new index
aws lambda invoke --function-name movie-mood-catalog-refresh-dev --region us-east-1 --profile private /dev/stdout

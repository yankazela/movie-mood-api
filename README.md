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

## Subscriptions: free and advanced plans

Every profile is on a plan: `free` (2 recommendation requests per UTC day) or `advanced` (15 per day, sold as a
USD 3.99 monthly subscription through the app stores). The caps are set once, in `cdk/lib/app/movie-mood-stack.ts`
(`DAILY_CAP_FREE`, `DAILY_CAP_ADVANCED`), and enforced in `RecommendationServiceImpl`: a request slot is reserved
atomically on the Users table before any model call and handed back if the request fails, so parallel requests
cannot exceed the cap and a failed request costs nothing. Counters reset at UTC midnight.

**What the API returns**

- `GET /user/me`, `PATCH /user` and sign-in: the profile carries `plan` (as it stands right now; a lapsed
  subscription reads as `free`) and `usage: { plan, used, limit, remaining, resetsAt }`.
- `POST /recommendations`: the result carries the same `usage`, counting that request.
- Over the cap: `429` with `{ errorMessage, code: "daily_limit_reached", plan, limit, used, resetsAt }`. The message
  is written for the person; the app shows it as is and offers the upgrade when `plan` is `free`.

**How the plan gets set**

RevenueCat is the source of truth; the backend never takes the client's word for a purchase.

1. `POST /billing/webhook` (no Cognito authorizer): RevenueCat calls it on every subscription event. The handler
   checks the `Authorization` header against the secret, makes sure the body is an event, and puts it, exactly as
   received, on the SQS queue `movie-mood-billing-events-<stage>`. RevenueCat gets its 200 at once.
2. The processor Lambda (`index.processEvents`) consumes that queue in batches, re-reads each account the event
   names from the RevenueCat API and stores the plan on the profile (`plan`, `planExpiresAt`, `planSource`,
   `planWillRenew`, `planProductId`). Accounts without a profile are skipped and logged. A record that fails
   (RevenueCat or DynamoDB unreachable, an unexpected payload) goes back on the queue and is retried about every
   six minutes; after five attempts it moves to the dead-letter queue `movie-mood-billing-events-dlq-<stage>`,
   which keeps it for 14 days and trips the CloudWatch alarm of the same name.
3. `POST /billing/sync` (Cognito): the app calls it right after a purchase or a restore and gets the refreshed
   profile back, without waiting for the webhook.

Profiles from before billing existed have no `plan` field and are treated as free.

**Investigating failed events**

A dead-letter message is the original webhook body, with `eventType`, `eventId`, `environment` and `receivedAt` as
message attributes. Read it, find the failure in the processor's log, fix the cause, then redrive. Replaying is
harmless: processing re-reads the subscriber from RevenueCat instead of applying the event itself.

```bash
STACK=movie-mood-stack-dev
output() { aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text --profile private; }

# Peek at the failed events (they return to the queue after the visibility timeout)
aws sqs receive-message --queue-url "$(output BillingEventsDeadLetterQueueUrl)" \
  --max-number-of-messages 10 --message-attribute-names All --attribute-names All --profile private

# Why they failed
aws logs tail "/aws/lambda/$(output BillingProcessorFunctionName)" --since 1d --profile private

# Send them all back to the main queue for another attempt
aws sqs start-message-move-task --source-arn "$(output BillingEventsDeadLetterQueueArn)" --profile private
```

**Setting up RevenueCat**

1. Create the project with the iOS app (bundle `com.upmymood.app`) and the Android app, an entitlement with the id
   `advanced`, and a monthly product attached to it. The app must identify users to RevenueCat by their Cognito `sub`
   (`Purchases.logIn(sub)`); that is how webhook events are matched to profiles.
2. Deploy. The stack creates the secret `movie-mood/revenuecat-<stage>` with a generated `webhookAuthorization` and an
   empty `apiKey`. Read it, then put the project's secret API key in:

   ```bash
   aws secretsmanager get-secret-value --secret-id movie-mood/revenuecat-dev --query SecretString --output text --profile private
   aws secretsmanager put-secret-value --secret-id movie-mood/revenuecat-dev --profile private \
     --secret-string '{"apiKey":"sk_...","webhookAuthorization":"<keep the generated value>"}'
   ```

   The Lambdas cache the secret per container, so a new value takes effect on the next cold start or redeploy.
3. In RevenueCat, under Integrations → Webhooks, set the URL to the `BillingWebhookUrl` stack output and the
   Authorization header value to `webhookAuthorization` from the secret.
4. To try the advanced plan without buying anything, grant the `advanced` entitlement to a customer from the
   RevenueCat dashboard (a promotional grant), then call `POST /billing/sync` as that user or wait for the webhook.

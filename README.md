# GitHub Copilot with Open-Weight Models on Amazon Bedrock

Connect GitHub Copilot to open-weight models on Amazon Bedrock using its Bring Your Own Key (BYOK) feature, so you can choose cheaper models for simpler work when a frontier model is not required.

It demonstrates:
- An OpenAI compatible API using API Gateway and Lambda response streaming
- Accepting a standard Bearer token and applying it as an API Gateway API Key using a Lambda Authoriser
- Generating the API Key in Secrets Manager
- Calling Bedrock with the OpenAI SDK, using `aws4` for SigV4 authentication with the Lambda role
- Tracking token usage per request in DynamoDB
- Lambda Powertools for logging, metrics and tracing

All of the resources are created using CDK. This is a demo for a single user and is not designed to scale to multiple users.

&nbsp;

## Overview

```
VS Code Copilot (Custom Endpoint, Chat Completions)
   |  POST /v1/chat/completions   Authorization: Bearer <key>
   v
API Gateway REST API (Regional, usage plan, streaming integration)  <-->  Lambda Authoriser  <-->  Secrets Manager
   v
Chat Completions Lambda (Zod validation, model allow list, OpenAI SDK)
   |--> Bedrock bedrock-runtime /openai/v1 (SigV4)
   |--> DynamoDB usage table
```

&nbsp;

## Setup

Assuming you already have CDK installed and bootstrapped in your target account and region:
- clone the repo
- `npm ci` to install required modules
- review `config/index.ts`
- `cdk deploy` to deploy

The options in `config/index.ts` include:
- The account and region. A blank account uses your default AWS CLI account
- The allowed models, which are passed to the Lambda in an environment variable. The Lambda role can only invoke these models
- The usage plan throttling and daily request quota
- An optional custom domain, which requires a Route53 hosted zone. This option has been synthesised but not yet deployed

The models must be available in your region:

```bash
aws bedrock list-foundation-models --region ap-southeast-2 --by-output-modality TEXT --query "modelSummaries[].modelId"
```

The default models were all tested in `ap-southeast-2` with streaming and tool calling.

&nbsp;

## Connecting Copilot

Get the API Key using the `GetApiKeyCommand` value in the stack outputs.

**BYOK is not supported in VS Code remote sessions, including WSL.** The `Add Models` option is disabled in a remote window, so you need to use VS Code in a local window.

To add the models in VS Code:
1. Open the Command Palette and run `Chat: Manage Language Models`
2. Select `Add Models`, then `Custom Endpoint`
3. Use the wizard to add the first model, using the `ChatCompletionsUrl` stack output as the URL, the API Key, and a model `id` from `config/index.ts`. The wizard creates the `chatLanguageModels.json` file
4. Open the `chatLanguageModels.json` file from the same screen, then paste in the full config. There is a sample in [docs/chatLanguageModels.sample.json](docs/chatLanguageModels.sample.json) - replace the URLs with the `ChatCompletionsUrl` stack output
5. Select one of the models from the model picker in the Chat view

The model `id` values must match the `id` values in `config/index.ts`. Copilot sends the key as a Bearer token by default, so no custom headers are required.

Check the following before you start:
- BYOK covers chat and agent use. Inline suggestions and features that use embeddings still use the GitHub service
- Copilot Business and Enterprise administrators can disable BYOK with a policy
- `maxInputTokens` in the sample file is a conservative value that you can adjust for each model

&nbsp;

## Testing

```bash
curl -N "$URL" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-4.7-flash","stream":true,"messages":[{"role":"user","content":"Hello"}]}'
```

&nbsp;

## Usage Tracking

Each request is written to the usage table with a partition key of `UsageDate` (UTC, `YYYY-MM-DD`). Records expire after the number of days in the config.

The attributes are: `RequestKey`, `RequestId`, `Timestamp`, `ModelAlias`, `BedrockModelId`, `InputTokens`, `OutputTokens`, `TotalTokens`, `CachedTokens`, `DurationMs`, `TimeToFirstTokenMs`, `Status`, `HttpStatus`, `FinishReason` and `ExpiresAt`.

Prompts and responses are never stored or logged.

```bash
aws dynamodb query --table-name "$TABLE" \
  --key-condition-expression "UsageDate = :d" \
  --expression-attribute-values "{\":d\":{\"S\":\"$(date -u +%F)\"}}"
```

`InputTokens` and `OutputTokens` are also published as CloudWatch metrics for each model.

&nbsp;

## Things to Know

**Cancelling a request does not stop it.** API Gateway does not tell the Lambda when a client disconnects. The function continues until Bedrock completes and you pay for all of the output tokens. The record will show `Completed`. `maxOutputTokens` in the config limits the cost of each request.

**The daily quota counts requests, not tokens.** It limits the damage from a leaked key but does not directly limit spend. Consider also adding an AWS Budget.

**Rotating the key.** The secret is applied to the API Key when the stack deploys. Changing the secret value requires changes in both places, and is not automated in this demo.

**Limits.** Responses can stream for up to 15 minutes, with a 5 minute idle timeout on Regional endpoints. Edge-optimized endpoints have a 30 second idle timeout, which is why this demo uses Regional.

**Costs.** Everything is charged per request, so the demo costs almost nothing while idle. The exceptions are the Secrets Manager secret at about $0.40 per month, and a small amount of storage for the usage table and logs. When in use you are charged for Bedrock tokens, API Gateway streaming, Lambda and DynamoDB. Run `cdk destroy` to remove the demo. This also deletes the usage table.

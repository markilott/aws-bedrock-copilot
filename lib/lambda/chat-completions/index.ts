import { once } from 'node:events';
import type { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { Tracer } from '@aws-lambda-powertools/tracer';
import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { APIError } from 'openai';
import type {
    ChatCompletionChunk, ChatCompletionCreateParamsNonStreaming, ChatCompletionCreateParamsStreaming,
} from 'openai/resources/chat/completions';
import { client } from './bedrock-client';
import { chatRequestSchema, Model, modelListSchema } from './schema';
import { createUsageWriter, UsageRecord } from './usage';

/** Instantiate the PowerTools instances */
const logger = new Logger();
const tracer = new Tracer();
const metrics = new Metrics();

const writeUsage = createUsageWriter(tracer);

const models = new Map<string, Model>(modelListSchema.parse(JSON.parse(process.env.MODELS as string)).map((model) => [model.id, model]));

/** Thrown for invalid requests before we call Bedrock */
class RequestError extends Error {
    constructor(public statusCode: number, message: string, public code: string) {
        super(message);
    }
}

const errorBody = (message: string, code: string) => JSON.stringify({ error: { message, type: 'invalid_request_error', code } });

/** Validates the request and maps it to a Bedrock request, with the output tokens capped for the model */
const parseRequest = (event: APIGatewayProxyEvent) => {
    let body: unknown;
    try {
        body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString() : event.body ?? '');
    } catch {
        throw new RequestError(400, 'Request body must be valid JSON', 'invalid_json');
    }

    const parsed = chatRequestSchema.safeParse(body);
    if (!parsed.success) {
        throw new RequestError(400, parsed.error.issues.map(({ path, message }) => `${path.join('.')}: ${message}`).join('; '), 'invalid_request');
    }

    const { max_completion_tokens: maxCompletionTokens, max_tokens: maxTokens, ...request } = parsed.data;
    const model = models.get(request.model);
    if (!model) {
        throw new RequestError(404, `Model ${request.model} is not available. Available models: ${[...models.keys()].join(', ')}`, 'model_not_found');
    }

    return {
        model,
        request: {
            ...request,
            model: model.bedrockModelId,
            max_tokens: Math.min(maxCompletionTokens ?? maxTokens ?? model.maxOutputTokens, model.maxOutputTokens),
        },
    };
};

const lambdaHandler = async (event: APIGatewayProxyEvent, responseStream: awslambda.HttpResponseStream, context: Context): Promise<void> => {
    logger.addContext(context);

    const startTime = Date.now();
    const usage: UsageRecord = {
        RequestId: event.requestContext.requestId,
        ModelAlias: 'unknown',
        DurationMs: 0,
        Status: 'Completed',
        HttpStatus: 200,
    };

    /** Sends a complete response. The metadata is only sent on a write, so we can't send the body using end() */
    const sendJson = async (statusCode: number, body: string) => {
        const json = open(statusCode, 'application/json');
        json.write(body);
        json.end();
        await finished(json);
    };

    /** Metadata can only be sent once, so errors after this point must be sent in the stream */
    let output: Writable | undefined;
    const open = (statusCode: number, contentType: string) => {
        output = awslambda.HttpResponseStream.from(responseStream, {
            statusCode,
            headers: { 'Content-Type': contentType, 'Cache-Control': 'no-cache' },
        });
        return output;
    };

    const addUsage = (tokens: ChatCompletionChunk['usage']) => {
        if (!tokens) { return; }
        usage.InputTokens = tokens.prompt_tokens;
        usage.OutputTokens = tokens.completion_tokens;
        usage.TotalTokens = tokens.total_tokens;
        usage.CachedTokens = tokens.prompt_tokens_details?.cached_tokens;
    };

    try {
        const { model, request } = parseRequest(event);
        usage.ModelAlias = model.id;
        usage.BedrockModelId = model.bedrockModelId;

        if (request.stream) {
            // Bedrock errors are thrown here, before the stream is opened, so can be returned with the correct status
            const stream = await client.chat.completions.create({
                ...request,
                stream_options: { ...(request.stream_options as object), include_usage: true },
            } as unknown as ChatCompletionCreateParamsStreaming);

            const sse = open(200, 'text/event-stream');
            for await (const chunk of stream) {
                usage.TimeToFirstTokenMs ??= Date.now() - startTime;
                addUsage(chunk.usage);
                usage.FinishReason = chunk.choices[0]?.finish_reason ?? usage.FinishReason;
                if (!sse.write(`data: ${JSON.stringify({ ...chunk, model: model.id })}\n\n`)) {
                    await once(sse, 'drain');
                }
            }
            sse.end('data: [DONE]\n\n');
            await finished(sse);
        } else {
            const completion = await client.chat.completions.create(request as unknown as ChatCompletionCreateParamsNonStreaming);
            addUsage(completion.usage);
            usage.FinishReason = completion.choices[0]?.finish_reason;
            await sendJson(200, JSON.stringify({ ...completion, model: model.id }));
        }
    } catch (err) {
        usage.Status = 'Error';
        const message = (err as Error).message;
        const code = (err instanceof RequestError) ? err.code : 'upstream_error';
        usage.HttpStatus = 502;
        if (err instanceof RequestError) { usage.HttpStatus = err.statusCode; }
        if (err instanceof APIError) { usage.HttpStatus = err.status ?? 502; }
        logger.error('Request failed', { statusCode: usage.HttpStatus, code, error: err as Error });

        if (output) {
            // The status has already been sent, so all we can do is report the error in the stream
            output.end(`data: ${errorBody(message, code)}\n\n`);
            await finished(output);
        } else {
            await sendJson(usage.HttpStatus, errorBody(message, code));
        }
    } finally {
        usage.DurationMs = Date.now() - startTime;
        logger.info('Request usage', { usage });
        try {
            await writeUsage(usage);
        } catch (err) {
            logger.error('Failed to write usage', { error: err as Error });
        }
        if (usage.InputTokens !== undefined) {
            metrics.addDimension('Model', usage.ModelAlias);
            metrics.addMetric('InputTokens', MetricUnit.Count, usage.InputTokens);
            metrics.addMetric('OutputTokens', MetricUnit.Count, usage.OutputTokens ?? 0);
        }
        metrics.publishStoredMetrics();
    }
};

export const handler = awslambda.streamifyResponse(lambdaHandler);

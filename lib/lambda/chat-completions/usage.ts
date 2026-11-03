import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { Tracer } from '@aws-lambda-powertools/tracer';

const tableName = process.env.USAGE_TABLE_NAME as string;
const expiryDays = Number(process.env.USAGE_EXPIRY_DAYS);

/** Prompts and responses are deliberately excluded, as they may include source code */
export type UsageRecord = {
    RequestId: string,
    ModelAlias: string,
    BedrockModelId?: string,
    InputTokens?: number,
    OutputTokens?: number,
    TotalTokens?: number,
    CachedTokens?: number,
    DurationMs: number,
    TimeToFirstTokenMs?: number,
    Status: 'Completed' | 'Error',
    HttpStatus: number,
    FinishReason?: string,
};

/** Creates the function that writes to the usage table */
export const createUsageWriter = (tracer: Tracer) => {
    const docClient = DynamoDBDocumentClient.from(tracer.captureAWSv3Client(new DynamoDBClient({})), {
        marshallOptions: { removeUndefinedValues: true },
    });

    return async (usage: UsageRecord): Promise<void> => {
        const now = new Date();
        const timestamp = now.toISOString();
        await docClient.send(new PutCommand({
            TableName: tableName,
            Item: {
                UsageDate: timestamp.slice(0, 10),
                RequestKey: `${timestamp}#${usage.RequestId}`,
                Timestamp: timestamp,
                ExpiresAt: Math.floor(now.getTime() / 1000) + (expiryDays * 86400),
                ...usage,
            },
        }));
    };
};

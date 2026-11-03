export type ModelConfig = {
    /** The Id configured in Copilot and sent in requests. VS Code may reject Ids containing a slash */
    id: string,
    /** The Bedrock foundation model Id */
    bedrockModelId: string,
    /** Output tokens per request are capped at this value */
    maxOutputTokens: number,
};

export const config = {
    // Leave blank to use the default account from your AWS CLI credentials
    account: '',
    // The models below must be available in this region. Check with `aws bedrock list-foundation-models`
    region: 'ap-southeast-2',

    // These are the only models the API will accept and the Lambda role can invoke
    models: [
        { id: 'qwen3-coder-next', bedrockModelId: 'qwen.qwen3-coder-next', maxOutputTokens: 16000 },
        { id: 'kimi-k2.5', bedrockModelId: 'moonshotai.kimi-k2.5', maxOutputTokens: 16000 },
        { id: 'deepseek-v3.2', bedrockModelId: 'deepseek.v3.2', maxOutputTokens: 16000 },
        { id: 'glm-4.7-flash', bedrockModelId: 'zai.glm-4.7-flash', maxOutputTokens: 16000 },
    ] as ModelConfig[],

    usagePlan: {
        rateLimit: 5, // Requests per second
        burstLimit: 10,
        dailyQuota: 1000, // Requests per day. An agent task can make many requests
    },

    usageExpiryDays: 90, // DynamoDB TTL for usage records

    // Optional custom domain. All of zoneName, hostedZoneId and apiHostname are required to enable it
    customDomain: {
        zoneName: '',
        hostedZoneId: '',
        apiHostname: '',
        certificateArn: '', // Leave blank to create a new certificate
    },
};

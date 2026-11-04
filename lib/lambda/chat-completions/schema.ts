import { z } from 'zod';

/** The allowed models from the MODELS environment variable */
export const modelListSchema = z.array(z.object({
    id: z.string().min(1),
    bedrockModelId: z.string().min(1),
    maxOutputTokens: z.number().int().positive(),
}));

export type Model = z.infer<typeof modelListSchema>[number];

/**
 * Validates only the fields used by this function.
 * All other fields are passed through to Bedrock, so that changes in the Copilot request do not break the API.
 */
export const chatRequestSchema = z.looseObject({
    model: z.string().min(1),
    messages: z.array(z.looseObject({ role: z.string().min(1) })).min(1),
    stream: z.boolean().optional(),
    stream_options: z.looseObject({}).nullish(),
    max_tokens: z.number().int().positive().nullish(),
    max_completion_tokens: z.number().int().positive().nullish(),
});

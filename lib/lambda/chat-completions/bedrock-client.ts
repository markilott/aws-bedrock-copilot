import { sign } from 'aws4';
import OpenAI from 'openai';

const region = process.env.AWS_REGION as string;

/**
 * The OpenAI SDK only supports Bearer tokens, so we sign the requests here using the Lambda role.
 * aws4 reads the role credentials from the Lambda environment variables.
 */
const signedFetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = new Headers(init.headers);
    headers.delete('authorization');

    const signed = sign({
        host: url.host,
        path: `${url.pathname}${url.search}`,
        method: init.method,
        service: 'bedrock',
        region,
        headers: Object.fromEntries(headers),
        body: init.body as string,
    });

    return fetch(url, { ...init, headers: signed.headers as Record<string, string> });
};

export const client = new OpenAI({
    baseURL: `https://bedrock-runtime.${region}.amazonaws.com/openai/v1`,
    apiKey: 'not-used-requests-are-signed',
    fetch: signedFetch,
    timeout: 14 * 60 * 1000, // Must be less than the function timeout, so that we can record the failure
});

import { createHash, timingSafeEqual } from 'node:crypto';
import { Logger } from '@aws-lambda-powertools/logger';
import { getSecret } from '@aws-lambda-powertools/parameters/secrets';
import type { APIGatewayAuthorizerResult, APIGatewayTokenAuthorizerEvent, Context } from 'aws-lambda';

const logger = new Logger();

const secretArn = process.env.API_KEY_SECRET_ARN as string;

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

/**
 * Copilot sends the key as a standard Bearer token, but API Gateway usage plans need an API Key.
 * We validate the token against the secret and return it as the usageIdentifierKey,
 * which API Gateway then applies as the API Key (with the API Key source set to AUTHORIZER).
 */
export const handler = async (event: APIGatewayTokenAuthorizerEvent, context: Context): Promise<APIGatewayAuthorizerResult> => {
    logger.addContext(context);

    const token = event.authorizationToken.replace(/^Bearer /, '');

    // Secret is cached by Powertools for 5 minutes
    const apiKey = await getSecret<string>(secretArn, { maxAge: 300 });
    if (!apiKey || !timingSafeEqual(sha256(token), sha256(apiKey))) {
        logger.warn('Invalid API Key');
        // This exact message results in a 401 response from API Gateway
        throw new Error('Unauthorized');
    }

    // The result is cached by API Gateway, so must apply to the whole API rather than just this request
    const [apiArn, stage] = event.methodArn.split('/');
    return {
        principalId: 'copilot',
        usageIdentifierKey: token,
        policyDocument: {
            Version: '2012-10-17',
            Statement: [{
                Action: 'execute-api:Invoke',
                Effect: 'Allow',
                Resource: `${apiArn}/${stage}/*`,
            }],
        },
    };
};

import { join } from 'node:path';
import {
    CfnOutput, Duration, RemovalPolicy, Stack, StackProps,
} from 'aws-cdk-lib';
import {
    ApiKey, ApiKeySourceType, EndpointType, LambdaIntegration, Period, ResponseTransferMode, RestApi,
    SecurityPolicy, TokenAuthorizer,
} from 'aws-cdk-lib/aws-apigateway';
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Runtime, Tracing } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { ARecord, HostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { ApiGatewayDomain } from 'aws-cdk-lib/aws-route53-targets';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { config as appConfig } from '../config';

const svcName = 'BedrockCopilot';
const stageName = 'v1';

interface ApplicationStackProps extends StackProps {
    config: typeof appConfig,
}

/**
 * Deploys an OpenAI compatible streaming API in front of Bedrock, for use with GitHub Copilot.
 * Requests are authenticated with a Bearer token that is applied as an API Gateway API Key.
 */
export class ApplicationStack extends Stack {
    /**
     * @param {Construct} scope
     * @param {string} id
     * @param {ApplicationStackProps} props
     */
    constructor(scope: Construct, id: string, props: ApplicationStackProps) {
        super(scope, id, props);

        const {
            models, usagePlan, usageExpiryDays, customDomain,
        } = props.config;
        const {
            zoneName, hostedZoneId, apiHostname, certificateArn,
        } = customDomain;
        const useCustomDomain = (zoneName && hostedZoneId && apiHostname);

        // Lambda Function Common Props ===========================

        const functionProps = (logId: string): NodejsFunctionProps => ({
            runtime: Runtime.NODEJS_24_X,
            tracing: Tracing.ACTIVE,
            logGroup: new LogGroup(this, logId, {
                retention: RetentionDays.ONE_MONTH,
                removalPolicy: RemovalPolicy.DESTROY,
            }),
            bundling: { sourceMap: true },
        });
        const powertoolsEnv = {
            NODE_OPTIONS: '--enable-source-maps',
            POWERTOOLS_SERVICE_NAME: svcName,
            POWERTOOLS_METRICS_NAMESPACE: svcName,
            LOG_LEVEL: 'INFO',
            // Prompts and API keys must not be written to the logs or traces
            POWERTOOLS_LOGGER_LOG_EVENT: 'false',
            POWERTOOLS_TRACER_CAPTURE_RESPONSE: 'false',
        };

        // API Key ================================================

        const apiKeySecret = new Secret(this, 'ApiKeySecret', {
            description: 'API Key for the Bedrock Copilot API',
            generateSecretString: {
                excludePunctuation: true,
                passwordLength: 48,
            },
            removalPolicy: RemovalPolicy.DESTROY,
        });

        // Uses a CloudFormation dynamic reference, so the value is not included in the template
        const apiKey = new ApiKey(this, 'ApiKey', {
            description: 'API Key for the Bedrock Copilot API',
            value: apiKeySecret.secretValue.unsafeUnwrap(),
        });

        // Authoriser =============================================

        const authoriserFnc = new NodejsFunction(this, 'AuthoriserFnc', {
            ...functionProps('AuthoriserLogGroup'),
            description: 'Validates the Bearer token and returns it as the API Key',
            entry: join(__dirname, 'lambda/authoriser/index.ts'),
            memorySize: 256,
            timeout: Duration.seconds(10),
            environment: {
                ...powertoolsEnv,
                API_KEY_SECRET_ARN: apiKeySecret.secretArn,
            },
        });
        apiKeySecret.grantRead(authoriserFnc);

        const authorizer = new TokenAuthorizer(this, 'Authoriser', {
            handler: authoriserFnc,
            validationRegex: '^Bearer [A-Za-z0-9]+$',
            resultsCacheTtl: Duration.minutes(5),
        });

        // Usage Table ============================================

        const usageTable = new Table(this, 'UsageTable', {
            partitionKey: { name: 'UsageDate', type: AttributeType.STRING },
            sortKey: { name: 'RequestKey', type: AttributeType.STRING },
            billingMode: BillingMode.PAY_PER_REQUEST,
            timeToLiveAttribute: 'ExpiresAt',
            removalPolicy: RemovalPolicy.DESTROY,
        });

        // Chat Completions Function ==============================

        const chatFnc = new NodejsFunction(this, 'ChatCompletionsFnc', {
            ...functionProps('ChatCompletionsLogGroup'),
            description: 'Streams Chat Completions from Bedrock and records token usage',
            entry: join(__dirname, 'lambda/chat-completions/index.ts'),
            memorySize: 512,
            timeout: Duration.minutes(15),
            environment: {
                ...powertoolsEnv,
                MODELS: JSON.stringify(models),
                USAGE_TABLE_NAME: usageTable.tableName,
                USAGE_EXPIRY_DAYS: String(usageExpiryDays),
            },
        });
        usageTable.grantWriteData(chatFnc);
        chatFnc.addToRolePolicy(new PolicyStatement({
            actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
            resources: models.map(({ bedrockModelId }) => `arn:aws:bedrock:${this.region}::foundation-model/${bedrockModelId}`),
        }));

        // API ====================================================

        // Streaming idle timeouts are only 30 seconds on edge-optimized endpoints, compared to 5 minutes on regional
        const api = new RestApi(this, 'Api', {
            restApiName: svcName,
            description: 'OpenAI compatible API for Amazon Bedrock',
            endpointConfiguration: { types: [EndpointType.REGIONAL] },
            apiKeySourceType: ApiKeySourceType.AUTHORIZER,
            deployOptions: {
                stageName,
                tracingEnabled: true,
            },
        });

        api.root.addResource('chat').addResource('completions').addMethod('POST', new LambdaIntegration(chatFnc, {
            responseTransferMode: ResponseTransferMode.STREAM,
            timeout: Duration.minutes(15),
        }), {
            authorizer,
            apiKeyRequired: true,
        });

        const plan = api.addUsagePlan('UsagePlan', {
            throttle: { rateLimit: usagePlan.rateLimit, burstLimit: usagePlan.burstLimit },
            quota: { limit: usagePlan.dailyQuota, period: Period.DAY },
        });
        plan.addApiKey(apiKey);
        plan.addApiStage({ stage: api.deploymentStage });

        // Custom Domain (Optional) ===============================

        let apiBaseUrl = api.url.replace(/\/$/, '');
        if (useCustomDomain) {
            const domainName = `${apiHostname}.${zoneName}`;
            const zone = HostedZone.fromHostedZoneAttributes(this, 'Zone', { zoneName, hostedZoneId });
            const certificate = (certificateArn)
                ? Certificate.fromCertificateArn(this, 'Certificate', certificateArn)
                : new Certificate(this, 'Certificate', {
                    domainName,
                    validation: CertificateValidation.fromDns(zone),
                });
            const domain = api.addDomainName('Domain', {
                domainName,
                certificate,
                endpointType: EndpointType.REGIONAL,
                securityPolicy: SecurityPolicy.TLS_1_2,
                basePath: stageName,
            });
            new ARecord(this, 'DnsRecord', {
                zone,
                recordName: apiHostname,
                target: RecordTarget.fromAlias(new ApiGatewayDomain(domain)),
            });
            apiBaseUrl = `https://${domainName}/${stageName}`;
        }

        // Outputs ================================================

        new CfnOutput(this, 'ApiBaseUrl', { value: apiBaseUrl });
        new CfnOutput(this, 'ChatCompletionsUrl', { value: `${apiBaseUrl}/chat/completions` });
        new CfnOutput(this, 'UsageTableName', { value: usageTable.tableName });
        new CfnOutput(this, 'GetApiKeyCommand', {
            value: `aws secretsmanager get-secret-value --region ${this.region} --secret-id ${apiKeySecret.secretName} --query SecretString --output text`,
        });
    }
}

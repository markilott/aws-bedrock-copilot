/**
 * Deploys to the account and region in the config file.
 * A blank account will use the current default CLI account.
 *
 * Deployment:
 * cdk deploy
 */

import 'source-map-support/register';
import { App } from 'aws-cdk-lib';
import { ApplicationStack } from '../lib/application-stack';
import { config } from '../config';

const app = new App();

const { account, region } = config;

new ApplicationStack(app, 'BedrockCopilotStack', {
    description: 'GitHub Copilot to Amazon Bedrock Demo Stack',
    env: {
        account: account || process.env.CDK_DEFAULT_ACCOUNT,
        region: region || process.env.CDK_DEFAULT_REGION,
    },
    config,
});

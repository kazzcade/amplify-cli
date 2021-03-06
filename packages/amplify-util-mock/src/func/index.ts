import { JSONUtilities, pathManager, $TSContext } from 'amplify-cli-core';
import { getInvoker, category, isMockable } from 'amplify-category-function';
import * as path from 'path';
import * as inquirer from 'inquirer';
import { loadMinimalLambdaConfig } from '../utils/lambda/loadMinimal';
import { hydrateAllEnvVars } from '../utils';

const DEFAULT_TIMEOUT_SECONDS = 10;

export async function start(context: $TSContext) {
  if (!context.input.subCommands || context.input.subCommands.length < 1) {
    throw new Error('Specify the function name to invoke with "amplify mock function <function name>"');
  }

  const resourceName = context.input.subCommands[0];
  // check that the resource is mockable
  const mockable = isMockable(context, resourceName);
  if (!mockable.isMockable) {
    throw new Error(`Unable to mock ${resourceName}. ${mockable.reason}`);
  }
  const { amplify } = context;
  const resourcePath = path.join(pathManager.getBackendDirPath(), category, resourceName);
  const eventNameValidator = amplify.inputValidation({
    operator: 'regex',
    value: '^[a-zA-Z0-9/._-]+?\\.json$',
    onErrorMsg: 'Provide a valid unix-like path to a .json file',
    required: true,
  });
  let eventName: string = context.input.options ? context.input.options.event : undefined;
  let promptForEvent = true;
  if (eventName) {
    const validatorOutput = eventNameValidator(eventName);
    const isValid = typeof validatorOutput !== 'string';
    if (!isValid) {
      context.print.warning(validatorOutput);
    } else {
      promptForEvent = false;
    }
  }

  if (promptForEvent) {
    const resourceQuestions = [
      {
        type: 'input',
        name: 'eventName',
        message: `Provide the path to the event JSON object relative to ${resourcePath}`,
        validate: eventNameValidator,
        default: 'src/event.json',
      },
    ];
    const resourceAnswers = await inquirer.prompt(resourceQuestions);
    eventName = resourceAnswers.eventName as string;
  }

  const event = JSONUtilities.readJson(path.resolve(path.join(resourcePath, eventName)));
  const lambdaConfig = loadMinimalLambdaConfig(resourceName, { env: context.amplify.getEnvInfo().envName });
  if (!lambdaConfig || !lambdaConfig.handler) {
    throw new Error(`Could not parse handler for ${resourceName} from cloudformation file`);
  }
  const { allResources } = await context.amplify.getResourceStatus();

  const envVars = hydrateAllEnvVars(allResources, lambdaConfig.environment);
  const invoker = await getInvoker(context, { resourceName, handler: lambdaConfig.handler, envVars });
  context.print.success('Starting execution...');
  await timeConstrainedInvoker(invoker({ event }), context.input.options)
    .then(result => {
      const msg = typeof result === 'object' ? JSON.stringify(result) : result;
      context.print.success('Result:');
      context.print.info(typeof result === 'undefined' ? '' : msg);
    })
    .catch(error => {
      context.print.error(`${resourceName} failed with the following error:`);
      context.print.info(error);
    })
    .then(() => context.print.success('Finished execution.'));
}

interface InvokerOptions {
  timeout?: string;
}
export const timeConstrainedInvoker: <T>(p: Promise<T>, opts: InvokerOptions) => Promise<T> = (promise, options): Promise<any> =>
  Promise.race([promise, getTimer(options)]);

const getTimer = (options: { timeout?: string }) => {
  const inputTimeout = Number.parseInt(options?.timeout, 10);
  const lambdaTimeoutSeconds = !!inputTimeout && inputTimeout > 0 ? inputTimeout : DEFAULT_TIMEOUT_SECONDS;
  const timeoutErrorMessage = `Lambda execution timed out after ${lambdaTimeoutSeconds} seconds. Press ctrl + C to exit the process.
    To increase the lambda timeout use the --timeout parameter to set a value in seconds.
    Note that the maximum Lambda execution time is 15 minutes:
    https://aws.amazon.com/about-aws/whats-new/2018/10/aws-lambda-supports-functions-that-can-run-up-to-15-minutes/\n`;
  return new Promise((_, reject) => setTimeout(() => reject(new Error(timeoutErrorMessage)), lambdaTimeoutSeconds * 1000));
};

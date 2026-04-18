#!/usr/bin/env bun
import { config } from 'dotenv';
import { runCli } from './cli.js';
import { parseArgs } from './commands/parse-args.js';
import { dispatch } from './commands/dispatch.js';

// Load environment variables
config({ quiet: true });

const parsed = parseArgs();

if (parsed.subcommand === 'chat') {
  await runCli();
} else if (parsed.subcommand === 'init') {
  await runCli({ forceSetup: true });
} else {
  await dispatch(parsed);
}

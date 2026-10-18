#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { initCommand } from '../commands/init';
import { runCommand } from '../commands/run';
import { witnessCommand } from '../commands/capture';
import { approveCommand } from '../commands/approve';
import { mergeCapturesCommand } from '../commands/merge-captures';
import { reportCommand } from '../commands/report';
import { envCommand } from '../commands/env';

const packageJson = require('../../package.json');

const program = new Command();

// Display banner
const showBanner = () => {
  console.log();
  console.log(chalk.cyan.bold('  TestivAI'));
  console.log(chalk.gray('  Local-first visual regression testing'));
  console.log();
};

program
  .name('testivai')
  .description('TestivAI Witness SDK - Framework-agnostic visual regression testing')
  .version(packageJson.version, '-V, --version', 'Display version number')
  .hook('preAction', () => {
    // Keep stdout clean for machine-readable output: no banner under --json
    // (or --quiet/-q). Agents parse stdout as a single JSON document.
    const quiet =
      process.argv.includes('--quiet') ||
      process.argv.includes('-q') ||
      process.argv.includes('--json');
    if (!quiet) {
      showBanner();
    }
  });

// Global options
program
  .option('-v, --verbose', 'Enable verbose output')
  .option('-q, --quiet', 'Suppress output (ideal for CI)')
  .option('--debug', 'Enable debug mode');

// Add commands
program.addCommand(initCommand);
program.addCommand(runCommand);
program.addCommand(witnessCommand);
program.addCommand(approveCommand);
program.addCommand(mergeCapturesCommand);
program.addCommand(reportCommand);
program.addCommand(envCommand);

// Parse arguments
program.parse();

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}

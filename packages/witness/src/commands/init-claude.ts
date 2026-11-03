import { Command } from 'commander';
import chalk from 'chalk';
import { CLAUDE_SKILL_PATH, installClaudeSkill } from '../claude/skill';

export const initClaudeCommand = new Command('init-claude')
  .description(`Add the /testivai command for Claude Code to this project (${CLAUDE_SKILL_PATH})`)
  .option('-f, --force', 'Replace the file when it differs from this version')
  .option('--json', 'Print a machine-readable result to stdout')
  .action((options: { force?: boolean; json?: boolean }) => {
    const result = installClaudeSkill(process.cwd(), { force: options.force });
    if (result.status === 'conflict') process.exitCode = 1;
    if (options.json) {
      process.stdout.write(JSON.stringify(result) + '\n');
      return;
    }
    if (result.status === 'conflict') {
      console.error(chalk.yellow(`  ${result.path} exists and differs from this version: kept. Run with --force to replace it.`));
      return;
    }
    const verb = { created: 'Created', updated: 'Replaced', unchanged: 'Already up to date:' }[result.status];
    console.log(chalk.green(`  ${verb} ${result.path}`));
    console.log('  Commit it, then type /testivai status, /testivai report or /testivai approve <name|--all> in Claude Code');
    console.log('  (terminal, desktop app, or a claude.ai/code session on this repository).');
  });

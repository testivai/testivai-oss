import { Command } from 'commander';
import chalk from 'chalk';
import { BaselineStore } from '../baselines/store';
import { parseHealth } from '../capture/health';
import { approveHealthWarning } from '../report/health';
import { logger } from '../utils/logger';

/**
 * Warn when the capture about to become the baseline is unhealthy (a font or
 * stylesheet failed to load): every compare against it would say so. It is
 * still approved. With --json the warning goes to stderr, so stdout stays the
 * JSON result.
 */
function warnIfUnhealthy(store: BaselineStore, name: string, json: boolean | undefined): void {
  const warning = approveHealthWarning(parseHealth(store.readTempMetadata(name)?.health));
  if (!warning) return;
  const line = `  ⚠ ${name}: ${warning}.`;
  if (json) process.stderr.write(`${line}\n`);
  else console.log(chalk.yellow(line));
}

export const approveCommand = new Command('approve')
  .description('Approve visual snapshots as new baselines')
  .argument('[name]', 'Snapshot name to approve (omit for interactive list)')
  .option('--all', 'Approve all changed/new snapshots')
  .option('--undo', 'Undo the last approval (restore previous baseline)')
  .option('--dry-run', 'Show what would be approved without modifying any files')
  .option('--json', 'Print a machine-readable result to stdout instead of the pretty output')
  .action(async (name: string | undefined, options: { all?: boolean; undo?: boolean; dryRun?: boolean; json?: boolean }) => {
    try {
      const cwd = process.cwd();
      const store = new BaselineStore(cwd);

      // ── Undo mode ─────────────────────────────────────────────────────────
      if (options.undo) {
        const undoName = name ?? store.findLatestUndoable();
        if (!undoName) {
          console.log(chalk.yellow('  No previous baseline found to undo.'));
          return;
        }
        try {
          store.undo(undoName);
          console.log(chalk.green(`  ✓ Restored previous baseline for "${undoName}"`));
          console.log(chalk.gray(`    git add .testivai/baselines/${undoName}/`));
        } catch (err: any) {
          logger.error(err.message);
          process.exit(1);
        }
        return;
      }

      // ── Dry-run mode ──────────────────────────────────────────────────────
      if (options.dryRun) {
        if (name) {
          // Explicit name: verify temp exists
          if (store.readTemp(name) === null) {
            logger.error(`No temp screenshot found for "${name}". Run your tests first.`);
            process.exit(1);
          }
          console.log(chalk.cyan(`  would approve: ${name}`));
          return;
        }
        const tempNames = store.listTemp();
        if (tempNames.length === 0) {
          console.log(chalk.yellow('  No temp snapshots found. Run your tests first.'));
          return;
        }
        for (const snapName of tempNames) {
          console.log(chalk.cyan(`  would approve: ${snapName}`));
        }
        return;
      }

      // ── Approve all ─────────────────────────────────────────────────────────
      if (options.all) {
        const tempNames = store.listTemp();
        if (tempNames.length === 0) {
          if (options.json) process.stdout.write(JSON.stringify({ approved: [], failed: [] }) + '\n');
          else console.log(chalk.yellow('  No temp snapshots found. Run your tests first.'));
          return;
        }

        const approvedNames: string[] = [];
        const failed: Array<{ name: string; error: string }> = [];
        for (const snapName of tempNames) {
          try {
            warnIfUnhealthy(store, snapName, options.json);
            store.approve(snapName);
            approvedNames.push(snapName);
            if (!options.json) console.log(chalk.green(`  ✓ Approved: ${snapName}`));
          } catch (err: any) {
            failed.push({ name: snapName, error: err.message });
            if (!options.json) logger.error(`  ✗ Failed to approve "${snapName}": ${err.message}`);
          }
        }

        if (options.json) {
          process.stdout.write(JSON.stringify({ approved: approvedNames, failed }) + '\n');
        } else {
          console.log();
          console.log(chalk.cyan(`  ${approvedNames.length}/${tempNames.length} snapshot(s) approved.`));
          console.log(chalk.gray('  git add .testivai/baselines/'));
        }
        if (failed.length > 0) process.exitCode = 1;
        return;
      }

      // ── Approve specific name ─────────────────────────────────────────────
      if (name) {
        try {
          warnIfUnhealthy(store, name, options.json);
          store.approve(name);
          if (options.json) process.stdout.write(JSON.stringify({ approved: [name], failed: [] }) + '\n');
          else {
            console.log(chalk.green(`  ✓ Approved: ${name}`));
            console.log(chalk.gray(`    git add .testivai/baselines/${name}/`));
          }
        } catch (err: any) {
          if (options.json) process.stdout.write(JSON.stringify({ approved: [], failed: [{ name, error: err.message }] }) + '\n');
          else logger.error(err.message);
          process.exit(1);
        }
        return;
      }

      // ── No name, no --all: show available snapshots ─────────────────────────
      const tempNames = store.listTemp();
      if (tempNames.length === 0) {
        console.log(chalk.yellow('  No temp snapshots found. Run your tests first.'));
        return;
      }

      console.log(chalk.cyan('  Available snapshots to approve:\n'));
      for (const snapName of tempNames) {
        const isNew = !store.exists(snapName);
        const label = isNew ? chalk.yellow('[new]') : chalk.red('[changed]');
        console.log(`    ${label} ${snapName}`);
      }
      console.log();
      console.log(chalk.gray('  To approve:  testivai approve <name>'));
      console.log(chalk.gray('  To approve all: testivai approve --all'));

    } catch (error: any) {
      logger.error('Approve failed:', error);
      process.exit(1);
    }
  });

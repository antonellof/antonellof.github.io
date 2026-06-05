---
layout: post
title: "Building CLI Tools with Node.js"
date: 2021-06-13
categories: [How-To]
tags: [Node.js, CLI, Developer Tools]
excerpt: "The best CLI tools feel like Unix commands that happen to be written in JavaScript. Commander for parsing, Inquirer for prompts, and the UX details—exit codes, spinners, helpful errors—that separate toys from tools people actually use."
---

Every team has scripts. `deploy.sh` that nobody understands. `migrate.js` that requires three environment variables and a prayer. `setup.py` that works on Dave's machine.

The difference between scripts and CLI tools is intention: CLIs have help text, proper argument parsing, error messages that tell you what to fix, and exit codes your CI pipeline can trust. They're products, not duct tape.

I've built CLI tools that became daily workflow for hundreds of engineers—deployment tools, code generators, data migration utilities. The stack is always the same: Node.js, Commander for arguments, Inquirer for interactivity, Chalk for output, Ora for spinners. Boring choices. They work.

## Project Setup

```json
{
  "name": "@company/deploy-cli",
  "version": "1.0.0",
  "bin": {
    "deploy": "./bin/cli.js"
  },
  "type": "module",
  "dependencies": {
    "commander": "^11.0.0",
    "inquirer": "^9.0.0",
    "chalk": "^5.0.0",
    "ora": "^7.0.0",
    "cli-progress": "^3.12.0"
  }
}
```

```javascript
#!/usr/bin/env node
// bin/cli.js

import { program } from 'commander';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));

program
    .name('deploy')
    .description('Deploy applications to staging and production')
    .version(pkg.version);

// Commands defined here...

program.parse();
```

The shebang (`#!/usr/bin/env node`) makes it executable. The `bin` field in package.json links it globally on `npm install -g`.

## Argument Parsing with Commander

```javascript
program
    .command('deploy')
    .description('Deploy an application')
    .argument('<environment>', 'Target environment (staging|production)')
    .option('-a, --app <name>', 'Application name', 'default')
    .option('-f, --force', 'Skip confirmation prompt')
    .option('-d, --dry-run', 'Show what would happen without deploying')
    .action(async (environment, options) => {
        if (!['staging', 'production'].includes(environment)) {
            console.error(chalk.red(`Invalid environment: ${environment}`));
            process.exit(1);
        }
        
        if (environment === 'production' && !options.force) {
            const { confirm } = await inquirer.prompt([{
                type: 'confirm',
                name: 'confirm',
                message: chalk.yellow('Deploy to PRODUCTION?'),
                default: false
            }]);
            
            if (!confirm) {
                console.log('Cancelled.');
                process.exit(0);
            }
        }
        
        await deploy(environment, options);
    });
```

Commander handles `--help` automatically. Users run `deploy --help` and see usage. This alone separates CLIs from scripts.

### Subcommands for Complex Tools

```javascript
program
    .command('db')
    .description('Database operations');

program
    .command('db:migrate')
    .description('Run pending migrations')
    .option('--to <version>', 'Migrate to specific version')
    .action(async (options) => { /* ... */ });

program
    .command('db:rollback')
    .description('Rollback last migration')
    .action(async () => { /* ... */ });
```

Group related commands. `deploy db:migrate` reads better than `deploy-db-migrate`.

## Interactive Prompts with Inquirer

For wizards and scaffolding:

```javascript
import inquirer from 'inquirer';

async function createProject() {
    const answers = await inquirer.prompt([
        {
            type: 'input',
            name: 'name',
            message: 'Project name:',
            validate: (input) => input.length > 0 || 'Name is required'
        },
        {
            type: 'list',
            name: 'template',
            message: 'Choose template:',
            choices: ['api', 'worker', 'fullstack']
        },
        {
            type: 'checkbox',
            name: 'features',
            message: 'Include features:',
            choices: [
                { name: 'TypeScript', value: 'typescript', checked: true },
                { name: 'Docker', value: 'docker' },
                { name: 'CI/CD', value: 'cicd' },
                { name: 'Tests', value: 'tests', checked: true }
            ]
        },
        {
            type: 'confirm',
            name: 'install',
            message: 'Run npm install after creation?',
            default: true
        }
    ]);
    
    await scaffold(answers);
    console.log(chalk.green(`✓ Created ${answers.name}`));
}
```

Validate early. Give sensible defaults. Confirm destructive actions.

## Output That Doesn't Suck

### Chalk for Color

```javascript
import chalk from 'chalk';

console.log(chalk.red('Error:'), 'Deployment failed');
console.log(chalk.green('✓'), 'Migration complete');
console.log(chalk.dim('Tip:'), 'Run with --verbose for details');

// Semantic colors
const log = {
    info: (msg) => console.log(chalk.blue('ℹ'), msg),
    success: (msg) => console.log(chalk.green('✓'), msg),
    warn: (msg) => console.log(chalk.yellow('⚠'), msg),
    error: (msg) => console.error(chalk.red('✗'), msg),
};
```

Use color sparingly. Red for errors, green for success, yellow for warnings. Not rainbow vomit.

### Spinners for Long Operations

```javascript
import ora from 'ora';

async function deploy(env) {
    const spinner = ora(`Deploying to ${env}...`).start();
    
    try {
        await runDeployment(env);
        spinner.succeed(`Deployed to ${env}`);
    } catch (error) {
        spinner.fail(`Deployment to ${env} failed`);
        console.error(chalk.dim(error.message));
        process.exit(1);
    }
}
```

Users need feedback during 30-second operations. Spinners beat silent hangs.

### Progress Bars for Batch Work

```javascript
import cliProgress from 'cli-progress';

const bar = new cliProgress.SingleBar({
    format: '{bar} {percentage}% | {value}/{total} | {filename}',
    barCompleteChar: '█',
    barIncompleteChar: '░',
});

bar.start(files.length, 0);

for (const file of files) {
    await processFile(file);
    bar.increment({ filename: file });
}

bar.stop();
```

## File Operations

```javascript
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';

async function readConfig(path) {
    try {
        const content = await readFile(path, 'utf-8');
        return JSON.parse(content);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.error(chalk.red(`Config not found: ${path}`));
            console.error(chalk.dim('Run `deploy init` to create one.'));
        } else {
            console.error(chalk.red(`Failed to read config: ${error.message}`));
        }
        process.exit(1);
    }
}

async function writeOutput(path, content) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf-8');
}
```

Error messages should tell users **what went wrong** and **what to do next**. "ENOENT" means nothing to most humans.

## Exit Codes Matter

```javascript
// Success
process.exit(0);

// General error
process.exit(1);

// Specific errors (for CI scripting)
// 2 = invalid arguments
// 3 = config error
// 4 = deployment failed
```

CI pipelines check exit codes. `exit 0` on failure breaks automation silently. Be deliberate.

## Global Error Handling

```javascript
process.on('uncaughtException', (error) => {
    console.error(chalk.red('Unexpected error:'), error.message);
    if (process.env.DEBUG) console.error(error.stack);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error(chalk.red('Unhandled promise rejection:'), reason);
    process.exit(1);
});
```

## Testing CLI Tools

```javascript
import { execSync } from 'child_process';

test('--help exits 0', () => {
    expect(() => {
        execSync('node bin/cli.js --help', { encoding: 'utf-8' });
    }).not.toThrow();
});

test('invalid environment exits 1', () => {
    expect(() => {
        execSync('node bin/cli.js deploy invalid', { encoding: 'utf-8' });
    }).toThrow();
});
```

Test help text, argument validation, and exit codes. Integration tests for critical paths.

## Distribution

```bash
# Local development
npm link

# Publish to npm (public or private registry)
npm publish --access restricted

# Single executable with pkg or nexe
npx pkg bin/cli.js --targets node18-linux-x64,node18-macos-x64
```

For internal tools, private npm registry or `npx` from GitHub repo works well.

## CLI UX Checklist

1. **`--help` on every command** — Commander does this; don't break it
2. **Validate arguments early** — before any async work
3. **Confirm destructive actions** — especially production deploys
4. **Show progress** — spinners, bars, or verbose logging
5. **Meaningful errors** — what failed + how to fix
6. **Proper exit codes** — 0 success, non-zero failure
7. **Respect `--verbose` / `--quiet`** — power users and CI have different needs
8. **`--version`** — always

## Conclusion

CLI tools are user interfaces. Your users are developers, but they're still users. They deserve help text, clear errors, and feedback during long operations.

Commander handles parsing. Inquirer handles interactivity. Chalk and Ora handle output. Your job is the domain logic and the UX decisions: what to confirm, what to validate, what to show when things fail.

The `deploy.sh` scripts that only Dave understood became `deploy` CLI tools the whole team used daily. Same functionality. Radically better experience. That's the bar.

Build the tool you'd want to use at 5 PM on a Friday. Clear help, safe defaults, loud failures. Ship it.

---

*Building CLI tools with Node.js from June 2021, covering argument parsing, prompts, and styling.*

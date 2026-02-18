---
layout: post
title: "Building CLI Tools with Node.js"
date: 2021-06-13
categories: [How-To]
tags: [Node.js, CLI, Developer Tools]
excerpt: "Build command-line tools with Node.js: argument parsing, interactive prompts, colors, progress bars, and best practices for creating professional CLI applications."
---

CLI tools automate workflows. After building production CLI tools, here's how to create them effectively.

## Basic CLI Setup

### Package.json

```json
{
  "name": "my-cli",
  "version": "1.0.0",
  "bin": {
    "my-cli": "./bin/cli.js"
  },
  "dependencies": {
    "commander": "^11.0.0",
    "inquirer": "^9.0.0",
    "chalk": "^5.0.0"
  }
}
```

### Executable Script

```javascript
#!/usr/bin/env node
// bin/cli.js

const { program } = require('commander');

program
    .name('my-cli')
    .description('My awesome CLI tool')
    .version('1.0.0');

program
    .command('greet')
    .description('Greet someone')
    .argument('<name>', 'Name to greet')
    .option('-e, --excited', 'Add exclamation mark')
    .action((name, options) => {
        let message = `Hello, ${name}`;
        if (options.excited) {
            message += '!';
        }
        console.log(message);
    });

program.parse();
```

## Argument Parsing

### Commander.js

```javascript
const { program } = require('commander');

program
    .name('file-manager')
    .description('File management CLI')
    .version('1.0.0');

program
    .command('copy')
    .description('Copy a file')
    .argument('<source>', 'Source file')
    .argument('<dest>', 'Destination file')
    .option('-f, --force', 'Overwrite existing file')
    .action((source, dest, options) => {
        // Implementation
        console.log(`Copying ${source} to ${dest}`);
        if (options.force) {
            console.log('Force overwrite enabled');
        }
    });

program
    .command('delete')
    .description('Delete a file')
    .argument('<file>', 'File to delete')
    .option('-r, --recursive', 'Recursive delete')
    .action((file, options) => {
        console.log(`Deleting ${file}`);
    });

program.parse();
```

## Interactive Prompts

### Inquirer

```javascript
const inquirer = require('inquirer');

async function createProject() {
    const answers = await inquirer.prompt([
        {
            type: 'input',
            name: 'projectName',
            message: 'What is your project name?',
            validate: (input) => {
                if (!input) {
                    return 'Project name is required';
                }
                return true;
            }
        },
        {
            type: 'list',
            name: 'framework',
            message: 'Which framework?',
            choices: ['React', 'Vue', 'Angular']
        },
        {
            type: 'checkbox',
            name: 'features',
            message: 'Select features:',
            choices: [
                { name: 'TypeScript', value: 'typescript' },
                { name: 'Testing', value: 'testing' },
                { name: 'Linting', value: 'linting' }
            ]
        },
        {
            type: 'confirm',
            name: 'install',
            message: 'Install dependencies?',
            default: true
        }
    ]);
    
    console.log('Answers:', answers);
}

createProject();
```

## Colors and Styling

### Chalk

```javascript
const chalk = require('chalk');

console.log(chalk.blue('Blue text'));
console.log(chalk.red.bold('Red bold text'));
console.log(chalk.green.underline('Green underlined'));
console.log(chalk.bgYellow.black('Yellow background'));

// Template literals
console.log(chalk`
  {red Error:} {yellow Warning message}
  {green Success:} Operation completed
`);
```

### Progress Bars

```javascript
const cliProgress = require('cli-progress');

const bar = new cliProgress.SingleBar({
    format: 'Progress |{bar}| {percentage}% | {value}/{total}',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true
});

bar.start(100, 0);

for (let i = 0; i <= 100; i++) {
    bar.update(i);
    await sleep(50);
}

bar.stop();
```

## File Operations

### Reading Files

```javascript
const fs = require('fs').promises;
const path = require('path');

async function readConfig(configPath) {
    try {
        const content = await fs.readFile(configPath, 'utf-8');
        return JSON.parse(content);
    } catch (error) {
        console.error(`Error reading config: ${error.message}`);
        process.exit(1);
    }
}
```

### Writing Files

```javascript
async function writeFile(filePath, content) {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
}
```

## Spinners

### Ora

```javascript
const ora = require('ora');

async function longRunningTask() {
    const spinner = ora('Processing...').start();
    
    try {
        await processData();
        spinner.succeed('Processing completed!');
    } catch (error) {
        spinner.fail('Processing failed!');
        console.error(error);
    }
}
```

## Error Handling

### Graceful Errors

```javascript
process.on('uncaughtException', (error) => {
    console.error(chalk.red('Uncaught exception:'), error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error(chalk.red('Unhandled rejection:'), reason);
    process.exit(1);
});
```

## Best Practices

1. **Clear commands** - Descriptive names
2. **Help text** - Document usage
3. **Error messages** - Helpful and actionable
4. **Exit codes** - Proper exit codes
5. **Input validation** - Validate early
6. **Progress feedback** - Show progress
7. **Colors** - Use sparingly
8. **Testing** - Test CLI tools

## Conclusion

Building CLI tools enables:
- Automation
- Developer productivity
- Better workflows
- Professional tools

Use commander for parsing, inquirer for prompts, and chalk for styling. The patterns shown here create production-ready CLI tools.

---

*Building CLI tools with Node.js from June 2021, covering argument parsing, prompts, and styling.*

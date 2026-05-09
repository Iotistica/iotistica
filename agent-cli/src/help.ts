import { CommandMap } from './command-types';

function isAliasCommand(command: string): boolean {
  return command.startsWith('-');
}

function formatSubcommands(command: string, subcommands: string[]): string[] {
  if (subcommands.length === 0) {
    return ['  ' + command];
  }

  return subcommands
    .sort((a, b) => a.localeCompare(b))
    .map((subcommand) => '  ' + command + ' ' + subcommand);
}

export function showHelp(commands: CommandMap): void {
  const topLevel = Object.keys(commands)
    .filter((command) => !isAliasCommand(command))
    .sort((a, b) => a.localeCompare(b));

  const aliasTopLevel = Object.keys(commands)
    .filter((command) => isAliasCommand(command))
    .sort((a, b) => a.localeCompare(b));

  const rows: string[] = [];

  rows.push('');
  rows.push('╔═══════════════════════════════════════════════════════════════════════════╗');
  rows.push('║                           iotctl - IoT Control                             ║');
  rows.push('║                        Iotistica Device Management CLI                      ║');
  rows.push('╚═══════════════════════════════════════════════════════════════════════════╝');
  rows.push('');
  rows.push('AVAILABLE COMMANDS (generated from live dispatcher):');
  rows.push('');

  for (const command of topLevel) {
    const commandGroup = commands[command];
    const subcommands = Object.keys(commandGroup).filter((key) => key !== '_default');
    rows.push(...formatSubcommands(command, subcommands));
  }

  if (aliasTopLevel.length > 0) {
    rows.push('');
    rows.push('ALIASES:');
    for (const alias of aliasTopLevel) {
      rows.push('  ' + alias);
    }
  }

  rows.push('');
  rows.push('NOTE: Commands with no subcommands accept a direct form, e.g. iotctl status.');
  rows.push('');

  console.log(rows.join('\n'));
}

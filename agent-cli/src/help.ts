import { CommandMap } from './command-types';

function isAliasCommand(command: string): boolean {
  return command.startsWith('-');
}

function formatSubcommands(command: string, subcommands: string[]): string[] {
  if (subcommands.length === 0) {
    return ['  ' + command];
  }

  const unique = Array.from(new Set(subcommands));
  return unique
    .sort((a, b) => a.localeCompare(b))
    .map((subcommand) => (subcommand.length === 0 ? '  ' + command : '  ' + command + ' ' + subcommand));
}

function collectCommands(prefix: string, group: any): string[] {
  const rows: string[] = [];

  if (group && typeof group === 'object' && typeof group._default === 'function') {
    rows.push(prefix);
  }

  const keys = Object.keys(group).filter((key) => key !== '_default');
  if (keys.length === 0) {
    return rows.length > 0 ? rows : [prefix];
  }

  for (const key of keys) {
    const value = group[key];
    const nextPrefix = `${prefix} ${key}`;
    if (typeof value === 'function') {
      rows.push(nextPrefix);
    } else if (value && typeof value === 'object') {
      rows.push(...collectCommands(nextPrefix, value));
    }
  }

  return rows;
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
  rows.push('║                           iotctl - IoT Control                            ║');
  rows.push('║                        Iotistica Management CLI                           ║');
  rows.push('╚═══════════════════════════════════════════════════════════════════════════╝');
  rows.push('');
  rows.push('AVAILABLE COMMANDS (generated from live dispatcher):');
  rows.push('');

  for (const command of topLevel) {
    const commandGroup = commands[command];
    const subcommands = collectCommands(command, commandGroup).map((entry) => entry.slice(command.length + 1));
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
  rows.push('NOTE: Direct command forms are included when a group has a default handler.');
  rows.push('');

  console.log(rows.join('\n'));
}

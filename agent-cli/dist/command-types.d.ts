export type CommandHandler = (...args: any[]) => any;
export interface CommandGroup {
    [key: string]: CommandHandler | CommandGroup | undefined;
    _default?: CommandHandler;
}
export type CommandMap = Record<string, CommandGroup>;
//# sourceMappingURL=command-types.d.ts.map
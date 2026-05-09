export type CommandHandler = (...args: any[]) => any;

export type CommandGroup = Record<string, CommandHandler> & {
  _default?: CommandHandler;
};

export type CommandMap = Record<string, CommandGroup>;

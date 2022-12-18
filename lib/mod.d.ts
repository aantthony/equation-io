declare module 'node-color-readline' {
  import * as readline from 'readline';
  export function createInterface(options: readline.ReadLineOptions & {
    colorize: (str: string) => string;
  }): readline.Interface;
}
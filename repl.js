const colorReadline = require('node-color-readline');
const chalk = require('chalk');
const { partial } = require('./');

const repl = colorReadline.createInterface({
  input: process.stdin,
  output: process.stdout,
  colorize: function (str) {
    const { error, tokens, stack, output } = partial(str);

    const openParen = stack.slice(0).reverse().find(t => t.type === 'parenopen');
    const errorToken = error ? error.token : null;

    return tokens.map((t, i) => {
      if (t === errorToken) return chalk.bgRed(t.str);
      if (t.type === 'string') return chalk.green(t.str);
      if (t.type === 'number') return chalk.yellow(t.str);
      if (t.type === 'symbol') return chalk.magenta(t.str);
      if (t.type === 'parenopen' && t === openParen) return chalk.underline.white(t.str);
      if (t.type === 'parenopen') return chalk.white(t.str);
      if (t.type === 'parenclose') return chalk.white(t.str);
      return t.str;
    }).join('');
  }
});
 
repl.on('line', function (cmd) {
  console.log('LINE:', cmd);
});
 
repl.prompt();
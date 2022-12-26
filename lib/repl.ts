import colorReadline from 'node-color-readline';
import 'source-map-support/register';
import formatMs from './format';
import { DeclarationNode, parse } from './syntax';

const repl = colorReadline.createInterface({
  input: process.stdin,
  output: process.stdout,
  colorize: function (str) {
    return str;
    // const { error, tokens, stack, output } = partial(str);

    // const openParen = stack.slice(0).reverse().find(t => t.type === 'parenopen');
    // const errorToken = error ? error.token : null;

    // return tokens.map((t, i) => {
    //   if (t === errorToken) return chalk.bgRed(t.str);
    //   if (t.type === 'string') return chalk.green(t.str);
    //   if (t.type === 'number') return chalk.yellow(t.str);
    //   if (t.type === 'symbol') return chalk.magenta(t.str);
    //   if (t.type === 'parenopen' && t === openParen) return chalk.underline.white(t.str);
    //   if (t.type === 'parenopen') return chalk.white(t.str);
    //   if (t.type === 'parenclose') return chalk.white(t.str);
    //   return t.str;
    // }).join('');
  }
});

const globals = new Map<string, DeclarationNode>();

function def(name: string, str: string) {
  const res = parse(str, globals);
  if (!res) return;
  if (res.type !== 'value') {
    console.log('Not a value');
    return;
  }

  globals.set(name, {
    id: { type: 'identifier', name },
    type: 'declaration',
    value: res.value,
  });
}

repl.on('line', function (cmd) {
  try {
    let res = parse(cmd, globals);
    if (!res) {
      repl.prompt();
      return;
    }
  
    if (res.type === 'assignment') {
      globals.set(res.l.id.name, {
        type: 'declaration',
        id: res.l.id,
        value: res.r,
      });
    }
  
    if (res.type === 'value') {
      const v = res.value;
      // const f = res;
      // globals.set('_', {
      //   type: 'declaration',
      //   id: { type: 'identifier', name: '_' },
      //   value: res,
      // });
      console.log(formatMs(v));
  
    } else {
      console.log(res);
    }
    
    repl.prompt();
  } catch (e) {
    console.error(e);
    repl.prompt();
  }
});

repl.prompt();
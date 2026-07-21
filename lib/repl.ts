import readline from 'node:readline';
import formatMs from './format.ts';
import { type DeclarationNode, parse } from './syntax.ts';

const repl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
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
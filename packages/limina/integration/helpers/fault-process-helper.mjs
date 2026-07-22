#!/usr/bin/env node

import process from 'node:process';
import { setInterval, setTimeout } from 'node:timers';

const [mode, value] = process.argv.slice(2);

switch (mode) {
  case 'exit': {
    const exitCode = Number(value);
    if (!Number.isInteger(exitCode) || exitCode < 1 || exitCode > 255) {
      throw new Error('exit mode requires an exit code from 1 through 255');
    }
    process.exitCode = exitCode;
    break;
  }
  case 'invalid-protocol': {
    if (!value) throw new Error('invalid-protocol mode requires a payload');
    process.stdout.write(value);
    break;
  }
  case 'ipc-invalid': {
    if (!value) throw new Error('ipc-invalid mode requires a payload');
    if (typeof process.send !== 'function') {
      throw new TypeError('ipc-invalid mode requires an IPC channel');
    }
    process.on('message', () => {
      process.send?.(value, () => process.disconnect());
    });
    break;
  }
  case 'signal': {
    if (value !== 'SIGINT' && value !== 'SIGKILL' && value !== 'SIGTERM') {
      throw new Error('signal mode requires SIGINT, SIGKILL, or SIGTERM');
    }
    process.kill(process.pid, value);
    break;
  }
  case 'streams': {
    process.stdout.write('stdout-one\n');
    process.stderr.write('stderr-one\n');
    setTimeout(() => {
      process.stdout.write('stdout-two\n');
      process.stderr.write('stderr-two\n');
    }, 10);
    break;
  }
  case 'streams-exit': {
    const exitCode = Number(value);
    if (!Number.isInteger(exitCode) || exitCode < 1 || exitCode > 255) {
      throw new Error(
        'streams-exit mode requires an exit code from 1 through 255',
      );
    }
    process.stdout.write('stdout-one\n');
    process.stderr.write('stderr-one\n');
    setTimeout(() => {
      process.stdout.write('stdout-two\n');
      process.stderr.write('stderr-two\n');
      process.exitCode = exitCode;
    }, 10);
    break;
  }
  case 'success': {
    process.stdout.write('helper-success\n');
    break;
  }
  case 'timeout': {
    process.stdout.write('helper-waiting\n');
    setInterval(Date.now, 1000);
    break;
  }
  default: {
    throw new Error(`unsupported fault helper mode: ${String(mode)}`);
  }
}

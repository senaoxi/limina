import { type FlowOutputMessage, toWritableText } from './render-model';
import {
  type FlowWrite,
  type FlowWriteArgs,
  type FlowWriteCallback,
  writeWithFlowArgs,
} from './terminal-frame';

type WriteStreamName = 'stderr' | 'stdout';

function getWriteCallback(args: FlowWriteArgs): FlowWriteCallback | undefined {
  if (args.length === 3) return args[2];
  if (typeof args[1] === 'function') return args[1];
  return undefined;
}

function callWriteCallback(args: FlowWriteArgs): void {
  const callback = getWriteCallback(args);
  if (callback) queueMicrotask(callback);
}

export function patchRendererWriteStream(options: {
  active: () => boolean;
  output: (output: FlowOutputMessage) => void;
  stream: NodeJS.WriteStream;
  streamName: WriteStreamName;
}): () => void {
  const originalWrite = options.stream.write;

  options.stream.write = ((...args: FlowWriteArgs) => {
    if (options.active()) {
      options.output({
        stream: options.streamName,
        text: toWritableText(args[0]),
      });
      callWriteCallback(args);
      return true;
    }
    return writeWithFlowArgs(originalWrite as FlowWrite, args);
  }) as NodeJS.WriteStream['write'];

  return () => {
    options.stream.write = originalWrite;
  };
}

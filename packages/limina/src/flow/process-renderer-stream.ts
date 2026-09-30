import { type FlowOutputMessage, toWritableText } from './render-model';
import {
  type FlowWrite,
  type FlowWriteArguments,
  type FlowWriteCallback,
  isWriteWithFlowArguments as writeWithFlowArguments,
} from './terminal-frame';

type WriteStreamName = 'stderr' | 'stdout';

function getWriteCallback(
  arguments_: FlowWriteArguments,
): FlowWriteCallback | undefined {
  if (arguments_.length === 3) return arguments_[2];
  return typeof arguments_[1] === 'function' ? arguments_[1] : undefined;
}

function callWriteCallback(arguments_: FlowWriteArguments): void {
  const callback = getWriteCallback(arguments_);
  if (callback) queueMicrotask(callback);
}

export function patchRendererWriteStream(options: {
  active: () => boolean;
  output: (output: FlowOutputMessage) => void;
  stream: NodeJS.WriteStream;
  streamName: WriteStreamName;
}): () => void {
  const originalWrite = options.stream.write;

  options.stream.write = ((...arguments_: FlowWriteArguments) => {
    if (options.active()) {
      options.output({
        stream: options.streamName,
        text: toWritableText(arguments_[0]),
      });
      callWriteCallback(arguments_);
      return true;
    }
    return writeWithFlowArguments(originalWrite as FlowWrite, arguments_);
  }) as NodeJS.WriteStream['write'];

  return () => {
    options.stream.write = originalWrite;
  };
}

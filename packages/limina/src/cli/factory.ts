import { cac } from 'cac';
import { registerBuildCommand } from './register/build';
import { registerCheckCommand } from './register/check';
import { registerCheckerCommand } from './register/checker';
import { registerGraphCommand } from './register/graph';
import { registerPackageCommands } from './register/package';
import { registerProofCommand } from './register/proof';
import { registerSetupCommands } from './register/setup';
import { registerSourceCommand } from './register/source';

export function createLiminaCli(): ReturnType<typeof cac> {
  const cli = cac('limina');
  cli.option('--config <path>', 'Path to a Limina config file');
  cli.option('--config-loader <loader>', 'Config loader to use: native, tsx');
  cli.option('--mode <mode>', 'Mode passed to limina config functions');
  cli.help();
  registerSetupCommands(cli);
  registerCheckCommand(cli);
  registerGraphCommand(cli);
  registerProofCommand(cli);
  registerSourceCommand(cli);
  registerBuildCommand(cli);
  registerCheckerCommand(cli);
  registerPackageCommands(cli);
  return cli;
}

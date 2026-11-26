import { spawnSync } from 'node:child_process';

const explicit = process.env.UBVE_PYTHON;
const windowsLauncher = !explicit && process.platform === 'win32';
const program = explicit || (windowsLauncher ? 'py' : 'python3');
const result = spawnSync(program, [...(windowsLauncher ? ['-3'] : []), ...process.argv.slice(2)], { stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;

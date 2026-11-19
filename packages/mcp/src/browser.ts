import { spawn } from 'node:child_process';

/**
 * Never through a shell (BUG-1618): `start` is a cmd.exe builtin, and cmd.exe
 * runs whatever follows a `&`, `|` or `^` in the link. rundll32 is a plain
 * executable that hands the link to the default browser as one argument.
 */
function launcher(platform: NodeJS.Platform): [string, ...string[]] {
  if (platform === 'darwin') return ['open'];
  if (platform === 'win32') return ['rundll32', 'url.dll,FileProtocolHandler'];
  return ['xdg-open'];
}

/**
 * Open the owner's browser at the consent page. Best effort by design: this
 * server also runs headless and over SSH, where there is no browser to ask —
 * the tool prints the URL either way, so a failure here costs a click.
 */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const [command, ...args] = launcher(platform);
  return new Promise((resolve) => {
    try {
      const child = spawn(command, [...args, url], { stdio: 'ignore', detached: true, shell: false });
      child.on('error', () => resolve(false));
      child.unref();
      resolve(true);
    } catch {
      resolve(false);
    }
  });
}

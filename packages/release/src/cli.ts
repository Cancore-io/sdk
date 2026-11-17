export type CliContext = { cwd: string; env: Record<string, string | undefined> };
export type CliResult = { code: number; stdout: string; stderr: string };

export async function main(_argv: string[], _ctx: CliContext): Promise<CliResult> {
  throw new Error('@cancore/release: main is not implemented');
}

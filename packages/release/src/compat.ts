export type NeighbourCheck = { neighbour: string; required: string; actual: string | null; ok: boolean };

export type VersionDocInput = {
  component: string;
  service?: string;
  version: string;
  gitSha: string;
  channel: string;
  builtAt?: string;
  requires?: Record<string, string>;
  compat?: NeighbourCheck[];
};

const notImplemented = (name: string): never => {
  throw new Error(`@cancore/release: ${name} is not implemented`);
};

export function satisfies(_version: string, _range: string): boolean {
  return notImplemented('satisfies');
}

export function checkNeighbours(_requires: Record<string, string>, _actuals: Record<string, string | null>): NeighbourCheck[] {
  return notImplemented('checkNeighbours');
}

export function versionDoc(_input: VersionDocInput): Record<string, unknown> {
  return notImplemented('versionDoc');
}

export type BumpLevel = 'major' | 'minor' | 'patch';
export type BumpSignal = { level: BumpLevel; rationale: string; defaulted: boolean };

const notImplemented = (name: string): never => {
  throw new Error(`@cancore/release: ${name} is not implemented`);
};

export function parseBumpLevel(_text: string): BumpLevel | null {
  return notImplemented('parseBumpLevel');
}

export function parseConventionalBump(_commitMessage: string): BumpLevel | null {
  return notImplemented('parseConventionalBump');
}

export function bumpVersion(_current: string, _level: BumpLevel): string {
  return notImplemented('bumpVersion');
}

export function resolveBumpSignal(_commitMessages: string[]): BumpSignal {
  return notImplemented('resolveBumpSignal');
}

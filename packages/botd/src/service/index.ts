/** Renders the systemd unit for cancore-botd. */
export function systemdUnit(options: { user: string; execPath: string; socketPath: string }): string {
  void options;
  throw new Error('not implemented');
}

/** Installs the unit and the `cancore-bot-clients` group; needs root. */
export function install(options: { user: string; execPath: string; socketPath: string }): Promise<void> {
  void options;
  throw new Error('not implemented');
}

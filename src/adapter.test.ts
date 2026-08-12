import { CANCORE_PROVIDER_ID, cancoreAdapterFactory } from './adapter';
import { CancoreProvider } from './provider';

describe('the PartyLayer discovery-adapter', () => {
  it('exposes the shape the generic bridge duck-types', () => {
    const factory = cancoreAdapterFactory();

    expect(factory.providerId).toBe(CANCORE_PROVIDER_ID);
    expect(typeof factory.create).toBe('function');

    const adapter = factory.create('https://app-dev.cancore.app');
    expect(adapter.providerId).toBe(CANCORE_PROVIDER_ID);
    expect(typeof adapter.detect).toBe('function');
    expect(typeof adapter.provider).toBe('function');
    expect(typeof adapter.teardown).toBe('function');
    expect(adapter.getInfo()).toMatchObject({ providerId: CANCORE_PROVIDER_ID, type: 'remote' });
  });

  it('is available without opening anything — nothing to install', async () => {
    await expect(cancoreAdapterFactory().create('https://app-dev.cancore.app').detect()).resolves.toBe(true);
  });

  // The bridge calls provider() repeatedly; a new provider each time would
  // drop the grant and the stream the previous one is holding.
  it('hands out one provider per adapter, and drops it on teardown', () => {
    const adapter = cancoreAdapterFactory({ appName: 'Test dApp' }).create('https://app-dev.cancore.app');

    const provider = adapter.provider();
    expect(provider).toBeInstanceOf(CancoreProvider);
    expect(adapter.provider()).toBe(provider);

    adapter.teardown();
    expect(adapter.provider()).not.toBe(provider);
  });
});

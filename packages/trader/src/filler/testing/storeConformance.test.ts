import { InMemoryFillerStore } from './memoryStore';
import { fillerStoreConformance } from './storeConformance';

describe('FillerStore conformance: InMemoryFillerStore', () => {
  test.each(fillerStoreConformance)('$name', async ({ run }) => {
    await run(new InMemoryFillerStore(), (actual, expected) => expect(actual).toEqual(expected));
  });
});

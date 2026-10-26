import { connectTestClient, newTestSession } from './test-server';

test('a tool call reaches the session with its arguments and returns the answer as JSON text', async () => {
  const session = newTestSession();
  const intentStatus = jest.spyOn(session, 'intentStatus').mockResolvedValue({ intentId: 'i-1', status: 'pending' });
  const { client, close } = await connectTestClient(session);
  const result = await client.callTool({ name: 'cancore_intent_status', arguments: { intentId: 'i-1' } });
  expect(intentStatus).toHaveBeenCalledWith('i-1');
  expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ intentId: 'i-1', status: 'pending' }, null, 2) }]);
  await close();
});

test('a wrong argument type is refused by the SDK before the session runs', async () => {
  const session = newTestSession();
  const intentStatus = jest.spyOn(session, 'intentStatus');
  const { client, close } = await connectTestClient(session);
  const result = await client.callTool({ name: 'cancore_intent_status', arguments: { intentId: 5 } });
  expect(result.isError).toBe(true);
  expect(intentStatus).not.toHaveBeenCalled();
  await close();
});

test('the agent label travels beside the proposal, not inside it', async () => {
  const session = newTestSession();
  const propose = jest.spyOn(session, 'proposeAutotrade').mockResolvedValue({ intentId: 'i-2' });
  const { client, close } = await connectTestClient(session);
  await client.callTool({
    name: 'cancore_propose_autotrade',
    arguments: { sourceTokenName: 'CC', targetTokenName: 'CBTC', sourceAmount: '5', agentLabel: 'bot' },
  });
  expect(propose).toHaveBeenCalledWith({ sourceTokenName: 'CC', targetTokenName: 'CBTC', sourceAmount: '5' }, 'bot');
  await close();
});

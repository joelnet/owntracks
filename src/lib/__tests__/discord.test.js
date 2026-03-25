import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// We can test the exported functions without actually connecting to Discord
// by creating the client and testing its behavior before/after ready state

describe('createDiscordClient', () => {
  // Test the module can be imported
  it('exports createDiscordClient function', async () => {
    const { createDiscordClient } = await import('../discord.js');
    assert.equal(typeof createDiscordClient, 'function');
  });

  it('getReady returns false before start', async () => {
    const { createDiscordClient } = await import('../discord.js');
    const discord = createDiscordClient({ token: 'fake', channelId: '123', guildId: '456' });
    assert.equal(discord.getReady(), false);
  });

  it('notify does not throw when not ready', async () => {
    const { createDiscordClient } = await import('../discord.js');
    const discord = createDiscordClient({ token: 'fake', channelId: '123', guildId: '456' });
    // Should no-op without error
    discord.notify('test message');
  });
});

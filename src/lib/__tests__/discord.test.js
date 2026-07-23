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

describe('parseLocationName', () => {
  it('extracts the name from an "Arrived at" notification', async () => {
    const { parseLocationName } = await import('../discord.js');
    assert.equal(
      parseLocationName('Arrived at Del Taco, 2401, South Azusa Avenue, West Covina'),
      'Del Taco, 2401, South Azusa Avenue, West Covina'
    );
  });

  it('extracts the name from a "POI Lookup at" notification', async () => {
    const { parseLocationName } = await import('../discord.js');
    assert.equal(parseLocationName('POI Lookup at Some Place, 123 Main St'), 'Some Place, 123 Main St');
  });

  it('extracts the name from a "Left … — N min visit" notification', async () => {
    const { parseLocationName } = await import('../discord.js');
    assert.equal(parseLocationName('Left Some Place, 123 Main St — 42 min visit'), 'Some Place, 123 Main St');
  });

  it('extracts the name from a "Left … (now Roaming)" notification', async () => {
    const { parseLocationName } = await import('../discord.js');
    assert.equal(parseLocationName('Left Del Taco, 2401 (now Roaming)'), 'Del Taco, 2401');
  });

  it('extracts the name from a "Currently at X" /location response', async () => {
    const { parseLocationName } = await import('../discord.js');
    assert.equal(parseLocationName('Currently at Jersey Mike\'s'), 'Jersey Mike\'s');
  });

  it('returns null for non-location messages', async () => {
    const { parseLocationName } = await import('../discord.js');
    assert.equal(parseLocationName('Now Driving'), null);
    assert.equal(parseLocationName('hello world'), null);
    assert.equal(parseLocationName(undefined), null);
  });

  it('does not treat "Currently Roaming" as a renameable name', async () => {
    const { parseLocationName } = await import('../discord.js');
    assert.equal(parseLocationName('Currently Roaming'), null);
  });
});

describe('parseLocationMessage', () => {
  it('classifies visit-flow messages as christening kinds', async () => {
    const { parseLocationMessage } = await import('../discord.js');
    assert.deepEqual(
      parseLocationMessage('POI Lookup at Some Place, 123 Main St'),
      { kind: 'poi_lookup', name: 'Some Place, 123 Main St' }
    );
    assert.deepEqual(
      parseLocationMessage('Left Some Place — 42 min visit'),
      { kind: 'visit_left', name: 'Some Place' }
    );
  });

  it('classifies POI-flow messages as established kinds', async () => {
    const { parseLocationMessage } = await import('../discord.js');
    assert.equal(parseLocationMessage('Arrived at Target').kind, 'arrival');
    assert.equal(parseLocationMessage('Left Target (now Roaming)').kind, 'poi_left');
    assert.equal(parseLocationMessage('Currently at Target').kind, 'current');
  });

  it('returns null for non-location messages', async () => {
    const { parseLocationMessage } = await import('../discord.js');
    assert.equal(parseLocationMessage('Now Driving'), null);
    assert.equal(parseLocationMessage(undefined), null);
  });
});

describe('isRoamingLocationMessage', () => {
  it('matches the /location Roaming response', async () => {
    const { isRoamingLocationMessage, ROAMING_LOCATION_MESSAGE } = await import('../discord.js');
    assert.equal(isRoamingLocationMessage('Currently Roaming'), true);
    assert.equal(isRoamingLocationMessage(ROAMING_LOCATION_MESSAGE), true);
  });

  it('does not match other location messages', async () => {
    const { isRoamingLocationMessage } = await import('../discord.js');
    assert.equal(isRoamingLocationMessage('Currently at Home'), false);
    assert.equal(isRoamingLocationMessage('Arrived at Target'), false);
    assert.equal(isRoamingLocationMessage(undefined), false);
  });
});

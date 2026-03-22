import { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } from 'discord.js';

export function createDiscordClient({ token, channelId, guildId, detector }) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  let ready = false;

  client.once('ready', async () => {
    ready = true;

    // Register /location as guild command
    const command = new SlashCommandBuilder()
      .setName('location')
      .setDescription('Show current location');

    const rest = new REST().setToken(token);
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, guildId),
      { body: [command.toJSON()] }
    );

    console.log(`Discord bot ready as ${client.user.tag}`);
  });

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'location') return;

    if (!detector) {
      await interaction.reply({ content: 'No location data available', flags: 64 });
      return;
    }

    const location = detector.getLocation();
    await interaction.reply({ content: `Currently ${location === 'Roaming' ? 'Roaming' : `at ${location}`}`, flags: 64 });
  });

  return {
    start() {
      return client.login(token);
    },
    notify(message) {
      if (!ready) return;
      const channel = client.channels.cache.get(channelId);
      if (channel) {
        channel.send(message).catch(err => console.error('Discord notify error:', err));
      }
    },
    getReady() {
      return ready;
    },
    destroy() {
      return client.destroy();
    },
  };
}

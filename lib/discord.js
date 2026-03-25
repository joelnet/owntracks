import { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } from 'discord.js';
import { generateReport } from './report.js';

export function createDiscordClient({ token, channelId, guildId, detector, config, dataDir }) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  let ready = false;

  client.once('clientReady', async () => {
    try {
      const locationCmd = new SlashCommandBuilder()
        .setName('location')
        .setDescription('Show current location');

      const reportCmd = new SlashCommandBuilder()
        .setName('location-report')
        .setDescription('Show daily location & activity report')
        .addStringOption(option =>
          option.setName('date')
            .setDescription('Date in YYYY-MM-DD format (defaults to today)')
            .setRequired(false)
        );

      const rest = new REST().setToken(token);
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, guildId),
        { body: [locationCmd.toJSON(), reportCmd.toJSON()] }
      );

      ready = true;
      console.log(`Discord bot ready as ${client.user.tag}`);
    } catch (err) {
      console.error('Discord setup error:', err.message);
    }
  });

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'location') {
      try {
        if (!detector) {
          await interaction.reply({ content: 'No location data available', ephemeral: true });
          return;
        }

        const location = detector.getLocation();
        await interaction.reply({ content: `Currently ${location === 'Roaming' ? 'Roaming' : `at ${location}`}`, ephemeral: true });
      } catch (err) {
        console.error('Discord interaction error:', err.message);
      }
      return;
    }

    if (interaction.commandName === 'location-report') {
      try {
        const tz = process.env.TZ || 'America/Los_Angeles';
        const date = interaction.options.getString('date')
          || new Date().toLocaleDateString('en-CA', { timeZone: tz });

        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          await interaction.reply({ content: 'Invalid date format. Use YYYY-MM-DD.', ephemeral: true });
          return;
        }

        if (!config || !dataDir) {
          await interaction.reply({ content: 'Report not available (server misconfigured).', ephemeral: true });
          return;
        }

        await interaction.deferReply();

        const report = generateReport(date, config, dataDir, tz);

        if (!report) {
          await interaction.editReply(`No location data found for ${date}`);
          return;
        }

        const content = '```\n' + report + '\n```';

        if (content.length <= 2000) {
          await interaction.editReply(content);
        } else {
          // Split into chunks if the report is too long for one message
          const chunks = splitMessage(report, 1990);
          await interaction.editReply('```\n' + chunks[0] + '\n```');
          for (let i = 1; i < chunks.length; i++) {
            await interaction.followUp('```\n' + chunks[i] + '\n```');
          }
        }
      } catch (err) {
        console.error('Discord report error:', err.message);
        try {
          if (interaction.deferred) {
            await interaction.editReply('Failed to generate report.');
          } else {
            await interaction.reply({ content: 'Failed to generate report.', ephemeral: true });
          }
        } catch { /* ignore follow-up errors */ }
      }
      return;
    }
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

function splitMessage(text, maxLen) {
  const lines = text.split('\n');
  const chunks = [];
  let current = '';

  for (const line of lines) {
    if (current.length + line.length + 1 > maxLen) {
      chunks.push(current);
      current = line;
    } else {
      current += (current ? '\n' : '') + line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

import 'dotenv/config';
import { Client, GatewayIntentBits, MessageFlags, Events } from 'discord.js';
import { Player, useQueue } from 'discord-player';
import { DefaultExtractors } from '@discord-player/extractor';
import { YoutubeiExtractor } from 'discord-player-youtubei';
import { commands } from './src/commands.js';
import { nowPlaying, notice, V2, RED } from './src/ui.js';

const { DISCORD_TOKEN, GUILD_ID } = process.env;
if (!DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN مش موجود في ملف .env');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const player = new Player(client);
await player.extractors.loadMulti(DefaultExtractors);
await player.extractors.register(YoutubeiExtractor, {});

const commandMap = new Map(commands.map((c) => [c.data.name, c]));

/* ---------- Player events ---------- */
player.events.on('playerStart', (queue, track) => {
  queue.metadata?.channel
    ?.send({ components: [nowPlaying(queue, track)], flags: V2 })
    .catch(() => {});
});

player.events.on('playerError', (queue, error) => {
  console.error('playerError:', error);
  queue.metadata?.channel
    ?.send({ components: [notice(`حصل خطأ في التشغيل: ${error.message}`, RED)], flags: V2 })
    .catch(() => {});
});

player.events.on('error', (queue, error) => console.error('queue error:', error));

/* ---------- Ready ---------- */
client.once(Events.ClientReady, async (c) => {
  console.log(`✅ شغال باسم ${c.user.tag}`);
  const body = commands.map((cmd) => cmd.data.toJSON());
  try {
    if (GUILD_ID) {
      await c.guilds.cache.get(GUILD_ID)?.commands.set(body);
      console.log(`📌 الأوامر اتسجلت في السيرفر ${GUILD_ID}`);
    } else {
      await c.application.commands.set(body);
      console.log('🌍 الأوامر اتسجلت عالمياً');
    }
  } catch (err) {
    console.error('فشل تسجيل الأوامر:', err);
  }
});

/* ---------- Interactions ---------- */
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const cmd = commandMap.get(interaction.commandName);
      if (cmd) await cmd.execute(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('music:')) {
      const action = interaction.customId.split(':')[1];
      const queue = useQueue(interaction.guildId);

      if (!queue || !queue.currentTrack) {
        return interaction.reply({
          components: [notice('مفيش حاجة شغالة دلوقتي.', RED)],
          flags: V2 | MessageFlags.Ephemeral,
        });
      }
      if (interaction.member.voice.channelId !== queue.channel?.id) {
        return interaction.reply({
          components: [notice('لازم تكون في نفس الروم الصوتي مع البوت.', RED)],
          flags: V2 | MessageFlags.Ephemeral,
        });
      }

      switch (action) {
        case 'toggle':
          queue.node.isPaused() ? queue.node.resume() : queue.node.pause();
          break;
        case 'skip':
          queue.node.skip();
          return interaction.reply({
            components: [notice(`⏭️ ${interaction.user} عدّى الأغنية.`)],
            flags: V2,
          });
        case 'stop':
          queue.delete();
          return interaction.update({
            components: [notice('⏹️ اتوقف التشغيل وخرج البوت من الروم.')],
            flags: V2,
          });
        case 'loop': {
          // 0 = off, 1 = track, 2 = queue
          queue.setRepeatMode((queue.repeatMode + 1) % 3);
          break;
        }
      }
      return interaction.update({
        components: [nowPlaying(queue, queue.currentTrack)],
        flags: V2,
      });
    }
  } catch (err) {
    console.error(err);
    const payload = {
      components: [notice('حصل خطأ غير متوقع.', RED)],
      flags: V2 | MessageFlags.Ephemeral,
    };
    if (interaction.deferred || interaction.replied) interaction.followUp(payload).catch(() => {});
    else interaction.reply(payload).catch(() => {});
  }
});

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));

client.login(DISCORD_TOKEN);

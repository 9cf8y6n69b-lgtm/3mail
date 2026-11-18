import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { QueueRepeatMode, useMainPlayer, useQueue } from 'discord-player';
import { GREEN, RED, V2, notice, nowPlaying, queueCard } from './ui.js';

const EPHEMERAL = V2 | MessageFlags.Ephemeral;

const fail = (interaction, message) =>
  interaction.reply({ components: [notice(message, RED)], flags: EPHEMERAL });

/** Returns the active queue if the member is in the same voice channel as the bot. */
async function requireQueue(interaction) {
  const queue = useQueue(interaction.guildId);
  if (!queue || !queue.currentTrack) {
    await fail(interaction, 'مفيش حاجة شغالة دلوقتي.');
    return null;
  }
  const vc = interaction.member.voice.channel;
  if (!vc || vc.id !== queue.channel?.id) {
    await fail(interaction, 'لازم تكون في نفس الروم الصوتي مع البوت.');
    return null;
  }
  return queue;
}

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('play')
      .setDescription('شغّل أغنية من اسم أو رابط (YouTube / Spotify / SoundCloud ...)')
      .addStringOption((o) =>
        o.setName('query').setDescription('اسم الأغنية أو الرابط').setRequired(true),
      ),
    async execute(interaction) {
      const channel = interaction.member.voice.channel;
      if (!channel) return fail(interaction, 'ادخل روم صوتي الأول.');

      const me = interaction.guild.members.me;
      const perms = channel.permissionsFor(me);
      if (!perms?.has(['Connect', 'Speak'])) {
        return fail(interaction, 'البوت مش معاه صلاحية Connect / Speak في الروم ده.');
      }

      await interaction.deferReply();
      const player = useMainPlayer();
      const query = interaction.options.getString('query', true);

      try {
        const { track, searchResult } = await player.play(channel, query, {
          requestedBy: interaction.user,
          nodeOptions: {
            metadata: { channel: interaction.channel },
            volume: 50,
            selfDeaf: true,
            leaveOnEmpty: true,
            leaveOnEmptyCooldown: 60_000,
            leaveOnEnd: true,
            leaveOnEndCooldown: 60_000,
          },
        });

        const isPlaylist = searchResult?.hasPlaylist();
        const msg = isPlaylist
          ? `✅ اتضافت بلايليست **${searchResult.playlist.title}** (${searchResult.tracks.length} أغنية)`
          : `✅ اتضافت **[${track.title}](${track.url})**`;
        await interaction.editReply({ components: [notice(msg, GREEN)], flags: V2 });
      } catch (err) {
        console.error('play error:', err);
        await interaction.editReply({
          components: [notice(`مقدرتش أشغّل الأغنية: ${err.message}`, RED)],
          flags: V2,
        });
      }
    },
  },
  {
    data: new SlashCommandBuilder().setName('skip').setDescription('تخطي الأغنية الحالية'),
    async execute(interaction) {
      const queue = await requireQueue(interaction);
      if (!queue) return;
      const title = queue.currentTrack.title;
      queue.node.skip();
      return interaction.reply({ components: [notice(`⏭️ اتخطّت **${title}**`)], flags: V2 });
    },
  },
  {
    data: new SlashCommandBuilder().setName('pause').setDescription('إيقاف مؤقت'),
    async execute(interaction) {
      const queue = await requireQueue(interaction);
      if (!queue) return;
      queue.node.pause();
      return interaction.reply({ components: [notice('⏸️ إيقاف مؤقت')], flags: V2 });
    },
  },
  {
    data: new SlashCommandBuilder().setName('resume').setDescription('كمّل التشغيل'),
    async execute(interaction) {
      const queue = await requireQueue(interaction);
      if (!queue) return;
      queue.node.resume();
      return interaction.reply({ components: [notice('▶️ كمّلنا')], flags: V2 });
    },
  },
  {
    data: new SlashCommandBuilder().setName('stop').setDescription('إيقاف التشغيل ومسح الطابور'),
    async execute(interaction) {
      const queue = await requireQueue(interaction);
      if (!queue) return;
      queue.delete();
      return interaction.reply({ components: [notice('⏹️ اتوقف التشغيل وخرج البوت.')], flags: V2 });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('queue')
      .setDescription('عرض طابور الأغاني')
      .addIntegerOption((o) => o.setName('page').setDescription('رقم الصفحة').setMinValue(1)),
    async execute(interaction) {
      const queue = await requireQueue(interaction);
      if (!queue) return;
      const page = interaction.options.getInteger('page') ?? 1;
      return interaction.reply({ components: [queueCard(queue, page)], flags: V2 });
    },
  },
  {
    data: new SlashCommandBuilder().setName('nowplaying').setDescription('الأغنية الشغالة حالياً'),
    async execute(interaction) {
      const queue = await requireQueue(interaction);
      if (!queue) return;
      return interaction.reply({
        components: [nowPlaying(queue, queue.currentTrack)],
        flags: V2,
      });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('volume')
      .setDescription('تغيير مستوى الصوت')
      .addIntegerOption((o) =>
        o.setName('level').setDescription('من 1 إلى 100').setMinValue(1).setMaxValue(100).setRequired(true),
      ),
    async execute(interaction) {
      const queue = await requireQueue(interaction);
      if (!queue) return;
      const level = interaction.options.getInteger('level', true);
      queue.node.setVolume(level);
      return interaction.reply({ components: [notice(`🔊 الصوت بقى **${level}%**`)], flags: V2 });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('loop')
      .setDescription('وضع التكرار')
      .addStringOption((o) =>
        o
          .setName('mode')
          .setDescription('نوع التكرار')
          .setRequired(true)
          .addChoices(
            { name: 'إيقاف', value: 'off' },
            { name: 'الأغنية الحالية', value: 'track' },
            { name: 'الطابور كله', value: 'queue' },
          ),
      ),
    async execute(interaction) {
      const queue = await requireQueue(interaction);
      if (!queue) return;
      const mode = interaction.options.getString('mode', true);
      const map = {
        off: QueueRepeatMode.OFF,
        track: QueueRepeatMode.TRACK,
        queue: QueueRepeatMode.QUEUE,
      };
      queue.setRepeatMode(map[mode]);
      return interaction.reply({ components: [notice(`🔁 التكرار: **${mode}**`)], flags: V2 });
    },
  },
  {
    data: new SlashCommandBuilder().setName('shuffle').setDescription('خلط الطابور'),
    async execute(interaction) {
      const queue = await requireQueue(interaction);
      if (!queue) return;
      queue.tracks.shuffle();
      return interaction.reply({ components: [notice('🔀 اتخلط الطابور')], flags: V2 });
    },
  },
];

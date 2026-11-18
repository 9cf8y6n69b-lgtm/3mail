import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  ThumbnailBuilder,
} from 'discord.js';

export const V2 = MessageFlags.IsComponentsV2;
export const BLURPLE = 0x5865f2;
export const GREEN = 0x57f287;
export const RED = 0xed4245;

const text = (content) => new TextDisplayBuilder().setContent(content);
const divider = () =>
  new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);

const LOOP_LABELS = ['OFF', '🔂 Track', '🔁 Queue'];

/** Simple one-line message inside a Container. */
export function notice(message, color = BLURPLE) {
  return new ContainerBuilder().setAccentColor(color).addTextDisplayComponents(text(message));
}

/** Now playing card with control buttons. */
export function nowPlaying(queue, track) {
  const paused = queue.node.isPaused();
  const requester = track.requestedBy ? `<@${track.requestedBy.id}>` : 'غير معروف';
  const info = [
    `## ${paused ? '⏸️ Paused' : '🎶 Now Playing'}`,
    `**[${track.title}](${track.url})**`,
    `👤 ${track.author}  •  ⏱️ \`${track.duration}\`  •  🙋 ${requester}`,
  ].join('\n');

  const container = new ContainerBuilder().setAccentColor(paused ? 0xfee75c : BLURPLE);

  if (track.thumbnail) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(text(info))
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(track.thumbnail)),
    );
  } else {
    container.addTextDisplayComponents(text(info));
  }

  container
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      text(
        `📜 في الانتظار: **${queue.tracks.size}**  •  🔊 الصوت: **${queue.node.volume}%**  •  🔁 التكرار: **${LOOP_LABELS[queue.repeatMode]}**`,
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('music:toggle')
          .setEmoji(paused ? '▶️' : '⏸️')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('music:skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('music:loop').setEmoji('🔁').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('music:stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger),
      ),
    );

  return container;
}

/** Queue list card. */
export function queueCard(queue, page = 1, perPage = 10) {
  const tracks = queue.tracks.toArray();
  const pages = Math.max(1, Math.ceil(tracks.length / perPage));
  const p = Math.min(Math.max(page, 1), pages);
  const slice = tracks.slice((p - 1) * perPage, p * perPage);
  const current = queue.currentTrack;

  const container = new ContainerBuilder().setAccentColor(BLURPLE);
  container.addTextDisplayComponents(
    text(`## 📜 Queue\n**الحالية:** [${current.title}](${current.url}) \`${current.duration}\``),
  );
  container.addSeparatorComponents(divider());
  container.addTextDisplayComponents(
    text(
      slice.length
        ? slice
            .map((t, i) => `**${(p - 1) * perPage + i + 1}.** [${t.title}](${t.url}) \`${t.duration}\``)
            .join('\n')
        : 'مفيش أغاني تانية في الانتظار.',
    ),
  );
  container.addTextDisplayComponents(text(`-# صفحة ${p}/${pages} • ${tracks.length} أغنية`));
  return container;
}

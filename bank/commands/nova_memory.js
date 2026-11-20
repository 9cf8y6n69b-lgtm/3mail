// © 2026 Q3yb - Wick studio.
const { AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getUser, checkCooldown, setCooldown, formatMoney, readConfig, checkLevelUpAndJob, randomInt } = require('../utils/helpers');
const { createMemoryCard } = require('../utils/gameCards');
const { randomXp } = require('../utils/rewards');
const { sleep } = require('../utils/bet');

const FRUITS = ['🍎', '🍊', '🍋', '🍇', '🍒', '🍉', '🍓', '🍌', '🍑', '🍍', '🥝', '🍐'];
const ROUNDS = 3;
const games = new Map(); // gameId -> state
const shuffle = (a) => a.slice().sort(() => Math.random() - 0.5);

function rows(gameId) {
  const out = [];
  for (let r = 0; r < 3; r++) {
    const row = new ActionRowBuilder();
    for (let c = 0; c < 3; c++) {
      const i = r * 3 + c;
      row.addComponents(new ButtonBuilder().setCustomId(`nv_memo_${gameId}_${i}`).setLabel(String(i + 1)).setStyle(ButtonStyle.Secondary));
    }
    out.push(row);
  }
  return out;
}

module.exports = {
  name: 'تظهر',
  aliases: ['فواكه', 'fruits', 'ذاكرة'],
  interactionKey: 'memo',
  description: 'لعبة الذاكرة: احفظ أماكن الفواكه ثم اختر مكانها',
  category: 'bank',

  execute: async (message) => {
    try {
      const config = readConfig();
      if (!config?.economy) return message.reply('❌ تعذر تحميل إعدادات البنك.');
      const user = await getUser(message.author.id, message.guild.id);
      const cd = checkCooldown(user, 'fruits');
      if (!cd.ready) return message.reply(`⏰ يجب الانتظار ${cd.remainingFormatted} للعب مرة أخرى.`);
      await setCooldown(user, 'fruits');

      const grid = shuffle(FRUITS).slice(0, 9);
      const asks = shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8]).slice(0, ROUNDS);
      const gameId = message.id;
      games.set(gameId, { owner: message.author.id, guildId: message.guild.id, grid, asks, step: 0, correct: 0 });
      setTimeout(() => games.delete(gameId), 5 * 60 * 1000).unref?.();

      const file = (b) => new AttachmentBuilder(b, { name: 'memory.png' });
      const show = await createMemoryCard({ fruits: grid, mode: 'show', round: 1, rounds: ROUNDS, guild: message.guild });
      const sent = await message.reply({ content: '🧠 **احفظ أماكن الفواكه!** عندك 6 ثواني...', files: [file(show)] });
      await sleep(6000);
      const hidden = await createMemoryCard({ fruits: grid, mode: 'hidden', round: 1, rounds: ROUNDS, guild: message.guild });
      await sent.edit({ content: `طلع لي الفاكهة هذي: ${grid[asks[0]]}  (1/${ROUNDS})`, attachments: [], files: [file(hidden)], components: rows(gameId) });
    } catch (e) {
      console.error('Error in memory command:', e);
      await message.reply(`❌ حدث خطأ في اللعبة.\n\`${String(e.message).slice(0, 150)}\``);
    }
  },

  handleInteraction: async (interaction) => {
    if (!interaction.isButton()) return;
    const [, , gameId, idxStr] = interaction.customId.split('_');
    const g = games.get(gameId);
    if (!g) return interaction.reply({ content: '⌛ انتهت هذي اللعبة.', ephemeral: true });
    if (interaction.user.id !== g.owner) return interaction.reply({ content: '❌ هذي اللعبة مو لك!', ephemeral: true });

    const idx = Number(idxStr);
    const ok = idx === g.asks[g.step];
    if (ok) g.correct++;
    g.step++;

    if (g.step < ROUNDS) {
      return interaction.update({
        content: `${ok ? '✅ صح' : '❌ غلط'} — طلع لي الفاكهة هذي: ${g.grid[g.asks[g.step]]}  (${g.step + 1}/${ROUNDS})`,
      });
    }

    // النهاية: المكافأة
    games.delete(gameId);
    const config = readConfig();
    const ranges = [null, [1000, 3000], [5000, 12000], [20000, 50000]];
    const range = ranges[g.correct];
    const reward = range ? randomInt(range[0], range[1]) : 0;
    const user = await getUser(g.owner, g.guildId);
    user.balance += reward;
    if (reward > user.stats.highestEarned) user.stats.highestEarned = reward;
    const xp = randomXp(config, 'fruits');
    user.experience += xp;
    const leveledUp = await checkLevelUpAndJob(user, config);
    await user.save();

    const reveal = await createMemoryCard({ fruits: g.grid, mode: 'show', round: ROUNDS, rounds: ROUNDS, guild: interaction.guild });
    return interaction.update({
      content: `${ok ? '✅ صح' : '❌ غلط'}\n🍇 جاوبت صح **${g.correct}/${ROUNDS}** — ${reward ? `ربحت **${formatMoney(reward)}**` : 'ما ربحت شي'}\n✨ ${xp} خبرة` + (leveledUp ? `\n🎉 وصلت للمستوى ${user.level}` : ''),
      attachments: [], files: [new AttachmentBuilder(reveal, { name: 'memory.png' })], components: [],
    });
  },
};

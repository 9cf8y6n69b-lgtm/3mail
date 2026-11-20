// © 2026 Q3yb - Wick studio.
const { AttachmentBuilder } = require('discord.js');
const { getUser, checkCooldown, setCooldown, formatMoney, readConfig, checkLevelUpAndJob } = require('../utils/helpers');
const { createGambleCard } = require('../utils/gameCards');
const { randomXp } = require('../utils/rewards');
const { readBet, sleep, pick } = require('../utils/bet');

const FRUITS = ['🍎', '🍊', '🍋', '🍇', '🍒', '🍉', '🍓', '🍌'];
const file = (b) => new AttachmentBuilder(b, { name: 'gamble.png' });

module.exports = {
  name: 'قمار',
  aliases: ['gamble', 'قمّار'],
  description: 'قمار الفواكه: 3 متطابقة = فوز (ربع / نص / كامل / مبلغ)',
  category: 'bank',
  execute: async (message, args) => {
    try {
      const config = readConfig();
      if (!config?.economy) return message.reply('❌ تعذر تحميل إعدادات البنك.');
      const user = await getUser(message.author.id, message.guild.id);
      const cd = checkCooldown(user, 'gamble');
      if (!cd.ready) return message.reply(`⏰ يجب الانتظار ${cd.remainingFormatted} للقمار مرة أخرى.`);
      const bet = readBet(args[0], user);
      if (bet.error) return message.reply(bet.error);
      const amount = bet.amount;

      const winRate = Number.isFinite(config.adminSettings?.winRate) ? config.adminSettings.winRate : 0.5;
      const r = Math.random();
      const state = r < winRate * 0.4 ? 'win' : r < winRate * 0.4 + 0.2 ? 'push' : 'lose';
      let fruits;
      if (state === 'win') { const f = pick(FRUITS); fruits = [f, f, f]; }
      else if (state === 'push') { const f = pick(FRUITS); let g; do { g = pick(FRUITS); } while (g === f); fruits = [f, f, g].sort(() => Math.random() - 0.5); }
      else { do { fruits = [pick(FRUITS), pick(FRUITS), pick(FRUITS)]; } while (new Set(fruits).size < 3); }
      const change = state === 'win' ? amount * 3 : state === 'lose' ? -amount : 0;

      user.balance += change;
      if (change > user.stats.highestEarned) user.stats.highestEarned = change;
      if (-change > user.stats.highestLost) user.stats.highestLost = -change;
      const xp = randomXp(config, 'gamble');
      user.experience += xp;
      const leveledUp = await checkLevelUpAndJob(user, config);
      await setCooldown(user, 'gamble');
      await user.save();

      const text = `✨ كسبت ${xp} نقطة خبرة` + (leveledUp ? `\n🎉 وصلت للمستوى ${user.level}` : '');
      const mk = (f, s) => createGambleCard({ discordUser: message.author, fruits: f, state: s, amount, change, guild: message.guild });
      let sent;
      try {
        sent = await message.reply({ files: [file(await mk([pick(FRUITS), pick(FRUITS), pick(FRUITS)], 'spin'))] });
        for (let i = 0; i < 2; i++) { await sleep(900); await sent.edit({ attachments: [], files: [file(await mk([pick(FRUITS), pick(FRUITS), pick(FRUITS)], 'spin'))] }); }
        await sleep(900);
        await sent.edit({ content: text, attachments: [], files: [file(await mk(fruits, state))] });
      } catch (e) {
        console.error('gamble card failed:', e.message);
        const t = `${fruits.join(' ')}\n${state === 'win' ? 'فزت' : state === 'lose' ? 'خسرت' : 'تعادل'} ${formatMoney(Math.abs(change))}\n${text}`;
        return sent ? sent.edit({ content: t, attachments: [], files: [] }).catch(() => {}) : message.reply(t);
      }
    } catch (e) {
      console.error('Error in gamble command:', e);
      await message.reply(`❌ حدث خطأ في القمار.\n\`${String(e.message).slice(0, 150)}\``);
    }
  },
};

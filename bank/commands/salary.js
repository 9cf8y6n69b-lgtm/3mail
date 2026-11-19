

const { EmbedBuilder } = require('discord.js');
const { getUser, checkCooldown, setCooldown, formatMoney, checkLevelUpAndJob, readConfig } = require('../utils/helpers');

const DEFAULT_SALARY = 500; // يُستخدم إذا ما لقى راتب الوظيفة في الإعدادات

module.exports = {
  name: 'راتب',
  aliases: ['salary', 'wage'],
  category: 'bank',
  execute: async (message) => {
    try {
      const config = readConfig();
      if (!config || !config.economy || !config.economy.experience || !config.economy.experience.salary) {
        return message.reply('❌ تعذر تحميل إعدادات الراتب من البنك.');
      }
      const user = await getUser(message.author.id, message.guild.id);
      const cooldown = checkCooldown(user, 'salary');
      if (!cooldown.ready) {
        const embed = new EmbedBuilder()
          .setColor('#FF0000')
          .setDescription(`⏰ يجب الانتظار ${cooldown.remainingFormatted} لأخذ الراتب مرة أخرى.`);
        return message.reply({ embeds: [embed] });
      }

      const jobs = config.economy.jobs || {};
      const userJob = user.job || 'Unemployed';
      let salaryAmount = Number(jobs[userJob]?.salary ?? jobs.Unemployed?.salary);
      if (!Number.isFinite(salaryAmount)) {
        console.warn(`[salary] ما لقيت راتب للوظيفة "${userJob}" في bank-config.json، استخدمت ${DEFAULT_SALARY}`);
        salaryAmount = DEFAULT_SALARY;
      }

      user.balance += salaryAmount;
      if (salaryAmount > user.stats.highestEarned) {
        user.stats.highestEarned = salaryAmount;
      }
      const xpAward = config.economy.experience.salary.xpAward || 0;
      user.experience += xpAward;
      const leveledUp = await checkLevelUpAndJob(user, config);
      await setCooldown(user, 'salary');
      await user.save();

      let description = `لقد تلقيت راتبك كـ **${user.job}** بقيمة ${formatMoney(salaryAmount)}!`;
      if (leveledUp) {
        description += `\n🎉 لقد وصلت إلى المستوى ${user.level} وحصلت على وظيفة **${user.job}** جديدة!`;
      }
      const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('💰 راتب')
        .setDescription(description)
        .addFields({ name: 'رصيدك الجديد', value: formatMoney(user.balance), inline: false })
        .setTimestamp();
      await message.reply({ embeds: [embed] });
    } catch (error) {
      console.error('Error in salary command:', error);
      await message.reply(`❌ حدث خطأ أثناء محاولة أخذ الراتب.\n\`${String(error.message).slice(0, 150)}\``);
    }
  }
};

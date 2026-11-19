require('dotenv').config();
const http = require('http');
const axios = require('axios');
const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, AttachmentBuilder, MessageFlags,
} = require('discord.js');
const db = require('./db');

const OWNER_ID = process.env.OWNER_ID;
const DAILY_AMOUNT = 500;
const DAILY_COOLDOWN = 24 * 60 * 60 * 1000;

// Render يحتاج بورت مفتوح
http.createServer((_, res) => res.end('ok')).listen(process.env.PORT || 3000);

const getBal = (id) => db.get('users', {})[id] ?? 0;
const setBal = (id, v) => {
  const u = db.get('users', {});
  u[id] = v;
  db.set('users', u);
};

const commands = [
  new SlashCommandBuilder().setName('balance').setDescription('عرض الرصيد')
    .addUserOption(o => o.setName('user').setDescription('العضو')),
  new SlashCommandBuilder().setName('daily').setDescription('استلام الراتب اليومي'),
  new SlashCommandBuilder().setName('transfer').setDescription('تحويل فلوس')
    .addUserOption(o => o.setName('user').setDescription('المستلم').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('المبلغ').setMinValue(1).setRequired(true)),
  new SlashCommandBuilder().setName('backup').setDescription('نسخة كاملة من البيانات (للمالك)'),
  new SlashCommandBuilder().setName('restore').setDescription('استرجاع نسخة (للمالك)')
    .addAttachmentOption(o => o.setName('file').setDescription('ملف data.json').setRequired(true)),
].map(c => c.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', async () => {
  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
  console.log(`✅ ${client.user.tag} جاهز`);
});

client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;
  const eph = { flags: MessageFlags.Ephemeral };

  try {
    if (i.commandName === 'balance') {
      const u = i.options.getUser('user') || i.user;
      return i.reply(`💰 رصيد ${u}: **${getBal(u.id).toLocaleString()}**`);
    }

    if (i.commandName === 'daily') {
      const last = db.get('daily', {});
      const left = (last[i.user.id] ?? 0) + DAILY_COOLDOWN - Date.now();
      if (left > 0) {
        const h = Math.floor(left / 3600000), m = Math.floor((left % 3600000) / 60000);
        return i.reply({ content: `⏳ ارجع بعد ${h} ساعة و ${m} دقيقة`, ...eph });
      }
      last[i.user.id] = Date.now();
      db.set('daily', last);
      setBal(i.user.id, getBal(i.user.id) + DAILY_AMOUNT);
      return i.reply(`✅ استلمت **${DAILY_AMOUNT}**، رصيدك الحين **${getBal(i.user.id).toLocaleString()}**`);
    }

    if (i.commandName === 'transfer') {
      const to = i.options.getUser('user');
      const amount = i.options.getInteger('amount');
      if (to.bot || to.id === i.user.id) return i.reply({ content: '❌ مستلم غير صالح', ...eph });
      if (getBal(i.user.id) < amount) return i.reply({ content: '❌ رصيدك ما يكفي', ...eph });
      setBal(i.user.id, getBal(i.user.id) - amount);
      setBal(to.id, getBal(to.id) + amount);
      return i.reply(`✅ ${i.user} حوّل **${amount.toLocaleString()}** إلى ${to}`);
    }

    if (i.commandName === 'backup') {
      if (i.user.id !== OWNER_ID) return i.reply({ content: '❌ ما عندك صلاحية', ...eph });
      const file = new AttachmentBuilder(
        Buffer.from(JSON.stringify(db.all(), null, 2)),
        { name: 'data.json' },
      );
      return i.reply({ files: [file], ...eph });
    }

    if (i.commandName === 'restore') {
      if (i.user.id !== OWNER_ID) return i.reply({ content: '❌ ما عندك صلاحية', ...eph });
      await i.deferReply(eph);
      const att = i.options.getAttachment('file');
      const res = await axios.get(att.url, { responseType: 'json' });
      const obj = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
      db.replace(obj);
      return i.editReply('✅ تم استرجاع النسخة');
    }
  } catch (e) {
    console.error(e);
    const msg = { content: '❌ صار خطأ', ...eph };
    i.deferred || i.replied ? i.editReply(msg.content) : i.reply(msg);
  }
});

client.login(process.env.TOKEN);

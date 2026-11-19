// © 2026 Q3yb - Wick studio.
require('dotenv').config();
const http = require('http');
const { Client, GatewayIntentBits, PermissionFlagsBits, AttachmentBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');

// Render يحتاج بورت مفتوح
http.createServer((_, res) => res.end('ok')).listen(process.env.PORT || 3000);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

let handleBankCommand = async () => false;
let handleBankInteraction = async () => {};
let BankUser = null;

try {
  const bankSystem = require('./bank/index.js');
  if (typeof bankSystem.handleBankCommand === 'function') handleBankCommand = bankSystem.handleBankCommand;
  if (typeof bankSystem.handleBankInteraction === 'function') handleBankInteraction = bankSystem.handleBankInteraction;
  if (bankSystem.bankCommands) client.bankCommands = bankSystem.bankCommands;
  BankUser = require('./bank/models/BankUser');
  console.log('✅ Bank system loaded successfully');
} catch (error) {
  console.error('❌ Failed to load Bank System:', error);
}

const readAdminSettings = () => {
  try {
    const filePath = path.join(__dirname, 'admin_settings.json');
    if (!fs.existsSync(filePath)) return { adminRoles: [], eventRoles: [] };
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch { return { adminRoles: [], eventRoles: [] }; }
};
const hasAdminPermission = (member) => {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const s = readAdminSettings();
  if (!s.adminRoles) return false;
  return member.roles.cache.some((r) => s.adminRoles.map(String).includes(r.id));
};
const hasEventPermission = (member) => {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const s = readAdminSettings();
  if (!s.eventRoles) return false;
  return member.roles.cache.some((r) => s.eventRoles.map(String).includes(r.id));
};

// ================= النسخ الاحتياطي =================
const OWNER_ID = process.env.OWNER_ID;
// ملفات الإعدادات اللي تتعدل من أمر اعداد، تنحفظ مع النسخة
const BACKUP_FILES = ['bank/config/bank-config.json', 'bank/config/cars-config.json', 'admin_settings.json',
  'bank/data/auction.json', 'bank/data/harraj.json', 'bank/data/marketPrices.json'];

function buildBackup() {
  const files = {};
  for (const f of BACKUP_FILES) {
    try { files[f] = fs.readFileSync(path.join(__dirname, f), 'utf8'); } catch {}
  }
  return JSON.stringify({ version: 1, createdAt: new Date().toISOString(), users: BankUser.__dump(), files });
}
function applyBackup(text) {
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.users)) throw new Error('ملف غير صالح');
  const n = BankUser.__load(data.users);
  for (const f of BACKUP_FILES) {
    if (data.files && typeof data.files[f] === 'string') {
      try { JSON.parse(data.files[f]); fs.writeFileSync(path.join(__dirname, f), data.files[f]); } catch {}
    }
  }
  return n;
}
const backupAttachment = () =>
  new AttachmentBuilder(Buffer.from(buildBackup()), { name: `backup-${new Date().toISOString().slice(0, 10)}.json` });

async function sendBackupToOwner(reason) {
  if (!OWNER_ID || !BankUser) return;
  const owner = await client.users.fetch(OWNER_ID);
  await owner.send({ content: `💾 نسخة احتياطية (${reason}) — ${BankUser.__count()} حساب`, files: [backupAttachment()] });
}

// يرجّع آخر نسخة من الخاص تلقائياً لو البيانات فاضية (بعد تحديث/إعادة تشغيل Render)
async function autoRestore() {
  if (!OWNER_ID || !BankUser || BankUser.__count() > 0) return;
  try {
    const dm = await (await client.users.fetch(OWNER_ID)).createDM();
    const msgs = await dm.messages.fetch({ limit: 50 });
    const m = msgs.find((x) => x.author.id === client.user.id && x.attachments.some((a) => a.name?.startsWith('backup-')));
    if (!m) return console.log('ℹ️ ما لقيت نسخة سابقة في الخاص');
    const att = m.attachments.find((a) => a.name?.startsWith('backup-'));
    const n = applyBackup(await (await fetch(att.url)).text());
    console.log(`✅ تم استرجاع آخر نسخة تلقائياً (${n} حساب)`);
  } catch (e) { console.error('autoRestore failed:', e.message); }
}

client.on('clientReady', () => {
  console.log(`${client.user.username} is Online`);
  client.user.setActivity('Wick Studio', { type: 0 });
  autoRestore();
  const hours = Number(process.env.AUTO_BACKUP_HOURS ?? 6);
  if (hours > 0) setInterval(() => sendBackupToOwner('تلقائية').catch((e) => console.error('auto backup:', e.message)), hours * 3600000);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  console.log(`[recv] ${message.author.tag}: ${message.content.slice(0, 40)}`);

  const parts = message.content.trim().split(/ +/);
  const commandName = parts.shift()?.toLowerCase();
  const args = parts;

  // ---- أوامر المالك: نسخة / استرجاع ----
  if (BankUser && ['!backup', 'backup', 'نسخة'].includes(commandName)) {
    if (message.author.id !== OWNER_ID) return message.reply('❌ للمالك فقط.');
    try {
      await message.author.send({ content: `💾 نسخة كاملة — ${BankUser.__count()} حساب`, files: [backupAttachment()] });
      return message.reply('✅ أرسلت لك النسخة في الخاص.');
    } catch { return message.reply('❌ ما قدرت أرسل لك خاص، افتح الخاص من السيرفر وجرب مرة ثانية.'); }
  }
  if (BankUser && ['!restore', 'restore', 'استرجاع'].includes(commandName)) {
    if (message.author.id !== OWNER_ID) return message.reply('❌ للمالك فقط.');
    const att = message.attachments.first();
    if (!att) return message.reply('❌ أرفق ملف النسخة مع الأمر.');
    try {
      const n = applyBackup(await (await fetch(att.url)).text());
      return message.reply(`✅ تم الاسترجاع: ${n} حساب. (إذا غيّرت الإعدادات، أعد تشغيل البوت لتتحدث بالكامل)`);
    } catch (e) { return message.reply(`❌ فشل الاسترجاع: ${e.message}`); }
  }

  // ---- فحص: يرد على ping بدون المرور على البنك ----
  if (commandName === 'ping') {
    return message.reply(`pong ✅ | channel: ${message.channel.id} | guild: ${message.guild?.id}`);
  }

  if (typeof handleBankCommand === 'function' && commandName) {
    try {
      const handled = await handleBankCommand(message, commandName, args);
      console.log(`[msg] ch=${message.channel.id} "${commandName}" handled=${handled}`);
    } catch (error) { console.error('[Bank Command Error]:', error); }
  }
});

client.on('interactionCreate', async (interaction) => {
  try { if (typeof handleBankInteraction === 'function') await handleBankInteraction(interaction); }
  catch (error) { console.error('[Bank Interaction Error]:', error); }
});

client.login(process.env.TOKEN).then(() => console.log('✅ Bot logged in successfully'))
  .catch((e) => console.error('❌ Startup error:', e));

module.exports = { client, hasAdminPermission, hasEventPermission, readAdminSettings };

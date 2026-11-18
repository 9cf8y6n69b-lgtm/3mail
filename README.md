# Discord Music Bot (Components V2)

بوت أغاني بـ Node.js و discord.js v14 — كل الردود بتتبعت في Container باستخدام `MessageFlags.IsComponentsV2`.

## التشغيل
1. `npm install`
2. انسخ `.env.example` لـ `.env` وحط التوكن (و `GUILD_ID` لو عايز الأوامر تظهر فوراً).
3. `npm start`

## الأوامر
`/play` `/skip` `/pause` `/resume` `/stop` `/queue` `/nowplaying` `/volume` `/loop` `/shuffle`
وأزرار التحكم (⏸️ ⏭️ 🔁 ⏹️) موجودة في كارت Now Playing.

## ملاحظات
- لازم تفعّل Intents: الـ Guilds والـ Voice States (مش محتاج Message Content).
- محتاج Node 18.17+ .
- الأوامر بتتسجل تلقائياً أول ما البوت يشتغل.

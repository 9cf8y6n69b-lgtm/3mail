import io
import os
import re
import math
import time
import random
import sqlite3

import discord
from discord.ext import tasks
from PIL import Image, ImageDraw, ImageFont, ImageOps
import arabic_reshaper
from bidi.algorithm import get_display

# ======================= الإعدادات =======================
TOKEN = os.getenv("DISCORD_TOKEN") or "ضع_التوكن_هنا"
BANK_NAME = "Smart Bank"          # اسم البنك اللي يظهر على البطاقة
START_CASH = 5000
ASSETS = "assets"                 # هنا تنحفظ الصور اللي تحددها
FONT_PATH = "fonts/font.ttf"      # حط هنا خط عربي (Cairo / Tajawal ...)
SELL_RATIO = 0.62                 # سعر البيع مقابل الشراء
LOAN_INTEREST = 0.10
PROTECT_PRICE = 10000
PROTECT_SECONDS = 2 * 3600

os.makedirs(ASSETS, exist_ok=True)
os.makedirs("fonts", exist_ok=True)

RESOURCES = {  # الاسم: (إيموجي، السعر الأساسي)
    "خشب": ("🪵", 8500),
    "طوب": ("🧱", 12000),
    "حجر": ("🪨", 35000),
    "حديد": ("⚙️", 45000),
    "فولاذ": ("🔩", 60000),
    "ذهب": ("🥇", 70000),
}
JOBS = ["مبرمج", "طبيب", "مهندس", "سائق", "طباخ", "محاسب", "مصمم", "حارس أمن"]
COMPANIES = ["المراعي", "أرامكو", "الراجحي", "سابك", "الاتصالات", "جرير", "نيوم"]
PRIZES = [1000, 5000, 10000, 15000, 25000, 50000]
PRIZE_WEIGHTS = [40, 28, 15, 10, 5, 2]
BG_KEYS = {"بطاقة": "card", "سوق": "market", "روليت": "wheel", "استثمار": "invest", "شعار": "logo"}

# ======================= قاعدة البيانات =======================
db = sqlite3.connect("bank.db")
db.row_factory = sqlite3.Row
db.executescript(
    """
CREATE TABLE IF NOT EXISTS users(
    user_id INTEGER PRIMARY KEY, cash INTEGER DEFAULT 0, xp INTEGER DEFAULT 0,
    loan INTEGER DEFAULT 0, protected_until REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS cooldowns(
    user_id INTEGER, key TEXT, ts REAL, PRIMARY KEY(user_id, key));
CREATE TABLE IF NOT EXISTS inventory(
    user_id INTEGER, item TEXT, qty INTEGER DEFAULT 0, PRIMARY KEY(user_id, item));
CREATE TABLE IF NOT EXISTS prices(item TEXT PRIMARY KEY, price REAL);
"""
)
db.commit()


def get_user(uid):
    r = db.execute("SELECT * FROM users WHERE user_id=?", (uid,)).fetchone()
    if r is None:
        db.execute("INSERT INTO users(user_id, cash) VALUES(?, ?)", (uid, START_CASH))
        db.commit()
        r = db.execute("SELECT * FROM users WHERE user_id=?", (uid,)).fetchone()
    return r


def add_cash(uid, amount):
    get_user(uid)
    db.execute("UPDATE users SET cash = MAX(0, cash + ?) WHERE user_id=?", (int(amount), uid))
    db.commit()


def add_xp(uid, xp):
    get_user(uid)
    db.execute("UPDATE users SET xp = xp + ? WHERE user_id=?", (int(xp), uid))
    db.commit()


def cooldown_left(uid, key, secs):
    r = db.execute("SELECT ts FROM cooldowns WHERE user_id=? AND key=?", (uid, key)).fetchone()
    return max(0, (r["ts"] if r else 0) + secs - time.time())


def start_cooldown(uid, key):
    db.execute("INSERT OR REPLACE INTO cooldowns VALUES(?,?,?)", (uid, key, time.time()))
    db.commit()


def inv_get(uid, item):
    r = db.execute("SELECT qty FROM inventory WHERE user_id=? AND item=?", (uid, item)).fetchone()
    return r["qty"] if r else 0


def inv_add(uid, item, qty):
    db.execute(
        "INSERT INTO inventory VALUES(?,?,?) ON CONFLICT(user_id,item) DO UPDATE SET qty=qty+excluded.qty",
        (uid, item, qty),
    )
    db.commit()


def raw_price(item):
    r = db.execute("SELECT price FROM prices WHERE item=?", (item,)).fetchone()
    return r["price"] if r else RESOURCES[item][1]


def buy_price(item):
    return max(1, int(raw_price(item)))


def sell_price(item):
    return max(1, int(raw_price(item) * SELL_RATIO))


# ======================= أدوات مساعدة =======================
def money(n):
    return f"{int(n):,}$"


def short(n):
    n = float(n)
    for div, suf in ((1e9, "B"), (1e6, "M"), (1e3, "K")):
        if abs(n) >= div:
            return f"{n / div:.1f}".rstrip("0").rstrip(".") + suf
    return str(int(n))


def fmt_time(sec):
    sec = int(sec)
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    parts = []
    if h:
        parts.append(f"{h} ساعة")
    if m:
        parts.append(f"{m} دقيقة")
    if s and not h:
        parts.append(f"{s} ثانية")
    return " و ".join(parts) or "لحظات"


def parse_amount(text, max_value):
    s = text.strip().lower().replace(",", "")
    if s in ("كل", "الكل", "all"):
        return int(max_value)
    m = re.fullmatch(r"(\d+(?:\.\d+)?)([km]?)", s)
    if not m:
        return None
    return int(float(m.group(1)) * {"k": 1e3, "m": 1e6}.get(m.group(2), 1))


def non_mention(args):
    return [a for a in args if not a.startswith("<@")]


def level_of(xp):
    return xp // 500 + 1


def is_admin(member):
    return member.guild_permissions.administrator


# ======================= الصور =======================
_fonts = {}


def F(size):
    if size not in _fonts:
        try:
            _fonts[size] = ImageFont.truetype(FONT_PATH, size)
        except OSError:
            _fonts[size] = ImageFont.load_default()
    return _fonts[size]


def ar(text):
    return get_display(arabic_reshaper.reshape(str(text)))


def background(key, size):
    path = f"{ASSETS}/{key}.png"
    if os.path.exists(path):
        img = ImageOps.fit(Image.open(path).convert("RGB"), size)
    else:
        img = Image.new("RGB", size, (45, 45, 48))
        d = ImageDraw.Draw(img)
        for y in range(size[1]):
            c = int(38 + 32 * y / size[1])
            d.line([(0, y), (size[0], y)], fill=(c, c, c + 4))
    img = img.convert("RGBA")
    return Image.alpha_composite(img, Image.new("RGBA", size, (0, 0, 0, 80)))


def rounded(img, radius=40):
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, img.size[0], img.size[1]], radius, fill=255)
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


async def avatar_img(member, size):
    try:
        data = await member.display_avatar.replace(size=256, format="png").read()
        im = Image.open(io.BytesIO(data)).convert("RGBA")
    except Exception:
        im = Image.new("RGBA", (256, 256), (90, 100, 110, 255))
    im = im.resize((size, size))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, size, size], fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(im, (0, 0), mask)
    return out


def paste_logo(img, xy, size=60):
    path = f"{ASSETS}/logo.png"
    if os.path.exists(path):
        logo = Image.open(path).convert("RGBA").resize((size, size))
        img.paste(logo, xy, logo)
        return True
    return False


def to_file(img, name="card.png"):
    buf = io.BytesIO()
    rounded(img).save(buf, "PNG")
    buf.seek(0)
    return discord.File(buf, name)


async def card_image(member, cash, note="", delta=None):
    W, H = 900, 500
    img = background("card", (W, H))
    d = ImageDraw.Draw(img)
    x = 125 if paste_logo(img, (50, 35)) else 50
    d.text((x, 62), ar(BANK_NAME), font=F(36), fill="white", anchor="lm")
    d.line([(50, 110), (W - 50, 110)], fill=(255, 255, 255, 120), width=2)
    av = await avatar_img(member, 110)
    img.paste(av, ((W - 110) // 2, 128), av)
    d.text((W // 2, 262), ar(member.display_name), font=F(34), fill="white", anchor="mm")
    d.text((W // 2, 335), f"${short(cash)}", font=F(84), fill=(88, 200, 90), anchor="mm")
    if delta is not None:
        col = (88, 200, 90) if delta >= 0 else (230, 70, 60)
        d.text((W // 2, 392), f"{'+' if delta >= 0 else '-'}${short(abs(delta))}", font=F(30), fill=col, anchor="mm")
    if note:
        d.text((W // 2, 438), ar(note), font=F(26), fill=(235, 235, 235), anchor="mm")
    d.text((50, H - 78), "VISA", font=F(44), fill="white")
    num = str(member.id)[-12:].zfill(12)
    d.text((50, H - 32), " ".join(num[i:i + 4] for i in range(0, 12, 4)), font=F(22), fill=(220, 220, 220), anchor="lm")
    return img


async def market_image(member, cash, uid):
    W, H = 1000, 620
    img = background("market", (W, H))
    d = ImageDraw.Draw(img)
    d.text((340, 45), ar("سوق الموارد"), font=F(40), fill="white", anchor="mm")
    for i, (name, _) in enumerate(RESOURCES.items()):
        x, y = 30 + (i % 2) * 310, 90 + (i // 2) * 170
        d.rounded_rectangle([x, y, x + 290, y + 150], 24, fill=(0, 0, 0, 110), outline=(255, 255, 255, 90), width=2)
        d.text((x + 145, y + 36), ar(name), font=F(34), fill="white", anchor="mm")
        d.text((x + 145, y + 86), ar(f"شراء {short(buy_price(name))}$"), font=F(26), fill=(88, 200, 90), anchor="mm")
        d.text((x + 145, y + 122), ar(f"بيع {short(sell_price(name))}$"), font=F(26), fill=(230, 80, 70), anchor="mm")
    d.rounded_rectangle([670, 90, 970, H - 30], 24, fill=(0, 0, 0, 110), outline=(255, 255, 255, 90), width=2)
    av = await avatar_img(member, 90)
    img.paste(av, (775, 105), av)
    d.text((820, 215), ar(member.display_name), font=F(26), fill="white", anchor="mm")
    d.rounded_rectangle([690, 240, 950, 290], 14, fill=(255, 255, 255, 40))
    d.text((820, 265), f"{short(cash)}$", font=F(30), fill="white", anchor="mm")
    d.text((820, 325), ar("المخزون"), font=F(26), fill=(230, 230, 230), anchor="mm")
    for i, name in enumerate(RESOURCES):
        d.text((820, 365 + i * 32), ar(f"{name}: {inv_get(uid, name)}x"), font=F(24), fill="white", anchor="mm")
    return img


def wheel_image(winner_idx):
    W, H = 800, 860
    img = background("wheel", (W, H))
    d = ImageDraw.Draw(img)
    cx, cy, R = 400, 480, 320
    n = len(PRIZES)
    step = 360 / n
    r0 = 270 - (winner_idx + 0.5) * step
    for i in range(n):
        s = r0 + i * step
        d.pieslice([cx - R, cy - R, cx + R, cy + R], s, s + step,
                   fill=(36, 35, 32) if i % 2 == 0 else (60, 54, 50), outline=(95, 95, 95), width=3)
        mid = math.radians(s + step / 2)
        d.text((cx + R * 0.66 * math.cos(mid), cy + R * 0.66 * math.sin(mid)),
               f"{PRIZES[i]:,}$", font=F(32), fill="white", anchor="mm")
    d.ellipse([cx - R, cy - R, cx + R, cy + R], outline=(75, 75, 75), width=14)
    d.ellipse([cx - 50, cy - 50, cx + 50, cy + 50], fill=(67, 160, 71), outline=(240, 200, 40), width=5)
    d.polygon([(cx - 32, 100), (cx + 32, 100), (cx, 165)], fill=(250, 205, 40))
    return img


async def invest_image(member, company, pct):
    W, H = 900, 420
    img = background("invest", (W, H))
    d = ImageDraw.Draw(img)
    win = pct >= 0
    col = (88, 200, 90) if win else (230, 70, 60)
    av = await avatar_img(member, 70)
    img.paste(av, (50, 30), av)
    d.text((135, 65), ar(member.display_name), font=F(30), fill="white", anchor="lm")
    d.text((W - 50, 65), ar("استثمار رابح" if win else "استثمار خاسر"), font=F(32), fill=col, anchor="rm")
    d.line([(50, 125), (W - 50, 125)], fill=(255, 255, 255, 120), width=2)
    verb = "وربحت" if win else "وخسرت"
    d.text((W // 2, 205), ar(f"استثمرت في أسهم {company} {verb} بنسبة {abs(pct)}%"),
           font=F(34), fill="white", anchor="mm")
    pts = [(60 + i * (W - 220) / 80, 320 + 28 * math.sin(i / 6) * (1 if win else -1)) for i in range(81)]
    d.line(pts, fill=col, width=4)
    d.text((W - 60, 320), f"{abs(pct)}%", font=F(30), fill=col, anchor="rm")
    return img


# ======================= البوت =======================
intents = discord.Intents.default()
intents.message_content = True  # لازم تفعله من بوابة المطورين


async def start_web_server():
    # سيرفر صغير عشان Render يشوف بورت مفتوح (للخدمات من نوع Web Service)
    from aiohttp import web

    app = web.Application()
    app.router.add_get("/", lambda request: web.Response(text="Bot is running"))
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", int(os.getenv("PORT", "10000"))).start()


class BankBot(discord.Client):
    async def setup_hook(self):
        for name, (_, base) in RESOURCES.items():
            db.execute("INSERT OR IGNORE INTO prices VALUES(?,?)", (name, base))
        db.commit()
        update_prices.start()


bot = BankBot(intents=intents)


@tasks.loop(minutes=10)
async def update_prices():
    for name, (_, base) in RESOURCES.items():
        p = raw_price(name) * random.uniform(0.92, 1.08)
        p = min(max(p, base * 0.6), base * 1.6)
        db.execute("UPDATE prices SET price=? WHERE item=?", (p, name))
    db.commit()


async def reply(msg, content=None, file=None, **kw):
    return await msg.reply(content=content, file=file, mention_author=False, **kw)


async def check_cd(msg, key, secs, label):
    left = cooldown_left(msg.author.id, key, secs)
    if left:
        await reply(msg, f"⏳ باقي **{fmt_time(left)}** على {label}.")
        return True
    return False


def get_bet(msg, args, usage):
    a = non_mention(args)
    cash = get_user(msg.author.id)["cash"]
    if not a:
        return None, f"اكتب: `{usage}`"
    amt = parse_amount(a[0], cash)
    if not amt or amt <= 0:
        return None, "❌ مبلغ غير صحيح."
    if amt > cash:
        return None, "❌ رصيدك ما يكفي."
    return amt, None


# ---------- البنك ----------
async def cmd_salary(msg, args):
    uid = msg.author.id
    get_user(uid)
    if await check_cd(msg, "salary", 3600, "راتبك القادم"):
        return
    amt, xp = random.randint(3000, 6500), random.randint(20, 60)
    add_cash(uid, amt)
    add_xp(uid, xp)
    start_cooldown(uid, "salary")
    img = await card_image(msg.author, get_user(uid)["cash"], f"تم إيداع مبلغ الراتب، الوظيفة: {random.choice(JOBS)}")
    await reply(msg, f"➡️ **{money(amt)}**\n⭐ **+{xp} XP**", to_file(img))


async def cmd_luck(msg, args):
    uid = msg.author.id
    get_user(uid)
    if await check_cd(msg, "luck", 1800, "الحظ القادم"):
        return
    start_cooldown(uid, "luck")
    xp = random.randint(30, 80)
    add_xp(uid, xp)
    if random.random() < 0.2:
        item = random.choice(list(RESOURCES))
        qty = random.randint(5, 40)
        inv_add(uid, item, qty)
        text, note = f"🎁 **{qty}x {RESOURCES[item][0]} {item}**\n⭐ **+{xp} XP**", f"هدية الحظ: {qty} {item}"
    else:
        amt = random.randint(500, 3000)
        add_cash(uid, amt)
        text, note = f"🎁 **{money(amt)}**\n⭐ **+{xp} XP**", "هدية الحظ"
    await reply(msg, text, to_file(await card_image(msg.author, get_user(uid)["cash"], note)))


async def cmd_tip(msg, args):
    uid = msg.author.id
    get_user(uid)
    if await check_cd(msg, "tip", 600, "البخشيش القادم"):
        return
    amt = random.randint(100, 800)
    add_cash(uid, amt)
    start_cooldown(uid, "tip")
    await reply(msg, f"+{money(amt)}", to_file(await card_image(msg.author, get_user(uid)["cash"], "بخشيش من أحد المارة")))


async def cmd_invest(msg, args):
    uid = msg.author.id
    amt, err = get_bet(msg, args, "استثمار <المبلغ>")
    if err:
        return await reply(msg, err)
    if amt < 100:
        return await reply(msg, "❌ أقل مبلغ للاستثمار 100$.")
    if await check_cd(msg, "invest", 600, "الاستثمار القادم"):
        return
    pct = random.choice([p for p in range(-25, 31) if p != 0])
    delta = int(amt * pct / 100)
    add_cash(uid, delta)
    start_cooldown(uid, "invest")
    img = await invest_image(msg.author, random.choice(COMPANIES), pct)
    await reply(msg, f"{'📈' if delta >= 0 else '📉'} **{'+' if delta >= 0 else '-'}{money(abs(delta))}**", to_file(img, "invest.png"))


async def cmd_company(msg, args):
    uid = msg.author.id
    amt, err = get_bet(msg, args, "شركه <المبلغ أو كل>")
    if err:
        return await reply(msg, err)
    if amt < 1000:
        return await reply(msg, "❌ أقل مبلغ للشركة 1,000$.")
    if await check_cd(msg, "company", 3600, "استثمار الشركة القادم"):
        return
    pct = random.randint(15, 70) if random.random() < 0.5 else -random.randint(20, 60)
    delta = int(amt * pct / 100)
    add_cash(uid, delta)
    start_cooldown(uid, "company")
    img = await invest_image(msg.author, f"شركتك {random.choice(COMPANIES)}", pct)
    await reply(msg, f"{'📈' if delta >= 0 else '📉'} **{'+' if delta >= 0 else '-'}{money(abs(delta))}**", to_file(img, "company.png"))


# ---------- القمار ----------
async def cmd_gamble(msg, args):
    amt, err = get_bet(msg, args, "قمار <المبلغ>")
    if err:
        return await reply(msg, err)
    win = random.random() < 0.45
    add_cash(msg.author.id, amt if win else -amt)
    await reply(msg, f"🎰 ربحت **{money(amt)}**!" if win else f"💀 خسرت **{money(amt)}**.")


async def cmd_dice(msg, args):
    amt, err = get_bet(msg, args, "نرد <المبلغ>")
    if err:
        return await reply(msg, err)
    me, bot_roll = random.randint(1, 6) + random.randint(1, 6), random.randint(1, 6) + random.randint(1, 6)
    head = f"🎲 رميتك: **{me}** | رمية البنك: **{bot_roll}**\n"
    if me > bot_roll:
        add_cash(msg.author.id, amt)
        await reply(msg, head + f"ربحت **{money(amt)}**!")
    elif me < bot_roll:
        add_cash(msg.author.id, -amt)
        await reply(msg, head + f"خسرت **{money(amt)}**.")
    else:
        await reply(msg, head + "تعادل، ما صار شي.")


async def cmd_coin(msg, args):
    a = non_mention(args)
    if len(a) < 2 or a[1] not in ("صورة", "كتابة"):
        return await reply(msg, "اكتب: `رهان <المبلغ> <صورة|كتابة>`")
    amt, err = get_bet(msg, args, "رهان <المبلغ> <صورة|كتابة>")
    if err:
        return await reply(msg, err)
    result = random.choice(["صورة", "كتابة"])
    win = result == a[1]
    add_cash(msg.author.id, amt if win else -amt)
    await reply(msg, f"🪙 طلعت **{result}**، " + (f"ربحت **{money(amt)}**!" if win else f"خسرت **{money(amt)}**."))


async def cmd_wheel(msg, args):
    uid = msg.author.id
    get_user(uid)
    if await check_cd(msg, "wheel", 3 * 3600, "الروليت القادم"):
        return
    idx = random.choices(range(len(PRIZES)), weights=PRIZE_WEIGHTS)[0]
    add_cash(uid, PRIZES[idx])
    start_cooldown(uid, "wheel")
    await reply(msg, f"🎉 **{money(PRIZES[idx])}**", to_file(wheel_image(idx), "wheel.png"))


# ---------- الحرامية ----------
async def cmd_rob(msg, args):
    if not msg.mentions:
        return await reply(msg, "اكتب: `نهب @الشخص`")
    target, uid = msg.mentions[0], msg.author.id
    if target.bot or target.id == uid:
        return await reply(msg, "❌ ما تقدر تنهب نفسك أو بوت.")
    if await check_cd(msg, "rob", 1800, "النهب القادم"):
        return
    t = get_user(target.id)
    if t["cash"] < 1000:
        return await reply(msg, "😅 هذا مفلس، ما يستاهل.")
    start_cooldown(uid, "rob")
    if t["protected_until"] > time.time():
        return await reply(msg, f"🛡️ {target.mention} محمي، انكشفت!")
    if random.random() < 0.4:
        loot = min(int(t["cash"] * random.uniform(0.1, 0.3)), 50000)
        add_cash(target.id, -loot)
        add_cash(uid, loot)
        await reply(msg, f"🥷 نهبت **{money(loot)}** من {target.mention}!")
    else:
        fine = min(1000, get_user(uid)["cash"])
        add_cash(uid, -fine)
        add_cash(target.id, fine)
        await reply(msg, f"🚔 انمسكت! دفعت **{money(fine)}** غرامة لـ {target.mention}.")


async def cmd_protect(msg, args):
    uid = msg.author.id
    u = get_user(uid)
    if u["protected_until"] > time.time():
        return await reply(msg, f"🛡️ أنت محمي أصلاً لمدة {fmt_time(u['protected_until'] - time.time())}.")
    if u["cash"] < PROTECT_PRICE:
        return await reply(msg, f"❌ الحماية بـ {money(PROTECT_PRICE)} ورصيدك ما يكفي.")
    add_cash(uid, -PROTECT_PRICE)
    db.execute("UPDATE users SET protected_until=? WHERE user_id=?", (time.time() + PROTECT_SECONDS, uid))
    db.commit()
    await reply(msg, f"🛡️ تم تفعيل الحماية لمدة {fmt_time(PROTECT_SECONDS)}.")


# ---------- المعاملات ----------
async def cmd_balance(msg, args):
    target = msg.mentions[0] if msg.mentions else msg.author
    if target.bot:
        return await reply(msg, "❌ البوتات ما عندها حساب.")
    u = get_user(target.id)
    await reply(msg, None, to_file(await card_image(target, u["cash"])))


async def cmd_transfer(msg, args):
    if not msg.mentions:
        return await reply(msg, "اكتب: `تحويل @الشخص <المبلغ>`")
    target, uid = msg.mentions[0], msg.author.id
    if target.bot or target.id == uid:
        return await reply(msg, "❌ ما تقدر تحول لنفسك أو لبوت.")
    amt, err = get_bet(msg, args, "تحويل @الشخص <المبلغ>")
    if err:
        return await reply(msg, err)
    fee = int(amt * 0.02)
    if amt + fee > get_user(uid)["cash"]:
        return await reply(msg, f"❌ رصيدك ما يكفي (المبلغ + عمولة 2% = {money(amt + fee)}).")
    add_cash(uid, -(amt + fee))
    add_cash(target.id, amt)
    await reply(msg, f"💸 حولت **{money(amt)}** إلى {target.mention} (العمولة {money(fee)}).")


async def cmd_loan(msg, args):
    uid = msg.author.id
    if get_user(uid)["loan"] > 0:
        return await reply(msg, "❌ عندك قرض مفتوح، سدده أول بـ `سداد`.")
    a = non_mention(args)
    amt = parse_amount(a[0], 100000) if a else None
    if not amt or amt < 1000 or amt > 100000:
        return await reply(msg, "اكتب: `قرض <المبلغ>` (من 1,000$ إلى 100,000$)")
    owed = int(amt * (1 + LOAN_INTEREST))
    add_cash(uid, amt)
    db.execute("UPDATE users SET loan=? WHERE user_id=?", (owed, uid))
    db.commit()
    await reply(msg, f"🏦 استلمت **{money(amt)}**، المطلوب سداده **{money(owed)}**.")


async def cmd_repay(msg, args):
    uid = msg.author.id
    u = get_user(uid)
    if u["loan"] <= 0:
        return await reply(msg, "✅ ما عليك أي قرض.")
    a = non_mention(args)
    amt = parse_amount(a[0], min(u["cash"], u["loan"])) if a else min(u["cash"], u["loan"])
    amt = min(amt or 0, u["cash"], u["loan"])
    if amt <= 0:
        return await reply(msg, "❌ ما عندك فلوس للسداد.")
    add_cash(uid, -amt)
    db.execute("UPDATE users SET loan = loan - ? WHERE user_id=?", (amt, uid))
    db.commit()
    left = u["loan"] - amt
    await reply(msg, f"✅ سددت **{money(amt)}**. " + (f"باقي {money(left)}." if left else "خلصت القرض!"))


async def cmd_top(msg, args):
    rows = db.execute("SELECT user_id, cash FROM users ORDER BY cash DESC LIMIT 10").fetchall()
    medals = ["🥇", "🥈", "🥉"]
    lines = [f"{medals[i] if i < 3 else f'**{i + 1}.**'} <@{r['user_id']}> — {money(r['cash'])}" for i, r in enumerate(rows)]
    await reply(msg, embed=discord.Embed(title="🏆 أغنى الأعضاء", description="\n".join(lines) or "لا يوجد أحد", color=0x2B2D31))


async def cmd_profile(msg, args):
    target = msg.mentions[0] if msg.mentions else msg.author
    u = get_user(target.id)
    worth = sum(inv_get(target.id, n) * sell_price(n) for n in RESOURCES)
    e = discord.Embed(title=f"👤 {target.display_name}", color=0x2B2D31)
    e.set_thumbnail(url=target.display_avatar.url)
    e.add_field(name="المستوى", value=f"{level_of(u['xp'])} ({u['xp']} XP)")
    e.add_field(name="الرصيد", value=money(u["cash"]))
    e.add_field(name="قيمة الموارد", value=money(worth))
    e.add_field(name="القرض", value=money(u["loan"]))
    await reply(msg, embed=e)


# ---------- السوق ----------
def market_options():
    opts = [
        discord.SelectOption(label="شراء كل الموارد", value="buy_all", emoji="🛒", description="شراء كمية من كل الموارد"),
        discord.SelectOption(label="بيع جميع الموارد", value="sell_all", emoji="💰", description="بيع كل مخزونك من الموارد"),
    ]
    for name, (emo, _) in RESOURCES.items():
        opts.append(discord.SelectOption(label=f"شراء {name}", value=f"buy:{name}", emoji=emo))
        opts.append(discord.SelectOption(label=f"بيع {name}", value=f"sell:{name}", emoji=emo))
    return opts


def do_buy(uid, item, qty_text):
    p = buy_price(item)
    cash = get_user(uid)["cash"]
    q = parse_amount(qty_text, cash // p)
    if not q or q <= 0:
        return f"❌ كمية غير صحيحة ({item})."
    if q * p > cash:
        return f"❌ رصيدك ما يكفي لشراء {q} {item}."
    add_cash(uid, -q * p)
    inv_add(uid, item, q)
    return f"✅ اشتريت {q} {RESOURCES[item][0]} {item} بـ {money(q * p)}"


def do_sell(uid, item, qty_text):
    have = inv_get(uid, item)
    q = parse_amount(qty_text, have)
    if not q or q <= 0 or q > have:
        return f"❌ ما عندك كمية كافية من {item}."
    total = q * sell_price(item)
    inv_add(uid, item, -q)
    add_cash(uid, total)
    return f"✅ بعت {q} {RESOURCES[item][0]} {item} بـ {money(total)}"


class QtyModal(discord.ui.Modal):
    qty = discord.ui.TextInput(label="الكمية (رقم أو كل)", placeholder="مثال: 5", max_length=10)

    def __init__(self, choice):
        super().__init__(title="تحديد الكمية")
        self.choice = choice

    async def on_submit(self, interaction: discord.Interaction):
        uid = interaction.user.id
        kind, _, item = self.choice.partition(":")
        text = self.qty.value
        if kind == "buy_all":
            results = [do_buy(uid, n, text) for n in RESOURCES]
            await interaction.response.send_message("\n".join(results))
        elif kind == "buy":
            await interaction.response.send_message(do_buy(uid, item, text))
        else:
            await interaction.response.send_message(do_sell(uid, item, text))


class MarketView(discord.ui.View):
    def __init__(self, owner_id):
        super().__init__(timeout=180)
        self.owner_id = owner_id

    async def interaction_check(self, interaction: discord.Interaction):
        if interaction.user.id != self.owner_id:
            await interaction.response.send_message("هذا السوق مو لك، اكتب `سوق` بنفسك.", ephemeral=True)
            return False
        return True

    @discord.ui.select(placeholder="اختر عملية (شراء / بيع)", options=market_options())
    async def pick(self, interaction: discord.Interaction, select: discord.ui.Select):
        value = select.values[0]
        if value == "sell_all":
            uid, total = interaction.user.id, 0
            for name in RESOURCES:
                q = inv_get(uid, name)
                if q > 0:
                    total += q * sell_price(name)
                    inv_add(uid, name, -q)
            add_cash(uid, total)
            return await interaction.response.send_message(f"💰 بعت كل مواردك بـ {money(total)}")
        await interaction.response.send_modal(QtyModal(value))


async def cmd_market(msg, args):
    u = get_user(msg.author.id)
    img = await market_image(msg.author, u["cash"], msg.author.id)
    await reply(msg, None, to_file(img, "market.png"), view=MarketView(msg.author.id))


async def cmd_inventory(msg, args):
    uid = msg.author.id
    lines = [f"{emo} **{n}**: {inv_get(uid, n)}x — قيمة البيع {money(inv_get(uid, n) * sell_price(n))}"
             for n, (emo, _) in RESOURCES.items()]
    await reply(msg, embed=discord.Embed(title="🎒 ممتلكاتك", description="\n".join(lines), color=0x2B2D31))


# ---------- الأدمن ----------
async def cmd_background(msg, args):
    if not is_admin(msg.author):
        return await reply(msg, "❌ هذا الأمر للأدمن فقط.")
    if not args or args[0] not in BG_KEYS:
        return await reply(msg, "اكتب: `خلفية <النوع>` وأرفق الصورة.\nالأنواع: " + " | ".join(f"`{k}`" for k in BG_KEYS)
                           + "\nولحذف الصورة: `خلفية <النوع> حذف`")
    path = f"{ASSETS}/{BG_KEYS[args[0]]}.png"
    if len(args) > 1 and args[1] in ("حذف", "delete"):
        if os.path.exists(path):
            os.remove(path)
        return await reply(msg, f"🗑️ تم حذف صورة {args[0]}، رجعت للافتراضي.")
    if not msg.attachments:
        return await reply(msg, "❌ أرفق الصورة مع الرسالة.")
    try:
        data = await msg.attachments[0].read()
        Image.open(io.BytesIO(data)).convert("RGBA").save(path)
    except Exception:
        return await reply(msg, "❌ الملف مو صورة صالحة.")
    await reply(msg, f"✅ تم تحديث صورة **{args[0]}**.")


async def cmd_admin_money(msg, args, sign):
    if not is_admin(msg.author):
        return await reply(msg, "❌ هذا الأمر للأدمن فقط.")
    a = non_mention(args)
    if not msg.mentions or not a:
        return await reply(msg, "اكتب: `اضافة @الشخص <المبلغ>`")
    amt = parse_amount(a[0], 0)
    if not amt or amt <= 0:
        return await reply(msg, "❌ مبلغ غير صحيح.")
    add_cash(msg.mentions[0].id, sign * amt)
    await reply(msg, f"✅ تم {'إضافة' if sign > 0 else 'خصم'} {money(amt)} {'لـ' if sign > 0 else 'من'} {msg.mentions[0].mention}")


async def cmd_help(msg, args):
    e = discord.Embed(title="📖 أوامر البنك", color=0x2B2D31)
    sections = {
        "🏦 أوامر البنك": ["راتب", "حظ", "بخشيش", "استثمار", "شركه"],
        "🎰 أوامر القمار": ["قمار", "نرد", "رهان", "رولت"],
        "🥷 أوامر الحرامية": ["نهب", "حماية"],
        "💳 أوامر المعاملات": ["فلوس", "تحويل", "قرض", "سداد", "توب"],
        "🛒 المتجر والسوق": ["سوق", "ممتلكات"],
        "⚙️ أخرى": ["بروفايل"],
        "👑 للأدمن": ["خلفية", "اضافة", "خصم"],
    }
    for title, cmds in sections.items():
        e.add_field(name=title, value=" | ".join(f"`{c}`" for c in cmds), inline=False)
    await reply(msg, embed=e)


COMMANDS = {
    "راتب": cmd_salary, "حظ": cmd_luck, "بخشيش": cmd_tip, "استثمار": cmd_invest, "شركه": cmd_company, "شركة": cmd_company,
    "قمار": cmd_gamble, "نرد": cmd_dice, "رهان": cmd_coin, "رولت": cmd_wheel, "روليت": cmd_wheel,
    "نهب": cmd_rob, "حماية": cmd_protect, "حمايه": cmd_protect,
    "فلوس": cmd_balance, "تحويل": cmd_transfer, "قرض": cmd_loan, "سداد": cmd_repay, "توب": cmd_top,
    "سوق": cmd_market, "ممتلكات": cmd_inventory, "بروفايل": cmd_profile,
    "خلفية": cmd_background, "اضافة": lambda m, a: cmd_admin_money(m, a, 1),
    "خصم": lambda m, a: cmd_admin_money(m, a, -1),
    "help": cmd_help, "مساعدة": cmd_help, "اوامر": cmd_help,
}


@bot.event
async def on_ready():
    print(f"✅ شغال باسم {bot.user}", flush=True)


@bot.event
async def on_message(msg: discord.Message):
    if msg.author.bot or msg.guild is None:
        return
    parts = msg.content.strip().split()
    if not parts:
        return
    handler = COMMANDS.get(parts[0].lower())
    if handler is None:
        return
    try:
        await handler(msg, parts[1:])
    except Exception as e:
        print("خطأ:", repr(e))
        await msg.reply("❌ صار خطأ غير متوقع.", mention_author=False)


async def main():
    await start_web_server()  # يفتح البورت أول شي حتى لو تأخر تسجيل دخول البوت
    print("🌐 السيرفر اشتغل، جاري تسجيل دخول البوت...", flush=True)
    async with bot:
        await bot.start(TOKEN)


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())

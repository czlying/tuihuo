# -*- coding: utf-8 -*-
"""
生成「退货订单」OCR 测试样例（合成图，清晰可识别）。
每个平台一张手机退货详情页截图，含：平台名 / 商品名 / 金额 / 收货日期 / 退货码。
仅用于本地测试 OCR 抽取逻辑，数据为虚构。
"""
import os, json
from PIL import Image, ImageDraw, ImageFont

FONT = r'C:\Windows\Fonts\simhei.ttf'
OUT = os.path.dirname(os.path.abspath(__file__))
W, H = 900, 1600
WHITE = (255, 255, 255)
GRAY = (140, 140, 140)
DARK = (40, 40, 40)
LIGHT = (245, 245, 245)

def font(sz):
    return ImageFont.truetype(FONT, sz)

def wrap(draw, text, fnt, max_w):
    lines, cur = [], ''
    for ch in text:
        if draw.textlength(cur + ch, font=fnt) <= max_w:
            cur += ch
        else:
            lines.append(cur); cur = ch
    if cur:
        lines.append(cur)
    return lines

def draw_sample(p):
    img = Image.new('RGB', (W, H), WHITE)
    d = ImageDraw.Draw(img)

    # 顶部状态栏（简易）
    d.rectangle([0, 0, W, 60], fill=LIGHT)
    d.text((40, 18), '9:41', font=font(28), fill=DARK)
    d.text((W-150, 18), '5G 100%', font=font(28), fill=DARK)

    # 头部色条
    color = p['color']
    d.rectangle([0, 60, W, 240], fill=color)
    d.text((40, 90), p['platform'] + '订单', font=font(34), fill=WHITE)
    tw = d.textlength('退货退款', font=font(52))
    d.text(((W - tw) / 2, 130), '退货退款', font=font(52), fill=WHITE)

    y = 280
    # 商品卡片
    d.rectangle([40, y, 260, y + 220], fill=LIGHT, outline=(220, 220, 220))
    d.text((90, y + 90), '商品\n图片', font=font(28), fill=GRAY, align='center')
    name_f = font(36)
    name_lines = wrap(d, p['product'], name_f, 560)
    ny = y + 10
    for ln in name_lines:
        d.text((290, ny), ln, font=name_f, fill=DARK)
        ny += 46
    d.text((290, ny + 6), p['spec'], font=font(28), fill=GRAY)

    y = 560
    d.rectangle([40, y, W - 40, y + 1], fill=(220, 220, 220))

    # 退款信息区
    y += 40
    d.text((40, y), '退款信息', font=font(34), fill=DARK)
    y += 70
    rows = [
        ('退款金额', '￥' + p['amount']),
        ('退货码', p['return_code']),
        ('收货日期', p['date']),
        ('申请时间', p['apply_date']),
        ('退货原因', p['reason']),
    ]
    for k, v in rows:
        d.text((40, y), k, font=font(32), fill=GRAY)
        d.text((280, y), v, font=font(32), fill=DARK)
        y += 64

    y += 30
    d.rectangle([40, y, W - 40, y + 1], fill=(220, 220, 220))
    y += 40
    d.text((40, y), '提示：请于最晚可退日期前寄回商品', font=font(28), fill=GRAY)

    fn = os.path.join(OUT, p['file'])
    img.save(fn, 'PNG')
    print('生成:', fn, img.size)

# 标准文本（与图上文字一致，供抽取逻辑验证）
fixtures = [
    dict(file='sample-taobao.png', platform='淘宝', color=(255, 80, 0),
         product='纯棉短袖T恤男夏季宽松半袖圆领潮牌', spec='颜色：白色  尺码：XL',
         amount='129.00', return_code='TB909876543210', date='2026-09-20',
         apply_date='2026-09-21', reason='七天无理由退货'),
    dict(file='sample-jd.png', platform='京东', color=(225, 37, 27),
         product='小米蓝牙耳机Air2 SE真无线降噪', spec='颜色：白  套餐：标准版',
         amount='199.00', return_code='JD8811223344556', date='2026-09-18',
         apply_date='2026-09-19', reason='质量问题退换货'),
    dict(file='sample-pdd.png', platform='拼多多', color=(226, 46, 31),
         product='抽纸巾家用整箱24包实惠装面巾纸', spec='规格：24包/箱',
         amount='39.90', return_code='PD20260915001122', date='2026年09月15日',
         apply_date='2026-09-16', reason='不喜欢/不想要了'),
    dict(file='sample-douyin.png', platform='抖音', color=(254, 44, 85),
         product='化妆刷套装软毛便携美妆工具全套', spec='规格：12支装',
         amount='59.00', return_code='DY7766554433221', date='2026-09-22',
         apply_date='2026-09-23', reason='七天无理由退货'),
    dict(file='sample-vip.png', platform='唯品会', color=(241, 1, 128),
         product='运动跑步鞋男透气网面减震运动鞋', spec='颜色：黑  尺码：42',
         amount='259.00', return_code='VPH20260912ABC88', date='2026年09月12日',
         apply_date='2026-09-13', reason='尺码不合适'),
]

# 生成图 + 记录标准文本
texts = {}
for p in fixtures:
    draw_sample(p)
    # 重建 OCR 会读到的文本（顺序与图一致）
    lines = [
        '9:41', '5G 100%',
        p['platform'] + '订单', '退货退款',
        p['product'], p['spec'],
        '退款信息',
        '退款金额', '￥' + p['amount'],
        '退货码', p['return_code'],
        '收货日期', p['date'],
        '申请时间', p['apply_date'],
        '退货原因', p['reason'],
        '提示：请于最晚可退日期前寄回商品',
    ]
    texts[p['file']] = '\n'.join(lines)

with open(os.path.join(OUT, 'fixtures-text.json'), 'w', encoding='utf-8') as f:
    json.dump(texts, f, ensure_ascii=False, indent=2)
print('已写出 fixtures-text.json（共', len(texts), '张）')

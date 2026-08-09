import { z } from 'zod';

export const cardThemeIds = [
  'midnight',
  'mint-support',
  'sea-salt-timeline',
  'blueberry-compact',
  'desktop-frost',
  'matcha-board',
  'graphite',
  'ink-black',
  'aurora-dark',
  'plum-night',
  'ocean-depth',
  'forest-night',
  'paper',
  'porcelain',
  'cloud-blue',
  'sakura',
  'peach-soda',
  'amber',
  'lavender',
  'ice',
  'jade',
  'warm-sand',
  'rose-milk',
  'mono-light',
] as const;

export const cardThemeIdSchema = z.enum(cardThemeIds);
export type CardThemeId = z.infer<typeof cardThemeIdSchema>;

export const cardThemeLayoutSchema = z.enum([
  'classic',
  'support',
  'timeline',
  'compact',
  'desktop',
  'board',
]);
export type CardThemeLayout = z.infer<typeof cardThemeLayoutSchema>;

export interface CardThemeDefinition {
  readonly id: CardThemeId;
  readonly name: string;
  readonly description: string;
  readonly dark: boolean;
  readonly layout: CardThemeLayout;
  readonly colors: {
    readonly backgroundStart: string;
    readonly backgroundMid: string;
    readonly backgroundEnd: string;
    readonly text: string;
    readonly muted: string;
    readonly accent: string;
    readonly accentText: string;
    readonly panel: string;
    readonly panelBorder: string;
    readonly imageBackground: string;
    readonly danger: string;
    readonly dangerSurface: string;
  };
}

const dark = (
  id: CardThemeId,
  name: string,
  description: string,
  layout: CardThemeLayout,
  background: readonly [string, string, string],
  accent: string,
  panel: string,
): CardThemeDefinition => ({
  id,
  name,
  description,
  dark: true,
  layout,
  colors: {
    backgroundStart: background[0],
    backgroundMid: background[1],
    backgroundEnd: background[2],
    text: '#f5f7ff',
    muted: '#aeb6cc',
    accent,
    accentText: accent,
    panel,
    panelBorder: 'rgba(255,255,255,0.12)',
    imageBackground: '#090b10',
    danger: '#ff7272',
    dangerSurface: 'rgba(255,77,79,0.16)',
  },
});

const light = (
  id: CardThemeId,
  name: string,
  description: string,
  layout: CardThemeLayout,
  background: readonly [string, string, string],
  accent: string,
  text: string,
  muted: string,
  panel: string,
): CardThemeDefinition => ({
  id,
  name,
  description,
  dark: false,
  layout,
  colors: {
    backgroundStart: background[0],
    backgroundMid: background[1],
    backgroundEnd: background[2],
    text,
    muted,
    accent,
    accentText: accent,
    panel,
    panelBorder: 'rgba(34,50,66,0.12)',
    imageBackground: '#eef1f4',
    danger: '#b42318',
    dangerSurface: 'rgba(217,45,32,0.10)',
  },
});

/**
 * Shared by the admin preview and both render locations. Only the short theme
 * id crosses the wire; the palette and layout stay local to each deployment.
 */
export const cardThemes: readonly CardThemeDefinition[] = [
  dark(
    'midnight',
    '午夜中继',
    'DisQord 原始暗色主题。',
    'classic',
    ['#151925', '#11131a', '#1c1730'],
    '#91a7ff',
    'rgba(255,255,255,0.09)',
  ),
  light(
    'mint-support',
    '薄荷客服',
    '来自 08 / Support Card。',
    'support',
    ['#fbfefe', '#f5fbfb', '#eefafa'],
    '#58aeb8',
    '#23333a',
    '#5f7c82',
    '#f5fcfc',
  ),
  light(
    'sea-salt-timeline',
    '海盐时间线',
    '来自 09 / Timeline Event。',
    'timeline',
    ['#f8fbff', '#f2f7fd', '#edf5ff'],
    '#6d9fd6',
    '#223242',
    '#62748a',
    '#f8fbff',
  ),
  light(
    'blueberry-compact',
    '蓝莓概览',
    '来自 14 / Compact Analytics。',
    'compact',
    ['#fcfcff', '#f6f7fc', '#f0eef6'],
    '#7798cf',
    '#262b35',
    '#6d7483',
    '#fafbff',
  ),
  light(
    'desktop-frost',
    '桌面冰霜',
    '来自 17 / Desktop Widget。',
    'desktop',
    ['#fbfcfd', '#f5f7fa', '#edf1f4'],
    '#7f96ad',
    '#273444',
    '#667485',
    '#fbfcfd',
  ),
  light(
    'matcha-board',
    '宇治看板',
    '来自 18 / Message Board。',
    'board',
    ['#fbfefc', '#f5fbf8', '#edf8f3'],
    '#5b927d',
    '#233531',
    '#61756d',
    '#f8fcfa',
  ),
  dark(
    'graphite',
    '石墨',
    '低对比中性暗灰，适合长时间阅读。',
    'compact',
    ['#202225', '#17191c', '#101214'],
    '#aab2bb',
    'rgba(255,255,255,0.075)',
  ),
  dark(
    'ink-black',
    '墨黑',
    '更纯粹的 OLED 深黑。',
    'classic',
    ['#101113', '#08090b', '#000000'],
    '#d2d6dc',
    'rgba(255,255,255,0.08)',
  ),
  dark(
    'aurora-dark',
    '极光夜',
    '冷青与蓝紫交界的暗色主题。',
    'timeline',
    ['#0d2528', '#101a24', '#1c1530'],
    '#69d6ce',
    'rgba(105,214,206,0.09)',
  ),
  dark(
    'plum-night',
    '梅子夜',
    '克制的紫红夜色。',
    'support',
    ['#281727', '#19121e', '#111017'],
    '#d59acb',
    'rgba(213,154,203,0.10)',
  ),
  dark(
    'ocean-depth',
    '深海',
    '偏蓝的高辨识暗色主题。',
    'board',
    ['#102433', '#0b1722', '#081018'],
    '#70b9e6',
    'rgba(112,185,230,0.09)',
  ),
  dark(
    'forest-night',
    '森林夜',
    '低饱和墨绿暗色。',
    'desktop',
    ['#15251e', '#101a16', '#0c110f'],
    '#83c59d',
    'rgba(131,197,157,0.09)',
  ),
  light(
    'paper',
    '纸张',
    '温和、接近自然纸面的白色。',
    'classic',
    ['#fffdf8', '#faf7f0', '#f5f0e7'],
    '#8b6b45',
    '#352f28',
    '#796f63',
    '#fffdfa',
  ),
  light(
    'porcelain',
    '白瓷',
    '清洁且中性的产品白。',
    'compact',
    ['#ffffff', '#f8f9fa', '#f1f3f5'],
    '#667085',
    '#22262b',
    '#727980',
    '#fafbfc',
  ),
  light(
    'cloud-blue',
    '云蓝',
    '柔和浅蓝，适合日常消息。',
    'timeline',
    ['#fbfdff', '#f1f7ff', '#e8f2ff'],
    '#5e8fc9',
    '#25364a',
    '#687b91',
    '#f7fbff',
  ),
  light(
    'sakura',
    '樱花',
    '淡粉色但保留足够文字对比。',
    'support',
    ['#fffafb', '#fff2f5', '#fbe8ee'],
    '#c46f8b',
    '#462c36',
    '#836a74',
    '#fff8fa',
  ),
  light(
    'peach-soda',
    '蜜桃苏打',
    '偏暖的轻橙粉主题。',
    'classic',
    ['#fffdf9', '#fff4ea', '#ffeadb'],
    '#cb7b4e',
    '#493126',
    '#876f63',
    '#fff9f4',
  ),
  light(
    'amber',
    '琥珀',
    '暖黄棕，适合信息密集场景。',
    'compact',
    ['#fffdf6', '#fff6dc', '#f8e9bd'],
    '#a66e16',
    '#3e3321',
    '#806f53',
    '#fffaf0',
  ),
  light(
    'lavender',
    '薰衣草',
    '柔和的蓝紫灰。',
    'desktop',
    ['#fdfcff', '#f5f1fb', '#eee8f7'],
    '#8069ad',
    '#332d40',
    '#756c82',
    '#faf8fd',
  ),
  light(
    'ice',
    '冰川',
    '浅青蓝与清晰的冷色层级。',
    'timeline',
    ['#fbffff', '#effbfc', '#e2f4f7'],
    '#4a98a5',
    '#233b40',
    '#638087',
    '#f7fdfe',
  ),
  light(
    'jade',
    '青玉',
    '带一点灰度的浅绿色。',
    'board',
    ['#fcfffd', '#f0faf4', '#e5f3ea'],
    '#4f9170',
    '#263a30',
    '#65796e',
    '#f8fcfa',
  ),
  light(
    'warm-sand',
    '暖砂',
    '低饱和米棕，视觉更安静。',
    'classic',
    ['#fffefa', '#f8f3e9', '#efe7d8'],
    '#927553',
    '#3c352c',
    '#7d7467',
    '#fcfaf5',
  ),
  light(
    'rose-milk',
    '玫瑰牛乳',
    '灰粉色的柔和消息卡。',
    'support',
    ['#fffcfd', '#f9f1f4', '#f2e7eb'],
    '#a66c80',
    '#422f36',
    '#7f6c73',
    '#fdf8fa',
  ),
  light(
    'mono-light',
    '单色白',
    '最少装饰、最高通用性。',
    'compact',
    ['#ffffff', '#f7f7f7', '#eeeeee'],
    '#4b5563',
    '#202124',
    '#6f7378',
    '#fafafa',
  ),
] as const;

export const defaultCardThemeId: CardThemeId = 'midnight';

export const cardSettingsSchema = z.object({
  themeId: cardThemeIdSchema.default(defaultCardThemeId),
});

export type CardSettings = z.infer<typeof cardSettingsSchema>;

export function getCardTheme(id: CardThemeId | string | undefined): CardThemeDefinition {
  return cardThemes.find((theme) => theme.id === id) ?? cardThemes[0]!;
}

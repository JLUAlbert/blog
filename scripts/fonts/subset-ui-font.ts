import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import navfolioConfig from '../../navfolio.config.ts';
import {
  getResolvedPageModule,
  getResolvedPageModuleI18n,
  isPageModuleEnabled,
} from '../../src/plugins/config.ts';

type FontConfig = {
  en: string;
  zh: string;
  file: string;
};

const projectRoot = process.cwd();

// 官方完整字体（含繁体字形）是唯一的子集化源。
// public 里的 woff2 是生成产物，不能当源——它已被裁剪成简体常用字，繁体字根本不在里面。
const sourceFontPath = join(projectRoot, 'scripts/fonts/source/LXGWWenKai-Regular.ttf');
const uiCharsPath = join(projectRoot, 'scripts/fonts/ui-chars.txt');
const fullCharsPath = join(projectRoot, 'scripts/fonts/full-chars.txt');
const friendCirclePath = join(projectRoot, 'public/friend-circle.json');
const fontConfig = readFontConfig();
const subsetFontUrl = getSubsetFontUrl(fontConfig.file);
const uiFontPath = resolveProjectPath(subsetFontUrl);
const fullFontPath = resolveProjectPath(fontConfig.file);
const subsetFontName = `${fontConfig.zh} UI Subset`;
const fullFontName = fontConfig.zh;
const isWindows = process.platform === 'win32';
const venvBinDir = isWindows ? 'Scripts' : 'bin';
const pythonExe = isWindows ? 'python.exe' : 'python';
const pyftsubsetExe = isWindows ? 'pyftsubset.exe' : 'pyftsubset';
const pythonCommands = [
  join(projectRoot, '.venv', venvBinDir, pythonExe),
  'python',
  'python3',
].filter(
  (command, index, commands) =>
    (index === 0 ? existsSync(command) : true) && commands.indexOf(command) === index,
);
const contentSource = process.env.NAVFOLIO_CONTENT_SOURCE === 'docs' ? 'docs' : 'content';
const contentRoot = contentSource === 'docs' ? 'src/docs' : 'src/content';
const projectsModuleEnabled = isPageModuleEnabled(navfolioConfig, 'projects');
const resolvedVibeModule = getResolvedPageModule(navfolioConfig, 'vibe');
const vibeModuleEnabled = Boolean(resolvedVibeModule);
const vibeRouteEntrypoint = resolvedVibeModule?.routes?.[0]?.entrypoint;
const vibeRouteSourceFile = vibeRouteEntrypoint ? fileURLToPath(vibeRouteEntrypoint) : undefined;
const resolvedMediaModule = getResolvedPageModule(navfolioConfig, 'media');
const mediaModuleEnabled = Boolean(resolvedMediaModule);
const mediaRouteEntrypoint = resolvedMediaModule?.routes?.[0]?.entrypoint;
const mediaRouteSourceFile = mediaRouteEntrypoint ? fileURLToPath(mediaRouteEntrypoint) : undefined;

const sourceDirs = [
  'src/pages',
  'src/components',
  'src/layouts',
  'src/config',
  'src/utils',
  'src/i18n',
];
const sourceFiles = [
  ...(projectsModuleEnabled
    ? ['src/modules/routes/projects-index.astro', 'src/modules/routes/project-detail.astro']
    : []),
  ...(vibeRouteSourceFile ? [vibeRouteSourceFile] : []),
  ...(mediaRouteSourceFile ? [mediaRouteSourceFile] : []),
];
const contentDirs = [
  `${contentRoot}/blog`,
  ...(projectsModuleEnabled ? [`${contentRoot}/projects`] : []),
  ...(vibeModuleEnabled ? [`${contentRoot}/vibe`] : []),
  ...(mediaModuleEnabled ? [`${contentRoot}/media`] : []),
];
const contentFiles = [
  `${contentRoot}/about.mdx`,
  `${contentRoot}/about.md`,
  ...(projectsModuleEnabled
    ? [`${contentRoot}/projects/index.mdx`, `${contentRoot}/projects/index.md`]
    : []),
];
const sourceExtensions = new Set(['.astro', '.ts', '.js', '.mjs', '.cjs', '.json', '.toml']);
const contentExtensions = new Set(['.md', '.mdx']);
const frontmatterKeys = new Set([
  'title',
  'description',
  'subtitle',
  'note',
  'tags',
  'categories',
  'series',
  'creator',
]);
const cjkPattern =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u;

function readFontConfig(): FontConfig {
  const defaults: FontConfig = {
    en: 'Maple Mono',
    zh: 'ChillRoundM',
    file: '/fonts/ChillRoundM.ttf',
  };
  const siteConfigPath = join(projectRoot, 'src/config/site.toml');

  if (!existsSync(siteConfigPath)) return defaults;

  const parsed = parse(readFileSync(siteConfigPath, 'utf8')) as {
    config?: {
      fonts?: Partial<Record<keyof FontConfig, unknown>>;
    };
  };
  const fonts = parsed.config?.fonts ?? {};

  return {
    en: normalizeConfigString(fonts.en, defaults.en),
    zh: normalizeConfigString(fonts.zh, defaults.zh),
    file: normalizeConfigString(fonts.file, defaults.file),
  };
}

function getSubsetFontUrl(fontUrl: string) {
  const queryIndex = fontUrl.search(/[?#]/);
  const suffix = queryIndex === -1 ? '' : fontUrl.slice(queryIndex);
  const path = queryIndex === -1 ? fontUrl : fontUrl.slice(0, queryIndex);
  const extensionIndex = path.lastIndexOf('.');
  const basePath = extensionIndex === -1 ? path : path.slice(0, extensionIndex);

  return `${basePath}-ui-subset.woff2${suffix}`;
}

function normalizeConfigString(value: unknown, fallback: string) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function resolveProjectPath(value: string) {
  if (/^https?:\/\//i.test(value)) {
    throw new Error(
      `Font output needs a local path, but config.fonts.file received a remote URL: ${value}`,
    );
  }

  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '');
  const relativePath = normalized.startsWith('public/') ? normalized : `public/${normalized}`;

  return join(projectRoot, relativePath);
}

function walkFiles(dir: string, extensions: Set<string>) {
  if (!existsSync(dir)) return [];

  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(path, extensions));
      continue;
    }

    if (entry.isFile() && extensions.has(extname(entry.name))) files.push(path);
  }

  return files;
}

function collectCjk(chars: Set<string>, text: string) {
  for (const char of text) {
    if (cjkPattern.test(char)) chars.add(char);
  }
}

function extractFrontmatter(text: string) {
  if (!text.startsWith('---')) return '';

  const endIndex = text.indexOf('\n---', 3);
  if (endIndex === -1) return '';

  return text.slice(3, endIndex);
}

function extractFrontmatterFields(frontmatter: string) {
  const values: string[] = [];
  let activeKey: string | null = null;

  for (const line of frontmatter.split(/\r?\n/)) {
    const keyMatch = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (keyMatch) {
      activeKey = keyMatch[1];
      if (frontmatterKeys.has(activeKey)) values.push(keyMatch[2]);
      continue;
    }

    if (activeKey && frontmatterKeys.has(activeKey) && /^\s+/.test(line)) {
      values.push(line);
    }
  }

  return values.join('\n');
}

function collectFriendCircleChars(chars: Set<string>) {
  if (!existsSync(friendCirclePath)) return;

  try {
    const data: unknown = JSON.parse(readFileSync(friendCirclePath, 'utf8'));
    const collectStrings = (value: unknown): void => {
      if (typeof value === 'string') {
        collectCjk(chars, value);
      } else if (Array.isArray(value)) {
        for (const item of value) collectStrings(item);
      } else if (value && typeof value === 'object') {
        for (const nestedValue of Object.values(value)) collectStrings(nestedValue);
      }
    };

    collectStrings(data);
  } catch (error) {
    console.warn(`Unable to collect friend-circle characters from ${friendCirclePath}:`, error);
  }
}

// Big5 常用字集（约 1.3 万字）：覆盖繁体中文日常用字，是正文全量字体的主力。
// 用 Python 标准库解码 Big5 码表，不依赖额外 npm 包。
function buildBig5Chars(): string {
  const script = `
import sys
chars = set()
for b1 in range(0xA1, 0xFA):
    for b2 in list(range(0x40, 0x7F)) + list(range(0xA1, 0xFF)):
        try:
            ch = bytes([b1, b2]).decode('big5')
        except UnicodeDecodeError:
            continue
        if '\\u4e00' <= ch <= '\\u9fff':
            chars.add(ch)
sys.stdout.write(''.join(sorted(chars)))
`;
  for (const command of pythonCommands) {
    const result = spawnSync(command, ['-c', script], { encoding: 'utf8' });
    if (result.status === 0 && result.stdout) return result.stdout;
  }

  throw new Error('Unable to build Big5 character set. Ensure Python 3 is installed.');
}

function runSubset(inputPath: string, charsPath: string, outputPath: string) {
  const args = [
    inputPath,
    `--text-file=${charsPath}`,
    `--output-file=${outputPath}`,
    '--flavor=woff2',
    '--with-zopfli',
    '--layout-features=*',
    '--name-IDs=*',
    '--glyph-names',
    '--notdef-glyph',
    '--notdef-outline',
    '--recommended-glyphs',
    '--no-hinting',
  ];

  const commands = [
    { command: join(projectRoot, '.venv', venvBinDir, pyftsubsetExe), args },
    ...pythonCommands.map((command) => ({ command, args: ['-m', 'fontTools.subset', ...args] })),
  ];

  for (const { command, args: commandArgs } of commands) {
    const result = spawnSync(command, commandArgs, { stdio: 'inherit' });
    if (result.status === 0) {
      return;
    }

    if (result.error && 'code' in result.error && result.error.code === 'ENOENT') continue;
  }

  throw new Error(
    'Unable to run fonttools. Install it in the project virtual environment with `python3 -m venv .venv && .venv/bin/python -m pip install fonttools brotli`.',
  );
}

function syncFontName(fontPath: string, family: string) {
  const script = `
from fontTools.ttLib import TTFont
import sys

path = sys.argv[1]
family = sys.argv[2]
font = TTFont(path)
name_table = font['name']

for record in name_table.names:
    if record.nameID == 1:
        record.string = family.encode(record.getEncoding(), errors='replace')
    elif record.nameID == 2:
        record.string = 'Regular'.encode(record.getEncoding(), errors='replace')
    elif record.nameID == 4:
        record.string = f'{family} Regular'.encode(record.getEncoding(), errors='replace')
    elif record.nameID == 6:
        record.string = ''.join(part for part in f'{family}-Regular' if part.isalnum() or part == '-').encode(record.getEncoding(), errors='replace')

font.save(path)
`;
  let result;
  for (const command of pythonCommands) {
    result = spawnSync(command, ['-c', script, fontPath, family], {
      stdio: 'inherit',
    });
    if (result.status === 0) return;
  }

  throw new Error(
    `Generated subset font, but failed to sync its internal name to ${family}. Ensure Python 3 and fonttools are installed. Error: ${result?.error?.message ?? `status ${result?.status}`}`,
  );
}

if (!existsSync(sourceFontPath)) {
  throw new Error(
    `Official full font not found at ${sourceFontPath}. Download LXGWWenKai-Regular.ttf from https://github.com/lxgw/LxgwWenKai/releases and place it there.`,
  );
}

const uiChars = new Set<string>();
const fullChars = new Set<string>();

for (const contribution of getResolvedPageModuleI18n(navfolioConfig)) {
  collectCjk(uiChars, JSON.stringify(contribution.messages));
}

for (const dir of sourceDirs) {
  for (const file of walkFiles(join(projectRoot, dir), sourceExtensions)) {
    collectCjk(uiChars, readFileSync(file, 'utf8'));
  }
}

for (const file of sourceFiles) {
  const path = isAbsolute(file) ? file : join(projectRoot, file);
  if (existsSync(path)) collectCjk(uiChars, readFileSync(path, 'utf8'));
}

for (const dir of contentDirs) {
  for (const file of walkFiles(join(projectRoot, dir), contentExtensions)) {
    const text = readFileSync(file, 'utf8');
    collectCjk(uiChars, extractFrontmatterFields(extractFrontmatter(text)));
    // 正文全文只进全量字体，不进 UI 子集（UI 子集只服务界面，不需要文章用字）。
    collectCjk(fullChars, text);
  }
}

for (const file of contentFiles) {
  const path = join(projectRoot, file);
  if (existsSync(path)) collectCjk(uiChars, readFileSync(path, 'utf8'));
}

// The sync Action writes RSS-derived display text before this build step.
collectFriendCircleChars(uiChars);

for (const char of uiChars) fullChars.add(char);
for (const char of buildBig5Chars()) fullChars.add(char);

const sortedUiChars = [...uiChars].sort((a, b) => a.codePointAt(0)! - b.codePointAt(0)!).join('');
const sortedFullChars = [...fullChars]
  .sort((a, b) => a.codePointAt(0)! - b.codePointAt(0)!)
  .join('');
if (!sortedUiChars) throw new Error('No CJK UI characters were found for font subsetting.');
if (!sortedFullChars) throw new Error('No CJK characters were found for font subsetting.');

mkdirSync(dirname(uiCharsPath), { recursive: true });
mkdirSync(dirname(uiFontPath), { recursive: true });
writeFileSync(uiCharsPath, `${sortedUiChars}\n`, 'utf8');
writeFileSync(fullCharsPath, `${sortedFullChars}\n`, 'utf8');

// 先生成正文全量字体（简繁 + Big5），再生成界面子集。两者都源自完整 TTF，繁体字形齐备。
runSubset(sourceFontPath, fullCharsPath, fullFontPath);
syncFontName(fullFontPath, fullFontName);
runSubset(sourceFontPath, uiCharsPath, uiFontPath);
syncFontName(uiFontPath, subsetFontName);

console.log(`Generated ${fullCharsPath} with ${sortedFullChars.length} CJK characters.`);
console.log(`Generated ${fullFontPath} (body font, Simplified + Traditional).`);
console.log(`Generated ${uiCharsPath} with ${sortedUiChars.length} CJK UI characters.`);
console.log(`Generated ${uiFontPath} (UI subset).`);

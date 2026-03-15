/**
 * browser.js — 浏览器生命周期管理（内部模块，不对外暴露）
 *
 * 设计思路：
 *   Skill 内部自己管理浏览器进程，对外只暴露 ensureBrowser()。
 *   调用方不需要关心 launch/connect/端口/CDP 等细节。
 *   支持 Chrome / Edge / Chromium 等所有基于 Chromium 的浏览器。
 *
 * 流程：
 *   1. 先检查指定端口是否已有浏览器在跑 → 有就 connect
 *   2. 没有 → 自动检测或使用配置的浏览器路径启动
 *   3. 找到 / 新开 Gemini 标签页
 *   4. 返回 { browser, page }
 */
import puppeteerCore from 'puppeteer-core';
import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { createConnection } from 'node:net';
import { existsSync, mkdirSync } from 'node:fs';
import { platform, homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import config from './config.js';

// ── 用 puppeteer-extra 包装 puppeteer-core，注入 stealth 插件 ──
const puppeteer = addExtra(puppeteerCore);
puppeteer.use(StealthPlugin());

// ── 模块级单例：跨调用复用同一个浏览器 ──
let _browser = null;

// ── 各平台浏览器候选路径（Chrome、Edge、Chromium）──
const BROWSER_CANDIDATES = {
  win32: [
    // Chrome
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    // Edge
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    // Chromium
    'C:\\Program Files\\Chromium\\Application\\chrome.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ],
};

/**
 * 自动检测系统上可用的 Chromium 系浏览器
 * @returns {string | undefined} 找到的浏览器可执行文件路径
 */
function detectBrowser() {
  // 还可以检查用户通过环境变量传入的常用别名
  const envPaths = [
    process.env.PROGRAMFILES,
    process.env['PROGRAMFILES(X86)'],
    process.env.LOCALAPPDATA,
  ];

  const os = platform();
  const candidates = BROWSER_CANDIDATES[os] || [];

  // Windows 额外：从环境变量目录组合路径
  if (os === 'win32') {
    for (const base of envPaths) {
      if (!base) continue;
      candidates.push(
        `${base}\\Google\\Chrome\\Application\\chrome.exe`,
        `${base}\\Microsoft\\Edge\\Application\\msedge.exe`,
      );
    }
  }

  for (const p of candidates) {
    if (existsSync(p)) {
      console.log('[browser] auto-detected:', p);
      return p;
    }
  }

  return undefined;
}

// ── userDataDir 兜底目录 ──
const SKILL_FALLBACK_DATA_DIR = join(homedir(), '.gemini-skill', 'browser-data');

/**
 * 尝试从 OpenClaw 获取 userDataDir
 *
 * 执行: openclaw browser --browser-profile openclaw status --json
 * 解析返回的 JSON 中的 userDataDir 字段
 *
 * @returns {string | undefined}
 */
function getOpenClawUserDataDir() {
  try {
    const stdout = execFileSync('openclaw', [
      'browser', '--browser-profile', 'openclaw', 'status', '--json',
    ], { timeout: 5000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });

    const json = JSON.parse(stdout);
    if (json.userDataDir && typeof json.userDataDir === 'string') {
      console.log('[browser] got userDataDir from OpenClaw:', json.userDataDir);
      return json.userDataDir;
    }
  } catch {
    // openclaw 不存在或执行失败，静默跳过
  }
  return undefined;
}

/**
 * 获取浏览器默认 userDataDir 路径（不同浏览器/平台）
 *
 * @returns {string | undefined}
 */
function getDefaultBrowserDataDir() {
  const os = platform();
  const home = homedir();

  const candidates = [];

  if (os === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    candidates.push(
      join(localAppData, 'Google', 'Chrome', 'User Data'),
      join(localAppData, 'Microsoft', 'Edge', 'User Data'),
      join(localAppData, 'Chromium', 'User Data'),
    );
  } else if (os === 'darwin') {
    const lib = join(home, 'Library', 'Application Support');
    candidates.push(
      join(lib, 'Google', 'Chrome'),
      join(lib, 'Microsoft Edge'),
      join(lib, 'Chromium'),
    );
  } else {
    // Linux
    candidates.push(
      join(home, '.config', 'google-chrome'),
      join(home, '.config', 'microsoft-edge'),
      join(home, '.config', 'chromium'),
    );
  }

  for (const dir of candidates) {
    if (existsSync(dir)) {
      console.log('[browser] found default browser data dir:', dir);
      return dir;
    }
  }

  return undefined;
}

/**
 * 多级兜底解析 userDataDir
 *
 * 优先级：
 *   1. 环境变量 BROWSER_USER_DATA_DIR（config 已处理）
 *   2. OpenClaw 运行状态中的 userDataDir
 *   3. 浏览器默认 userDataDir（Chrome > Edge > Chromium）
 *   4. Skill 内部创建 ~/.gemini-skill/browser-data（兜底 + warning）
 *
 * @returns {string}
 */
function resolveUserDataDir() {
  // 1. 环境变量（已由 config 读取）
  if (config.browserUserDataDir) {
    return config.browserUserDataDir;
  }

  // 2. OpenClaw
  const openclawDir = getOpenClawUserDataDir();
  if (openclawDir) {
    return openclawDir;
  }

  // 3. 浏览器默认目录
  const defaultDir = getDefaultBrowserDataDir();
  if (defaultDir) {
    return defaultDir;
  }

  // 4. Skill 兜底
  console.warn(
    `[browser] ⚠ 未找到任何已有的 userDataDir，将使用 skill 内部目录：${SKILL_FALLBACK_DATA_DIR}\n` +
    `  建议通过以下方式指定：\n` +
    `  - 设置环境变量 BROWSER_USER_DATA_DIR\n` +
    `  - 安装 OpenClaw 并配置 browser profile`
  );
  if (!existsSync(SKILL_FALLBACK_DATA_DIR)) {
    mkdirSync(SKILL_FALLBACK_DATA_DIR, { recursive: true });
  }
  return SKILL_FALLBACK_DATA_DIR;
}

/**
 * 探测指定端口是否有浏览器在监听
 * @param {number} port
 * @param {string} [host='127.0.0.1']
 * @param {number} [timeout=1500]
 * @returns {Promise<boolean>}
 */
function isPortAlive(port, host = '127.0.0.1', timeout = 1500) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeout);
    socket.on('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/** 浏览器启动参数（适用于所有 Chromium 系浏览器） */
const BROWSER_ARGS = [
  // ── 基础 ──
  '--no-first-run',
  '--disable-default-apps',
  '--disable-popup-blocking',

  // ── 渲染稳定性（无头 / 无显卡服务器） ──
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',

  // ── 反检测（配合 stealth 插件 + ignoreDefaultArgs） ──
  '--disable-blink-features=AutomationControlled',

  // ── 网络 / 性能 ──
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',

  // ── UI 纯净度 ──
  '--disable-features=Translate',
  '--no-default-browser-check',
  '--disable-crash-reporter',
  '--hide-crash-restore-bubble',
];

/**
 * 连接到已运行的浏览器
 * @param {number} port
 * @returns {Promise<import('puppeteer-core').Browser>}
 */
async function connectBrowser(port) {
  const browserURL = `http://127.0.0.1:${port}`;
  const browser = await puppeteer.connect({
    browserURL,
    defaultViewport: null,
    protocolTimeout: config.browserProtocolTimeout,
  });
  console.log('[browser] connected to existing browser on port', port);
  return browser;
}

/**
 * 启动新的浏览器实例
 * @param {object} opts
 * @param {string} opts.executablePath
 * @param {number} opts.port
 * @param {string} opts.userDataDir
 * @param {boolean} opts.headless
 * @returns {Promise<import('puppeteer-core').Browser>}
 */
async function launchBrowser({ executablePath, port, userDataDir, headless }) {
  const browser = await puppeteer.launch({
    executablePath,
    headless,
    userDataDir,
    defaultViewport: null,
    args: [
      ...BROWSER_ARGS,
      `--remote-debugging-port=${port}`,
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    protocolTimeout: config.browserProtocolTimeout,
  });
  console.log('[browser] launched, pid:', browser.process()?.pid, 'port:', port, 'path:', executablePath);
  return browser;
}

/**
 * 在浏览器中找到 Gemini 标签页，或新开一个
 * @param {import('puppeteer-core').Browser} browser
 * @returns {Promise<import('puppeteer-core').Page>}
 */
async function findOrCreateGeminiPage(browser) {
  const pages = await browser.pages();

  // 优先复用已有的 Gemini 标签页
  for (const page of pages) {
    const url = page.url();
    if (url.includes('gemini.google.com')) {
      console.log('[browser] reusing existing Gemini tab:', url);
      await page.bringToFront();
      return page;
    }
  }

  // 没找到，新开一个
  const page = pages.length > 0 ? pages[0] : await browser.newPage();
  await page.goto('https://gemini.google.com/app', {
    waitUntil: 'networkidle2',
    timeout: 30_000,
  });
  console.log('[browser] opened new Gemini tab');
  return page;
}

/**
 * 确保浏览器可用 — Skill 唯一的对外浏览器管理入口
 *
 * 逻辑：
 *   1. 如果已有 _browser 且未断开 → 直接复用
 *   2. 检查端口是否有浏览器 → connect
 *   3. 否则自动检测 / 使用配置的路径启动浏览器
 *
 * userDataDir 解析优先级：
 *   opts.userDataDir > env BROWSER_USER_DATA_DIR > OpenClaw > 浏览器默认 > skill 兜底
 *
 * @param {object} [opts]
 * @param {string} [opts.executablePath] - 浏览器路径（不传则自动检测）
 * @param {number} [opts.port] - 调试端口（env: BROWSER_DEBUG_PORT，默认 9222）
 * @param {string} [opts.userDataDir] - 用户数据目录（env: BROWSER_USER_DATA_DIR，不传则多级兜底）
 * @param {boolean} [opts.headless] - 无头模式（env: BROWSER_HEADLESS，默认 false）
 * @returns {Promise<{browser: import('puppeteer-core').Browser, page: import('puppeteer-core').Page}>}
 */
export async function ensureBrowser(opts = {}) {
  const {
    executablePath = config.browserPath,
    port = config.browserDebugPort,
    userDataDir = resolveUserDataDir(),
    headless = config.browserHeadless,
  } = opts;

  // 1. 复用已有连接
  if (_browser && _browser.isConnected()) {
    console.log('[browser] reusing existing connection');
    const page = await findOrCreateGeminiPage(_browser);
    return { browser: _browser, page };
  }

  // 2. 尝试连接已在运行的浏览器
  const alive = await isPortAlive(port);
  if (alive) {
    try {
      _browser = await connectBrowser(port);
      const page = await findOrCreateGeminiPage(_browser);
      return { browser: _browser, page };
    } catch (err) {
      console.warn('[browser] connect failed, will try launch:', err.message);
    }
  }

  // 3. 启动新浏览器：优先用配置路径，否则自动检测
  const resolvedPath = executablePath || detectBrowser();
  if (!resolvedPath) {
    throw new Error(
      `[browser] 端口 ${port} 无可用浏览器，且未找到可执行文件。\n` +
      `请通过以下任一方式解决：\n` +
      `  1. 设置环境变量 BROWSER_PATH 指向 Chrome / Edge / Chromium 的可执行文件\n` +
      `  2. 手动启动浏览器：chrome --remote-debugging-port=${port} --user-data-dir="${userDataDir}"\n` +
      `  3. 安装 Chrome 或 Edge 到默认位置`
    );
  }

  _browser = await launchBrowser({ executablePath: resolvedPath, port, userDataDir, headless });
  const page = await findOrCreateGeminiPage(_browser);
  return { browser: _browser, page };
}

/**
 * 断开浏览器连接（不杀进程，方便下次复用）
 */
export function disconnect() {
  if (_browser) {
    _browser.disconnect();
    _browser = null;
    console.log('[browser] disconnected');
  }
}

/**
 * 关闭浏览器（杀进程）
 */
export async function close() {
  if (_browser) {
    await _browser.close();
    _browser = null;
    console.log('[browser] closed');
  }
}

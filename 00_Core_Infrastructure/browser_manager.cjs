// 00_Core_Infrastructure/browser_manager.cjs
// 【架构升级 - 策略路由版】彻底隔离京东与拼多多的反爬特征，防止互相污染

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const path = require('path');
const fs = require('fs');

// 接入环境中心
const { ROOT } = require('./env_config.cjs');
// 加载根目录下的 .env
const envPath = path.join(ROOT, '.env');
require('dotenv').config({ path: envPath });

chromium.use(stealth);

// ==========================================
// [基座代码] 辅助工具函数 (保持原有功能不受破坏)
// ==========================================

/**
 * 辅助函数：模拟人类真实按键输入（非匀速）
 */
async function humanType(page, text) {
    for (const char of text) {
        // 模拟人类按键，产生 60ms 到 250ms 不等的极大方差延迟
        const delay = Math.floor(Math.random() * 190) + 60;
        await page.keyboard.press(char, { delay });
        // 模拟按键后的短暂停顿
        await page.waitForTimeout(Math.floor(Math.random() * 50) + 10);
    }
}

/**
 * 辅助函数：模拟真实鼠标移动与点击（消除瞬移特征）
 */
async function humanClick(page, selector) {
    const element = await page.locator(selector).first();
    const box = await element.boundingBox();
    if (box) {
        // 提取元素中心点，并加入少量随机偏移量，避免每次都点在绝对正中心
        const targetX = box.x + box.width / 2 + (Math.random() * 10 - 5);
        const targetY = box.y + box.height / 2 + (Math.random() * 10 - 5);
        // steps 参数强制 Playwright 将鼠标移动拆分为多个中间点，模拟滑动轨迹
        await page.mouse.move(targetX, targetY, { steps: Math.floor(Math.random() * 15) + 10 });
        await page.waitForTimeout(Math.floor(Math.random() * 100) + 50);
        await page.mouse.down();
        await page.waitForTimeout(Math.floor(Math.random() * 80) + 20); // 按下与抬起的物理间隔
        await page.mouse.up();
    } else {
        // 兜底方案
        await element.click();
    }
}

// ==========================================
// [增量模块] 独立策略层：拼多多专属启动策略
// ==========================================
async function _launchPDDStrategy(profileDir, headless, downloadsPath) {
    console.log(`   💡 [策略引擎] 命中拼多多防御策略：应用 Chromium 原生伪装与 JS 特征覆盖...`);
    const launchOptions = {
        headless: false,             // 调试期间务必保持 false
        channel: 'msedge',           // 强制调用本机的真实 Edge 浏览器内核
        viewport: null,              // 设为 null 配合 start-maximized，避免暴露标准的无头浏览器分辨率 (如 800x600)
        ignoreDefaultArgs: ["--enable-automation"], // 🌟 核心：消除浏览器顶部的“正受到自动测试软件控制”警告条
        args: [
            '--start-maximized',     // 窗口最大化
            '--disable-blink-features=AutomationControlled', // 🌟 核心：从 Blink 内核层面抹除自动化特征
            '--disable-infobars',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--lang=zh-CN,zh;q=0.9', // 伪装真实的本地语言环境
            '--disable-web-security' // 降低严格模式的安全拦截策略
        ]
    };
    
    // 使用带缓存的模式拉起 (接收外层路由分发进来的 profileDir)
    const context = await chromium.launchPersistentContext(profileDir, launchOptions);
    
    
    await context.addInitScript(() => {
        // 1. 彻底干掉 webdriver 属性
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        
        // 2. 伪装真实的插件数量 (无头浏览器通常 plugins 长度为 0)
        Object.defineProperty(navigator, 'plugins', {
            get: () => [1, 2, 3, 4, 5],
        });
        
        // 3. 抹除 Playwright 特有的 window 变量
        window.navigator.chrome = { runtime: {} };
    });
    return context;
}

// ==========================================
// [增量模块] 独立策略层：京东专属启动策略
// ==========================================
async function _launchJDStrategy(profileDir, headless, downloadsPath, customChannel) {
    console.log(`   💡 [策略引擎] 命中京东防御策略：应用系统真实内核 (msedge) 接管...`);
    const launchOptions = {
        channel: customChannel || 'msedge', // JD 专属：必须挂载真实内核匹配 TLS
        headless: headless,
        viewport: null, 
        args: [
            '--start-maximized',
            '--disable-blink-features=AutomationControlled',
            '--no-default-browser-check',
            '--disable-infobars',
            '--no-sandbox',
            '--ignore-certificate-errors'
        ],
        ignoreDefaultArgs: ['--enable-automation']
    };
    if (downloadsPath) launchOptions.downloadsPath = downloadsPath;

    // JD 专属：绝对信任 stealth 插件，不做任何额外 addInitScript 画蛇添足的修改
    const context = await chromium.launchPersistentContext(profileDir, launchOptions);
    return context;
}

// ==========================================
// [基座代码] 总控路由入口
// ==========================================

/**
 * 全局统一的浏览器启动器 (路由分发版)
 */
async function launchBrowser(config = {}) {
    const { 
        profileDir, 
        headless = false, 
        downloadsPath, 
        platform = 'jd' // 默认策略定为京东
    } = config;

    console.log(`\n🛡️  [基座] 正在为 【${platform.toUpperCase()}】 启动防爬工作负载...`);
    console.log(`   📂 指纹隔离目录: ${profileDir}`);

    try {
        let context;
        // 核心路由分发逻辑
        if (platform === 'pinduoduo') {
            context = await _launchPDDStrategy(profileDir, headless, downloadsPath);
        } else {
            context = await _launchJDStrategy(profileDir, headless, downloadsPath, config.channel);
        }
        
        console.log(`   ✅ [基座就绪] 浏览器环境初始化完成，隔离策略已生效。`);
        return context;
    } catch (error) {
        console.error(`🚨 [致命错误] 底层环境初始化失败:`, error);
        throw error;
    }
}


/**
 * 【强化版】多级降级智能鉴权 (保持原样)
 */
async function smartLogin(page, config) {
    const { 
        platform = 'jd', // 默认京东
        checkUrl, loginUrlKeyword, 
        userSelector, passSelector, submitSelector, 
        envUserKey, envPassKey, defaultUser 
    } = config;

    console.log(`\n🔐 [${config.platform || '未知平台'}] 启动鉴权探测...`);
    
    await page.goto(checkUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    if (!page.url().includes(loginUrlKeyword)) {
        console.log(`   💎 [L1] 检测到有效的 Session 缓存。`);
        return true;
    }

    const envUser = process.env[envUserKey];
    const envPass = process.env[envPassKey];

    if (envUser && envPass) {
        console.log(`   🤖 [L2] 执行自动化填充策略...`);
        try {
            if (platform === 'pinduoduo') {
                await humanClick(page, userSelector);
                await humanType(page, envUser);
                await page.waitForTimeout(Math.floor(Math.random() * 800) + 400); 
                await humanClick(page, passSelector);
                await humanType(page, envPass);
            } else {
                await page.fill(userSelector, envUser);
                await page.fill(passSelector, envPass);
            }

            await page.waitForTimeout(500);

            const protocol = page.locator('.beast-core-checkbox, input[type="checkbox"]').first();
            if (await protocol.isVisible()) {
                if (platform === 'pinduoduo') {
                    await humanClick(page, '.beast-core-checkbox, input[type="checkbox"]');
                } else {
                    await protocol.click({ force: true });
                }
            }

            await page.waitForTimeout(Math.floor(Math.random() * 500) + 300);

            if (platform === 'pinduoduo') {
                await humanClick(page, submitSelector);
            } else {
                await page.click(submitSelector);
            }
            
            try {
                await page.waitForURL(url => !url.href.includes(loginUrlKeyword), { timeout: 10000 });
                console.log(`   ✅ [L2] 自动化登录通过。`);
                return true;
            } catch (e) {
                console.log(`   ❌ [L2] 自动登录超时，可能触发了滑块或安全验证。`);
            }
        } catch (err) {
            console.log(`   ❌ [L2] 填充异常: ${err.message}`);
        }
    }

    console.log(`   🆘 [L3] 进入人工接管模式...`);
    const fallbackUser = envUser || defaultUser || '待输入账号';
    try {
        if (await page.locator(userSelector).isVisible()) {
            await page.locator(userSelector).fill(fallbackUser);
        }
    } catch (e) {}

    process.stdout.write('\x07');
    await page.waitForURL(url => !url.href.includes(loginUrlKeyword), { timeout: 0 });
    console.log(`   🎉 [L3] 验证通过，脚本恢复。`);
    return true;
}

/**
 * 拼多多专用的强力关闭弹窗工具
 * [主动干预] 根据历史处理复杂UI经验，优先寻找并精准定位内部的图标（svg、icon）或纯文本节点进行强力点击
 */
async function tryClosePddPopups(page) {
    // 增加内部 svg 和 icon 的精确定位，避免外层 div 拦截点击事件
    const closeSelectors = [
        'svg[data-testid="beast-core-modal-icon-close"]',
        '[data-testid="beast-core-modal-icon-close"] svg', // 尝试点击内部 svg
        '.beast-core-modal-close icon',
        'button:has-text("知道了")',
        'button:has-text("关闭")'
    ];

    for (const selector of closeSelectors) {
        const btns = page.locator(selector);
        const count = await btns.count();
        for (let i = 0; i < count; i++) {
            const btn = btns.nth(i);
            if (await btn.isVisible({ timeout: 500 })) {
                try {
                    await btn.click({ force: true, timeout: 1000 }).catch(() => {});
                    if (await btn.isVisible({ timeout: 500 })) {
                        await btn.evaluate(node => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));
                    }
                } catch (e) {}
            }
        }
    }
}

module.exports = { launchBrowser, smartLogin, tryClosePddPopups };
/**
 * Pinduoduo Chat Scraper (源头清洗版 - 2026.02)
 * * 功能：在抓取阶段直接根据关键词（viomi/客服）强制区分角色，输出无需清洗的干净数据。
 */

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');

// ================= [配置区域] =================
const OUTPUT_DIR = path.join(__dirname, 'chat_logs');
const USER_DATA_DIR = path.join(__dirname, 'browser_profiles', 'pdd_store');
const TARGET_URL = 'https://mms.pinduoduo.com/mms-chat/search?msfrom=mms_sidenav';
const TASKS_FILE = path.join(__dirname, 'tasks.json');

// 定义客服关键词 (命中即视为客服)
const CS_KEYWORDS = ['viomi', '客服', '旗舰店', '机器人', '小云朵', '小茉莉', '小仙女', '米小锋'];

// ================= [工具函数] =================
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

const randomDelay = (min = 800, max = 1500) => {
    return new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));
};

function saveEmptyRecord(orderID) {
    const fileName = path.join(OUTPUT_DIR, `${orderID}_chat.json`);
    if (!fs.existsSync(fileName)) {
        const emptyData = {
            orderId: orderID,
            customerName: "Unknown",
            customerAvatar: "",
            messages: []
        };
        fs.writeFileSync(fileName, JSON.stringify(emptyData, null, 2));
        console.log(`   🚫 无聊天记录 -> 生成空文件标记`);
    }
}

function calculateDateRange(orderId) {
    try {
        const idStr = String(orderId).trim();
        const datePart = idStr.substring(0, 6);
        if (/^\d{6}$/.test(datePart)) {
            const year = '20' + datePart.substring(0, 2);
            const month = datePart.substring(2, 4);
            const day = datePart.substring(4, 6);
            const orderDate = DateTime.fromISO(`${year}-${month}-${day}`);
            if (orderDate.isValid) {
                return `${orderDate.minus({ days: 30 }).toFormat('yyyy-MM-dd')} ~ ${orderDate.plus({ days: 60 }).toFormat('yyyy-MM-dd')}`;
            }
        }
    } catch (e) {}
    return `${DateTime.now().minus({ months: 3 }).toFormat('yyyy-MM-dd')} ~ ${DateTime.now().toFormat('yyyy-MM-dd')}`;
}

// ================= [主逻辑] =================
async function runChatScraper() {
    console.log(`🚀 [Node.js] 启动爬虫 (源头清洗版)...`);

    let tasks = [];
    try {
        if (fs.existsSync(TASKS_FILE)) {
            tasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8'));
            console.log(`📋 待处理任务数: ${tasks.length}`);
        } else {
            console.log("⚠️ 未找到 tasks.json，退出。");
            return;
        }
    } catch (e) { return; }

    if (tasks.length === 0) return;

    const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
        channel: 'msedge',
        headless: false,
        viewport: null,
        args: ['--start-maximized', '--disable-blink-features=AutomationControlled']
    });

    const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

    try {
        await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);

        if (page.url().includes('login')) {
            console.log("🛑 请扫码登录...");
            await page.waitForURL(url => !url.toString().includes('login'), { timeout: 0 });
        }

        for (let i = 0; i < tasks.length; i++) {
            const orderID = tasks[i];
            console.log(`\n=== ⚡ 处理订单 (${i + 1}/${tasks.length}): ${orderID} ===`);

            try {
                // A. 切换模式 & B. 输入订单
                await page.locator('label').filter({ hasText: '按订单/违规会话编号查询' }).click();
                const orderInput = page.locator('input[placeholder*="订单/违规会话编号"]');
                await orderInput.clear();
                await orderInput.fill(orderID);
                
                // C. 日期处理
                const dateRangeStr = calculateDateRange(orderID);
                await page.evaluate(({ selector, val }) => {
                    const el = document.querySelector(selector);
                    if (el) {
                        el.removeAttribute('readonly');
                        el.value = val;
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }, { selector: 'input[data-testid="beast-core-rangePicker-htmlInput"]', val: dateRangeStr });
                
                await randomDelay(500, 1000);

                // D. 查询
                await page.locator('button').filter({ hasText: '查询' }).first().click();
                
                // E. 等待结果
                let hasResults = false;
                try {
                    await Promise.any([
                        page.waitForSelector('.message-item', { state: 'visible', timeout: 5000 }),
                        page.waitForSelector('.result-col-body', { timeout: 5000 })
                    ]);
                    const msgCount = await page.locator('.message-item').count();
                    if (msgCount > 0) hasResults = true;
                } catch (e) { hasResults = false; }

                if (!hasResults) {
                    saveEmptyRecord(orderID);
                    continue;
                }

                // F. [核心升级] 遍历消息并强制清洗角色
                await page.waitForTimeout(1000);
                
                const messageElements = await page.locator('.message-item').all();
                const allMessages = [];
                let identifiedUser = { name: "Unknown", avatar: "" };
                let userFound = false;

                for (const el of messageElements) {
                    const msgData = await el.evaluate(node => {
                        // 1. 基础信息提取
                        const nameEl = node.querySelector('.message-name');
                        const timeEl = node.querySelector('.message-time');
                        const avatarEl = node.querySelector('.message-avatar');
                        
                        // 2. 内容提取
                        const textEl = node.querySelector('.message-text');
                        const contentImgEl = node.querySelector('.message-body img.message-image');
                        const bodyImg = node.querySelector('.message-body img'); // 兼容
                        
                        let content = '';
                        let type = 'text';
                        if (contentImgEl) { content = contentImgEl.src; type = 'image'; } 
                        else if (bodyImg && !bodyImg.classList.contains('message-avatar')) { content = bodyImg.src; type = 'image'; } 
                        else if (textEl) { content = textEl.innerText.trim(); }

                        // 3. 提取属性
                        const rawName = nameEl ? nameEl.innerText.trim() : '未知';
                        const avatarSrc = avatarEl ? avatarEl.src : '';
                        const timeStr = timeEl ? timeEl.innerText.trim() : '';
                        const isSystem = node.classList.contains('system-message') || rawName.includes('系统消息');
                        
                        return {
                            time: timeStr,
                            name: rawName,
                            avatar: avatarSrc,
                            type: type,
                            content: content,
                            isSystem: isSystem
                        };
                    });

                    // -------------------------------------------------
                    // [黄金清洗法则] 强制角色判定
                    // 1. 系统 -> system
                    // 2. 名字含客服词 -> cs
                    // 3. 其他 -> user
                    // -------------------------------------------------
                    
                    const lowerName = msgData.name.toLowerCase();
                    const isAgent = CS_KEYWORDS.some(kw => lowerName.includes(kw));

                    if (msgData.isSystem) {
                        msgData.role = 'system';
                    } else if (isAgent) {
                        msgData.role = 'cs';
                    } else {
                        // 排除掉系统和客服，剩下的必然是用户
                        msgData.role = 'user';
                        
                        // 顺手抓取用户身份 (只抓第一个遇到的用户)
                        if (!userFound) {
                            identifiedUser.name = msgData.name;
                            identifiedUser.avatar = msgData.avatar;
                            userFound = true;
                        }
                    }

                    allMessages.push({
                        time: msgData.time,
                        role: msgData.role, // 这里已经是清洗过的准确角色
                        name: msgData.name,
                        type: msgData.type,
                        content: msgData.content
                    });
                }

                console.log(`   👤 锁定身份: [${identifiedUser.name}]`);
                
                // H. 保存
                const finalData = {
                    orderId: orderID,
                    customerName: identifiedUser.name,
                    customerAvatar: identifiedUser.avatar,
                    messages: allMessages
                };

                const fileName = path.join(OUTPUT_DIR, `${orderID}_chat.json`);
                fs.writeFileSync(fileName, JSON.stringify(finalData, null, 2));
                console.log(`   💾 保存成功: ${allMessages.length} 条消息 (已清洗角色)`);

            } catch (err) {
                console.error(`   ❌ 出错: ${err.message}`);
            }
            await randomDelay(1000, 2000);
        }

    } finally {
        console.log(`🎉 [Node.js] 结束`);
        await context.close();
    }
}

runChatScraper();
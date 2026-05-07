// app4_master_controller.cjs
// 全局总控引擎：串联调度 01 - 04 业务脚本，统一进行容错与状态管理

const { chromium } = require('playwright');
const path = require('path');
const fileUtils = require('../00_Core_Infrastructure/file_utils.cjs');
const dbManager = require('../00_Core_Infrastructure/db_manager.cjs');

// 引入改造完毕的 01 - 04 业务脚本
const script01 = require('./01-API_Network_Probe.cjs');
const script02 = require('./02-Central_Inventory_Sync.cjs');
const script03 = require('./03-Inventory_Risk_Analyzer.cjs');
const script04 = require('./04-Viomi_DBS_Ultimate_Consumables.cjs');

async function startApp() {
    console.log('🚀 === [App4 全局总控引擎] 任务列车启动 ===');
    let browserContext = null;

    try {
        // 1. 初始化数据库与底层文件校验
        console.log('\n--- 初始化公共基座服务 ---');
        const dbInstance = dbManager.getRawDbInstance();
        if (!dbInstance) throw new Error("全局数据库实例化失败，中断运行。");
        
        // 2. 初始化纯净内网浏览器环境 (剥离防爬虫特性，适配企业级后台)
        console.log('\n--- 初始化纯净浏览器实例 ---');
        console.log('ℹ️ 检测到内网安全环境，已绕过全局防爬基座，使用原生 Chromium...');
        
        const browser = await chromium.launch({ headless: false }); 
        
        // 核心修复：设置全高清分辨率(防止内容被挤压消失)和真实的物理机 UA
        browserContext = await browser.newContext({
            viewport: { width: 1920, height: 1080 }, 
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });

        // 核心修复：注入极简隐身代码，绕过轻量级网关探测，不破坏 Vue/React 渲染
        await browserContext.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });
        
        // 悄悄把 browser 实例挂载到 context 上，方便执行完毕后销毁
        browserContext.rawBrowser = browser; 

        // ======================= [执行列车调度] =======================

        // [调度 01 脚本：动态模板克隆终极版]
        console.log('\n--- 正在拉起 [模块 01: Sales TOP20 Sniper] ---');
        try {
            await script01.run(browserContext);
        } catch (e) {
            console.error(`❌ [模块 01] 发生崩溃: ${e.message}，列车继续...`);
        }

        // [调度 02 脚本：中央库存查询与同步]
        console.log('\n--- 正在拉起 [模块 02: Central Inventory Sync] ---');
        try {
            if (script02 && typeof script02.run === 'function') {
                await script02.run(browserContext);
            } else {
                console.log('⚠️ [模块 02] 暂未暴露 run 方法或文件不存在，跳过。');
            }
        } catch (e) {
            console.error(`❌ [模块 02] 发生崩溃: ${e.message}，列车继续...`);
        }

        // [调度 03 脚本: 库存诊断分析]
        console.log('\n--- 正在拉起 [模块 03: Inventory Risk Analyzer] ---');
        try {
            // 注意 03 脚本是纯数据计算，不需要浏览器上下文
            if (script03 && typeof script03.executeRiskAnalysis === 'function') {
                await script03.executeRiskAnalysis();
            } else {
                console.log('⚠️ [模块 03] 暂未暴露 executeRiskAnalysis 方法，跳过。');
            }
        } catch (e) {
            console.error(`❌ [模块 03] 分析引擎发生崩溃: ${e.message}，列车继续...`);
        }

        // [调度 04 脚本：DBS 基础资料抓取与云端同步]
        console.log('\n--- 正在拉起 [模块 04: Viomi DBS Ultimate Consumables] ---');
        try {
            if (script04 && typeof script04.run === 'function') {
                await script04.run(browserContext);
            } else {
                console.log('⚠️ [模块 04] 暂未暴露 run 方法，跳过。');
            }
        } catch (e) {
            console.error(`❌ [模块 04] 发生崩溃: ${e.message}，列车继续...`);
        }

    } catch (globalError) {
        console.error('\n🚨 [总控级致命错误] 引擎主架构崩溃:', globalError.message);
    } finally {
        console.log('\n--- 释放系统资源 ---');
        // 释放原生浏览器
        if (browserContext && browserContext.rawBrowser) {
            await browserContext.rawBrowser.close().catch(() => {});
        } else if (browserContext && typeof browserContext.close === 'function') {
            await browserContext.close().catch(() => {});
        }
        console.log('🏁 === [App4 全局总控引擎] 任务列车全部抵达终点 ===');
    }
}

// 独立调试模式支持
if (require.main === module) {
    startApp();
} else {
    module.exports = { startApp };
}
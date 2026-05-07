// App3_Store_Operations/00-Master_Runner.cjs
const path = require('path');
const fs = require('fs/promises');

// 1. 引入全局中台基座 (跨目录调用)
const browserManager = require('../00_Core_Infrastructure/browser_manager.cjs');

// 2. 引入经过瘦身的业务模块 (它们现在对外都只暴露 startApp)
const UnifiedTask = require('./01-Unified_Task.cjs');
const FinanceSync = require('./02-Finance_Sync.cjs');
const ExpenseSync = require('./03-Expense_Sync.cjs'); 
const PriceGuard = require('./04-Price_Guard.cjs');

// 3. 全局多店矩阵配置 (指向中央指纹库)
const STORE_CONFIGS = [
    { 
        storeName: '云米拼多多官方旗舰店', 
        profileDir: path.join(__dirname, '..', '00_Shared_Profiles', 'pdd_yunmi_official'),
        envUserKey: 'PDD_USER_YUNMI',
        envPassKey: 'PDD_PASS_YUNMI'
    },
    { 
        storeName: '云米拼多多专卖店_新店',
        profileDir: path.join(__dirname, '..', '00_Shared_Profiles', 'pdd_yunmi_new'),
        envUserKey: 'PDD_USER_NEW',
        envPassKey: 'PDD_PASS_NEW'
    }
];

async function main() {
    console.log(`\n======================================================`);
    console.log(`🚀 [自动化ERP中台] App3-拼多多多店全链路业务矩阵启动`);
    console.log(`======================================================`);

    // 预建统一的下载缓冲区
    const globalDownloadPath = path.join(__dirname, '..', '00_Shared_Downloads');
    await fs.mkdir(globalDownloadPath, { recursive: true }).catch(()=>{});

    for (const config of STORE_CONFIGS) {
        console.log(`\n>>> 正在初始化店铺环境: 【${config.storeName}】 <<<`);
        let context = null;

        try {
            // ★ 调用公共基座启动浏览器，自动挂载防爬盾和下载路径
            context = await browserManager.launchBrowser({ 
                profileDir: config.profileDir,
                headless: false,
                platform: 'pinduoduo', // 显式声明平台
                downloadsPath: globalDownloadPath
            });

            const page = context.pages()[0] || await context.newPage();
            
            // ★ 调用基座进行智能鉴权 (免密/注入/人工兜底)
            const loginConfig = {
                platform: 'pinduoduo', // 内部逻辑会根据此字符串切换输入策略
                checkUrl: 'https://mms.pinduoduo.com/home',
                loginUrlKeyword: 'login',
                userSelector: 'input#usernameId', 
                passSelector: 'input#passwordId', 
                submitSelector: 'button[type="submit"]',
                envUserKey: config.envUserKey,
                envPassKey: config.envPassKey
            };
            
            await browserManager.smartLogin(page, loginConfig);

            // ==========================================
            // 业务管线流水作业 (共享同一个 Page，规范化拉起)
            // ==========================================
            console.log(`\n[流水线] 模块 1/4: 【订单与推广报表】双线轮询...`);
            // 改造：统一使用 startApp，并传入 params 对象
            await UnifiedTask.startApp(page, { storeName: config.storeName });

            console.log(`\n[流水线] 模块 2/4: 【多账户财务流水】同步...`);
            // 改造：统一使用 startApp，并传入 params 对象
            await FinanceSync.startApp(page, { storeName: config.storeName });

            console.log(`\n[流水线] 模块 3/4: 【营销活动结算】明细抓取...`);
            // 改造：统一使用 startApp，并传入 params 对象
            await ExpenseSync.startApp(page, { storeName: config.storeName });

            console.log(`\n[流水线] 模块 4/4: 【价格卫兵】自动巡航与调价...`);
            // 改造：统一使用 startApp，并传入 params 对象
            await PriceGuard.startApp(page, { storeName: config.storeName });

        } catch (storeError) {
            console.error(`\n❌ 店铺 【${config.storeName}】 流水线意外崩断:`, storeError.message);
        } finally {
            if (context) {
                console.log(`🏁 正在安全释放 【${config.storeName}】 的浏览器资源...`);
                await context.close();
            }
        }
    }
    console.log('\n🎉 App3 矩阵：所有店铺的全链路自动化任务圆满完成！');
}

// 导出模块供最顶层的 Global_Runner 调度
module.exports = { 
    startApp: async () => {
        await main();
    }
};
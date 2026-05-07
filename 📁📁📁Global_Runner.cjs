// D:\WorkSpace\01_自动化开发\Global_Runner.cjs
// 【全局调度中枢】：提供终端可视化交互菜单，完美接入 App1, App2, App3, App7 及静默调度机制

const inquirer = require('inquirer');
const path = require('path');

// ==========================================
// 1. 完美挂载：引入各业务线的局部总控 (App Runner)
// ==========================================
// ✅ App1: 品牌日常价格监控
const App1_Runner = require('./App1_Price_Monitor品牌价格/main_controller.cjs');

// ✅ App2: 市场竞品大盘雷达
const App2_Runner = require('./App2_Market_Radar市场价格/pddprice-scraper.cjs');

// ✅ App3: 店铺运营与财务中枢
const App3_Runner = require('./App3_Store_Operations店铺运营/00-Master_Runner.cjs');

// 🚧 App4 & App5: 待后续重构接入
const App4_Runner = require('./App4_Viomi超管系统/app4_master_controller.cjs');
const App5_Runner = { startApp: async () => console.log('⏳ App5 物流轨迹局部总控待接入，敬请期待...') };

// ✅ App6: 矩阵战术工具（商品克隆/注入）
const App6_Runner = require('./App6_Matrix_Tools店群矩阵工具/01-Product_Clone_Engine.cjs');

// ✅ App7: 自动化报表与数据分析引擎 (新增)
const App7_Runner = require('./App7_Data_Analytics/report_runner.cjs');
// ✅ App8: 
const App8_Runner = require('./App7_Data_Analytics/report_runner.cjs');
// ✅ App9: GeminiBackup_聊天备份 (新增)
const App9_Runner = require('./App9_GeminiBackup_聊天备份/google.js');
// ✅ App10: GeminiBackup_聊天备份 (新增)
const App10_Runner = { startApp: async () => console.log('⏳ App5 物流轨迹局部总控待接入，敬请期待...') };
// ✅ App11: GeminiBackup_聊天备份 (新增)
const App11_Runner = require('./App11_DBS商品信息建档/Viomi_DBS_Ultimate_Consumables.cjs');
// ==========================================
// 2. 核心交互菜单逻辑
// ==========================================
async function main() {
    console.clear(); // 清屏，保持终端整洁
    console.log(`\n======================================================`);
    console.log(`🤖 欢迎使用【电商自动化 ERP 中台矩阵】全局调度系统`);
    console.log(`======================================================\n`);

    // 使用 inquirer 生成终端交互菜单
    const answers = await inquirer.prompt([
        {
            type: 'list',
            name: 'selectedApp',
            message: '请通过键盘【上下键】选择要启动的业务线，按【回车】确认：',
            choices: [
                { name: '📦 App1 - 品牌日常价格监控 (全平台护城河)', value: 'APP1' },
                { name: '📡 App2 - 市场竞品大盘雷达 (竞品增量监测)', value: 'APP2' },
                { name: '🏪 App3 - 店铺运营与财务中枢 (内务自动化)', value: 'APP3' },
                { name: '⚙️  App4 - Viomi 超管系统及库存分析 (完成)', value: 'APP4' },
                { name: '🚚 App5 - 物流轨迹追踪系统 (待改造)', value: 'APP5' },
                { name: '🔥 App6 - 跨店商品克隆引擎 (数据注入/劫持)', value: 'APP6' },
                { name: '📊 App7 - 生成综合复盘报表 (资金核算/动销分析)', value: 'APP7' },
                { name: '📊 App8 - 生成综合复盘报表 (资金核算/动销分析)', value: 'APP8' },
                { name: '📊 App9 - GeminiBackup_聊天备份', value: 'APP9' },
                { name: '📊 App10 - 待定', value: 'APP10' },
                { name: '📊 App11 - App11_DBS商品信息建档', value: 'APP11' },
                { name: '🚀 终极模式：按顺序静默执行 App1 -> App2 -> App3', value: 'ALL' },
                { name: '❌ 退出系统', value: 'EXIT' }
            ],
            pageSize: 14 // 增加菜单显示行数以完整展示新增项
        }
    ]);

    const choice = answers.selectedApp;

    if (choice === 'EXIT') {
        console.log(`\n👋 感谢使用，系统已安全退出。\n`);
        process.exit(0);
    }

    console.log(`\n======================================================`);
    console.log(`>>> 正在向目标模块分配底层资源，即将拉起执行...`);
    console.log(`======================================================\n`);

    try {
        switch (choice) {
            case 'APP1':
                await App1_Runner.startApp();
                break;
            case 'APP2':
                await App2_Runner.startApp();
                break;
            case 'APP3':
                await App3_Runner.startApp();
                break;
            case 'APP4':
                await App4_Runner.startApp();
                break;
            case 'APP5':
                await App5_Runner.startApp();
                break;
            case 'APP6':
                await App6_Runner.startApp();
                break;
            case 'APP7': // 【新增】App7 路由分发
                await App7_Runner.startApp();
                break;
            case 'APP8': 
                await App8_Runner.startApp();
                break;
            case 'APP9': 
                await App9_Runner.startApp();
                break;
            case 'APP10': 
                await App10_Runner.startApp();
                break;
            case 'APP11': 
                await App11_Runner.startApp();
                break;
            case 'ALL':
                console.log(`\n[全局调度] ⚠️ 警告：正在执行全火力轮询模式，预计耗时较长...\n`);
                
                console.log(`\n[进度 1/3] 正在启动 App1 价格监控...`);
                await App1_Runner.startApp();
                
                console.log(`\n[进度 2/3] 正在启动 App2 市场雷达...`);
                await App2_Runner.startApp();
                
                console.log(`\n[进度 3/3] 正在启动 App3 店铺运营...`);
                await App3_Runner.startApp();
                
                console.log(`\n🎉 [全局调度] 所有核心业务线任务已全部圆满完成！`);
                break;
        }
    } catch (globalError) {
        console.error(`\n🚨 全局调度捕获到子系统致命异常:`, globalError.message);
    }

    console.log(`\n======================================================`);
    console.log(`✅ 当前任务通道执行完毕。`);
    console.log(`======================================================\n`);
    
    // 废弃死板的 setTimeout 定时器，改用人工回车确认
    await inquirer.prompt([
        {
            type: 'input',
            name: 'continue',
            message: '查看完毕后，请按【回车键】返回主菜单...'
        }
    ]);

    main(); // 等待您按下回车后，再清屏并重新拉起主菜单
}

// ==========================================
// 3. 引擎启动入口 (人机双驱模式)
// ==========================================
async function init() {
    // 检查是否带有命令行参数，例如: node Global_Runner.cjs --app=APP7
    const args = process.argv.slice(2);
    const appArg = args.find(arg => arg.startsWith('--app='));

    if (appArg) {
        // AI Agent 静默调用模式 (无头执行，直接分发任务，不弹可视化菜单)
        const targetApp = appArg.split('=')[1];
        console.log(`\n🤖 [Agent 模式] 检测到外部指令，拉起任务: ${targetApp}`);
        
        try {
            switch(targetApp) {
                case 'APP1': await App1_Runner.startApp(); break;
                case 'APP2': await App2_Runner.startApp(); break;
                case 'APP3': await App3_Runner.startApp(); break;
                case 'APP4': await App4_Runner.startApp(); break;
                case 'APP5': await App5_Runner.startApp(); break;
                case 'APP6': await App6_Runner.startApp(); break;
                case 'APP7': await App7_Runner.startApp(); break;
                case 'APP8': await App8_Runner.startApp(); break;
                case 'APP9': await App9_Runner.startApp(); break;
                case 'APP10': await App9_Runner.startApp(); break;
                case 'APP11': await App9_Runner.startApp(); break;
                default: console.log(`❌ 未知指令: ${targetApp}，任务取消。`);
            }
        } catch (globalError) {
            console.error(`\n🚨 静默执行捕获异常:`, globalError.message);
        }
        
        // 执行完毕后直接退出，避免阻塞 Agent 进程
        process.exit(0); 
    } else {
        // 人工介入模式：启动终端可视化菜单
        await main(); 
    }
}

// 启动全局调度
init();
// App7_Data_Analytics/report_runner.cjs
const dbManager = require('../00_Core_Infrastructure/db_manager.cjs');
const fileUtils = require('../00_Core_Infrastructure/file_utils.cjs');
const { REVENUE_REPORTS } = require('../00_Shared_Database数据库/sql_dictionary.cjs');
const path = require('path');
const fs = require('fs');

async function startApp() {
    console.log("\n📊 开始生成自动化复盘报表...");
    
    // 确保 output 目录存在，如果不存在则自动创建
    const outputDir = path.join(__dirname, 'output');
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // 调用新增的基座通道，获取原始底层实例
    const db = dbManager.getRawDbInstance(); 

    // ==========================================
    // 任务 1：生成资金核算报表 (加入容错机制)
    // ==========================================
    try {
        console.log(`\n⏳ [1/2] 正在提取数据: ${REVENUE_REPORTS.PDD_30DAYS_FINANCIAL_FEE.name}...`);
        // 尝试执行 SQL
        const financialData = db.prepare(REVENUE_REPORTS.PDD_30DAYS_FINANCIAL_FEE.sql).all();
        
        if (financialData && financialData.length > 0) {
            const financialPath = path.join(outputDir, `资金核算报表_${Date.now()}.xlsx`);
            await fileUtils.exportToExcel(financialData, financialPath);
        } else {
            console.log(`   ⚠️ 该报表提取数据为空，跳过导出。`);
        }
    } catch (e) {
        // 如果遇到类似 "no such table" 的致命错误，在这里被拦截，不会导致程序崩溃
        console.log(`   ❌ [跳过本报表] 资金核算报表执行失败！`);
        console.log(`   🚨 失败原因: ${e.message}`);
        console.log(`   💡 建议排查: 请打开 DB Browser，检查你当前的数据库文件里，是否真的存在 pdd_deposit_balance_bill 等账户流水表。`);
    }

    // ==========================================
    // 任务 2：生成动销与退款趋势报表 (独立执行，不受上面影响)
    // ==========================================
    try {
        console.log(`\n⏳ [2/2] 正在提取数据: ${REVENUE_REPORTS.SKU_REFUND_TREND.name}...`);
        const trendData = db.prepare(REVENUE_REPORTS.SKU_REFUND_TREND.sql).all();
        
        if (trendData && trendData.length > 0) {
            const trendPath = path.join(outputDir, `动销与退款趋势_${Date.now()}.xlsx`);
            await fileUtils.exportToExcel(trendData, trendPath);
        } else {
            console.log(`   ⚠️ 该报表提取数据为空，跳过导出。`);
        }
    } catch (e) {
        console.log(`   ❌ [跳过本报表] 动销与退款趋势执行失败！`);
        console.log(`   🚨 失败原因: ${e.message}`);
    }

    console.log("\n✅ 自动化复盘报表任务结束！请前往 output 目录查看已生成的报表。");
}

module.exports = { startApp };
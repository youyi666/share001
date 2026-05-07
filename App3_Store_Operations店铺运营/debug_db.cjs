// 诊断脚本 v2：直接按名称跨平台透视
const Database = require('better-sqlite3');
const path = require('path');

const DATABASE_PATH = path.join(__dirname, '..', '00_Shared_Database数据库', 'TmallDataCenter.db');

try {
    const db = new Database(DATABASE_PATH, { readonly: true, fileMustExist: true });

    // 1. 抓取刚才那个出问题的拼多多商品的名字
    const targetSku = '6120759451';
    const sample = db.prepare(`SELECT product_name FROM price_history WHERE sku_id = ? LIMIT 1`).get(targetSku);
    
    if (!sample) {
        console.log(`❌ 找不到 sku_id 为 ${targetSku} 的商品。`);
        process.exit(1);
    }

    console.log(`\n=============================================`);
    console.log(`🔍 [按图索骥] 正在跨平台追踪商品: 【${sample.product_name}】`);
    console.log(`=============================================`);

    // 2. 无视 sku_id，直接用名字查！把所有平台的底牌翻出来！
    const rows = db.prepare(`
        SELECT platform, sku_id, price, record_time 
        FROM price_history 
        WHERE product_name = ?
        ORDER BY platform ASC, record_time DESC
    `).all(sample.product_name);

    console.table(rows);
    
    // 3. 智能分析诊断
    const jdRecords = rows.filter(r => r.platform.includes('京东'));
    const pddRecords = rows.filter(r => r.platform.includes('拼多多'));
    
    console.log(`\n💡 诊断报告:`);
    if (jdRecords.length === 0) {
        console.log(`   ❌ 破案了！这个商品根本就没有【京东】的抓取记录！如果是这样，拼多多肯定找不到竞对基准。`);
    } else {
        const jdSkuId = jdRecords[0].sku_id;
        const pddSkuId = pddRecords[0].sku_id;
        if (jdSkuId !== pddSkuId) {
            console.log(`   ❌ 破案了！ID映射断裂！`);
            console.log(`      京东使用的 sku_id 是: [${jdSkuId}]`);
            console.log(`      拼多多使用的 sku_id 是: [${pddSkuId}]`);
            console.log(`      👉 解决方案：必须修改你的 App1 (抓取爬虫) 代码，强制让两边在入库时保存同一个 ID（建议统一为京东链接编码）。`);
        } else {
            console.log(`   ⚠️ ID 竟然是一致的！请检查京东价格是否低于100元，或者日期对不上。`);
        }
    }

    db.close();
} catch (error) {
    console.error("执行诊断脚本时发生崩溃:", error.message);
}
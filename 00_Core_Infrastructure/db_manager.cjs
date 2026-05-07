// core/db_manager.cjs
const Database = require('better-sqlite3');
const fs = require('fs');
const { DateTime } = require('luxon');

// ======================= [增量模块：配置探针与容错引入] =======================
const rawConfig = require('./env_config.cjs');
console.log(`🛠️ [底层基座调试] 成功引入 env_config.cjs，导出的对象类型: ${typeof rawConfig}`);
// 打印部分配置内容以防日志刷屏，仅看是否为空对象或包含嵌套
console.log(`🛠️ [底层基座调试] 配置快照:`, Object.keys(rawConfig).length === 0 ? "⚠️ 警告：获取到空对象 {}，可能存在循环依赖！" : rawConfig);

// 兼容处理：检查到底是直接导出了属性，还是嵌套在 ENV_CONFIG 里面
const DATABASE_PATH = rawConfig.DATABASE_PATH || (rawConfig.ENV_CONFIG ? rawConfig.ENV_CONFIG.DATABASE_PATH : undefined);

if (!DATABASE_PATH) {
    console.error(`🚨 [致命错误] 无法从 env_config 解析出 DATABASE_PATH，请检查导出语法！`);
    process.exit(1);
}
// ==============================================================================

// [全局配置] 静态指定数据库路径
let CENTRAL_DB_PATH;
let DB_PATH = DATABASE_PATH; 

// 初始化环境校验
try {
    console.log(`🔍 [日志] 正在校验数据库物理路径: ${DB_PATH}`);
    if (!fs.existsSync(DB_PATH)) {
        throw new Error(`寻址失败：静态指定的数据库路径不存在 -> ${DB_PATH}`);
    }
    CENTRAL_DB_PATH = new Database(DB_PATH);
    console.log(`✅ [DB基座就绪] 成功锁定底层公共数据库: ${DB_PATH}`);
} catch (error) {
    console.error(`🚨 [致命错误] 数据库环境初始化崩溃:`, error);
    process.exit(1);
}

// ==============================================================================
// 1. 获取已完成任务函数 (兼容旧有断点续传)
// ==============================================================================
function get_completed_skus_from_db(platformName) {
    const completed = new Set();
    try {
        if (!fs.existsSync(DB_PATH)) return completed;
        const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
        const today_str = DateTime.now().toFormat('yyyy-MM-dd');

        const stmt = db.prepare(`
            SELECT sku_id 
            FROM price_history 
            WHERE record_time LIKE ? 
              AND platform = ? 
              AND status NOT LIKE '%错误%' 
              AND status NOT LIKE '%失败%'
        `);
        const rows = stmt.all(`${today_str}%`, platformName);
        
        rows.forEach(row => {
            if (row.sku_id) completed.add(row.sku_id);
        });
        db.close();
        console.log(`   ✅ [DB校验] 从底层数据库确认今日已成功落库 ${completed.size} 个 ${platformName} 任务。`);
    } catch (e) {
        console.log(`   ⚠️ [DB校验] 数据库历史验证失败，将重新执行任务: ${e.message}`);
    }
    return completed;
}

// ==============================================================================
// 2. 原有标准查价写入函数 (保留以兼容旧平台脚本)
// ==============================================================================
function save_results_to_db(records) {
    if (!records || records.length === 0) return;
    console.log(`   💿 [DB同步] 正在将 ${records.length} 条数据同步至数据库(标准表)...`);
    
    try {
        const db = new Database(DB_PATH);
        
        const createTableStmt = `
            CREATE TABLE IF NOT EXISTS price_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                platform TEXT,
                url TEXT,
                product_name TEXT,
                sku_id TEXT,
                true_sku_id TEXT,
                platform_sku_id TEXT,
                sku_spec TEXT,
                group_price REAL,
                price REAL,
                limit_price REAL,
                status TEXT,
                record_time DATETIME,
                screenshot_path TEXT,
                sku_detailed_info TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(platform, sku_id, true_sku_id, platform_sku_id, record_time)
            )
        `;
        db.exec(createTableStmt);

        const insertStmt = db.prepare(`
            INSERT INTO price_history 
            (platform, url, product_name, sku_id, true_sku_id, platform_sku_id, sku_spec, group_price, price, limit_price, status, record_time, screenshot_path, sku_detailed_info)
            VALUES 
            (@Platform, @URL, @Product_Name, @SKU_Identifier, @True_SKU_Identifier, @Platform_SKU_ID, @Spec, @Group_Price, @Price, @Limit_Price, @Price_Status, @Scrape_Date, @Main_Image_URL, @SKU_Detailed_Info)
        `);

        const insertMany = db.transaction((data) => {
            for (const row of data) {
                let safePrice = null;
                if (typeof row.Price === 'number') {
                    safePrice = row.Price;
                } else if (typeof row.Price === 'string') {
                     const cleanPrice = row.Price.replace(/[^\d.]/g, '');
                     const p = parseFloat(cleanPrice);
                     if (!isNaN(p) && cleanPrice !== '') safePrice = p;
                }

                let safeLimit = null;
                if (row.Limit_Price) {
                    const cleanLimit = String(row.Limit_Price).replace(/[^\d.]/g, '');
                    const l = parseFloat(cleanLimit);
                    if(!isNaN(l)) safeLimit = l;
                }

                insertStmt.run({
                    Platform: row.Platform || '',
                    URL: row.URL || '',
                    Product_Name: row.Product_Name || '',
                    SKU_Identifier: row.SKU_Identifier || '',
                    True_SKU_Identifier: row.True_SKU_Identifier || '',
                    Platform_SKU_ID: row.Platform_SKU_ID || '', 
                    Spec: row.Spec || '',               
                    Group_Price: row.Group_Price || 0,  
                    Price: safePrice,                   
                    Limit_Price: safeLimit,
                    Price_Status: row.Price_Status || '',
                    Scrape_Date: row.Scrape_Date || '',
                    Main_Image_URL: row.Main_Image_URL || '',
                    SKU_Detailed_Info: row.SKU_Detailed_Info || ''
                });
            }
        });

        insertMany(records);
        console.log(`   ✅ [DB同步] 数据库同步完成。`);
        db.close();
    } catch (e) {
        console.error(`   ❌ [DB同步] 数据库写入失败: ${e.message}`);
    }
}

// ==============================================================================
// 3. 全维商品总表写入函数 (新架构专用)
// ==============================================================================
function save_master_results_to_db(records) {
    if (!records || records.length === 0) return;
    console.log(`   💿 [DB同步] 正在将 ${records.length} 条全维数据同步至总表...`);
    
    try {
        const db = new Database(DB_PATH);
        
        // 创建独立的全维总表 pdd_goods_master
        const createTableStmt = `
            CREATE TABLE IF NOT EXISTS pdd_goods_master (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                platform TEXT,
                store_name TEXT,
                goods_id TEXT,
                goods_name TEXT,
                out_goods_sn TEXT,
                cat_name TEXT,
                brand_name TEXT,
                sold_quantity INTEGER,
                sold_quantity_30d INTEGER,
                goods_is_onsale INTEGER,
                goods_created_at DATETIME,
                goods_updated_at DATETIME,
                activity_name TEXT,
                sku_id TEXT,
                sku_spec TEXT,
                out_sku_sn TEXT,
                sku_quantity INTEGER,
                sku_is_onsale INTEGER,
                normal_price REAL,
                group_price REAL,
                activity_price REAL,
                final_price REAL,
                thumb_url TEXT,
                scrape_time DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(platform, store_name, goods_id, sku_id, scrape_time)
            )
        `;
        db.exec(createTableStmt);

        // 预编译插入语句
        const insertStmt = db.prepare(`
            INSERT INTO pdd_goods_master 
            (platform, store_name, goods_id, goods_name, out_goods_sn, cat_name, brand_name, 
             sold_quantity, sold_quantity_30d, goods_is_onsale, goods_created_at, goods_updated_at, activity_name, 
             sku_id, sku_spec, out_sku_sn, sku_quantity, sku_is_onsale, 
             normal_price, group_price, activity_price, final_price, thumb_url, scrape_time)
            VALUES 
            (@Platform, @Store_Name, @Goods_ID, @Goods_Name, @Out_Goods_SN, @Cat_Name, @Brand_Name, 
             @Sold_Quantity, @Sold_Quantity_30d, @Goods_Is_Onsale, @Goods_Created_At, @Goods_Updated_At, @Activity_Name, 
             @SKU_ID, @SKU_Spec, @Out_SKU_SN, @SKU_Quantity, @SKU_Is_Onsale, 
             @Normal_Price, @Group_Price, @Activity_Price, @Final_Price, @Thumb_URL, @Scrape_Date)
        `);

        // 批量事务执行
        const insertMany = db.transaction((data) => {
            for (const row of data) {
                insertStmt.run({
                    Platform: row.Platform || '',
                    Store_Name: row.Store_Name || '',
                    Goods_ID: row.Goods_ID || '',
                    Goods_Name: row.Goods_Name || '',
                    Out_Goods_SN: row.Out_Goods_SN || '',
                    Cat_Name: row.Cat_Name || '',
                    Brand_Name: row.Brand_Name || '',
                    Sold_Quantity: row.Sold_Quantity || 0,
                    Sold_Quantity_30d: row.Sold_Quantity_30d || 0,
                    Goods_Is_Onsale: row.Goods_Is_Onsale || 0,
                    Goods_Created_At: row.Goods_Created_At || null,
                    Goods_Updated_At: row.Goods_Updated_At || null,
                    Activity_Name: row.Activity_Name || '',
                    SKU_ID: row.SKU_ID || '',
                    SKU_Spec: row.SKU_Spec || '',
                    Out_SKU_SN: row.Out_SKU_SN || '',
                    SKU_Quantity: row.SKU_Quantity || 0,
                    SKU_Is_Onsale: row.SKU_Is_Onsale || 0,
                    Normal_Price: row.Normal_Price || 0,
                    Group_Price: row.Group_Price || 0,
                    Activity_Price: row.Activity_Price || 0,
                    Final_Price: row.Final_Price || 0,
                    Thumb_URL: row.Thumb_URL || '',
                    Scrape_Date: row.Scrape_Date || ''
                });
            }
        });

        insertMany(records);
        console.log(`   ✅ [DB同步] 总表数据库写入成功。`);
        db.close();
    } catch (e) {
        console.error(`   ❌ [DB同步] 总表写入失败: ${e.message}`);
    }
}
// ==============================================================================
// 4. 自动化空间回收与老旧数据清理引擎
// ==============================================================================
/**
 * 清理指定天数之前的历史数据，并可选择释放物理硬盘空间
 * @param {number} retentionDays 保留天数 (默认保留 90 天 / 约三个月)
 * @param {boolean} doVacuum 是否执行物理空间回收 (建议每月手动或低频执行，因为耗时较长)
 */
function auto_clean_old_data(retentionDays = 90, doVacuum = false) {
    console.log(`\n🧹 [DB空间管理] 启动数据过期清理引擎... (保留期: 近 ${retentionDays} 天)`);
    
    try {
        const db = new Database(DB_PATH);
        
        // 计算临界时间点 (比如：90天前的此时此刻)
        const thresholdDate = DateTime.now().minus({ days: retentionDays }).toFormat('yyyy-MM-dd HH:mm:ss');
        console.log(`   ⏳ 临界时间线已划定: 将抹除 [${thresholdDate}] 之前的所有记录。`);

        // 1. 清理全维总表 (pdd_goods_master)
        try {
            const stmtMaster = db.prepare(`DELETE FROM pdd_goods_master WHERE scrape_time < ?`);
            const infoMaster = stmtMaster.run(thresholdDate);
            console.log(`   🗑️  [总表] 成功清空过期记录: ${infoMaster.changes} 条。`);
        } catch (e) {
            if (!e.message.includes('no such table')) console.log(`   ⚠️ [总表] 清理异常: ${e.message}`);
        }

        // 2. 清理旧版历史表 (price_history) - 兼容处理
        try {
            const stmtHistory = db.prepare(`DELETE FROM price_history WHERE record_time < ?`);
            const infoHistory = stmtHistory.run(thresholdDate);
            console.log(`   🗑️  [旧历史表] 成功清空过期记录: ${infoHistory.changes} 条。`);
        } catch (e) {
            if (!e.message.includes('no such table')) console.log(`   ⚠️ [旧历史表] 清理异常: ${e.message}`);
        }

        // 3. 物理释放硬盘空间 (数据库碎片整理)
        if (doVacuum) {
            console.log(`   🗜️  [物理瘦身] 正在执行 VACUUM 碎片整理，释放硬盘空间，请勿强制中断...`);
            db.exec('VACUUM;');
            console.log(`   ✅ [物理瘦身] 数据库文件体积已成功压缩！`);
        } else {
            console.log(`   ℹ️  [提示] 本次清理仅作逻辑删除，未执行物理瘦身(VACUUM)。`);
        }

        db.close();
        console.log(`🧹 [DB空间管理] 维护任务圆满结束。\n`);
    } catch (err) {
        console.error(`🚨 [DB空间管理] 致命错误: ${err.message}`);
    }
}

// ==============================================================================
// 导出模块接口 (确保所有需要的函数都暴露)
// ==============================================================================
module.exports = {
    get_completed_skus_from_db,
    save_results_to_db,         
    save_master_results_to_db,  
    auto_clean_old_data,        // 👈 新增：暴露自动清理引擎
    getRawDbInstance: () => CENTRAL_DB_PATH
};
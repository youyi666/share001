// App1_Price_Monitor品牌价格/main_controller.cjs
// 【架构升级】：接入中台基座、浏览器资源分配权上收、标准 App 局部总控暴露

const path = require('path');
const fs = require('fs');

// ======================= [中台基座接入] =======================
const fileUtils = require('../00_Core_Infrastructure/file_utils.cjs');
const dbManager = require('../00_Core_Infrastructure/db_manager.cjs');
const browserManager = require('../00_Core_Infrastructure/browser_manager.cjs');

// 👇 [增量模块] 引入全局环境变量配置文件与 SQLite 驱动
const { DATABASE_PATH } = require('../00_Core_Infrastructure/env_config.cjs');
const Database = require('better-sqlite3');

// 引入底层的纯粹业务抓取模块
const spiderJD = require('./platforms/spider_jd.cjs');
const spiderPDD = require('./platforms/spider_pdd.cjs');
// 👇 引入全新重命名的拼多多总表构建模块
const spiderPddMaster = require('./platforms/spider_pdd_master.cjs'); 
const spiderTaobao = require('./platforms/spider_taobao.cjs');
const spiderYoupin = require('./platforms/spider_youpin.cjs');

// ======================= [全局路径与常量配置] =======================
const BASE_DIR = __dirname;
const EXCEL_TASK_FILE_PATH = path.join(BASE_DIR, 'tasks.xlsx'); 
const CSV_OUTPUT_PATH = path.join(BASE_DIR, 'price_monitoring_results.csv');
const SCREENSHOT_DIR = path.join(BASE_DIR, 'price_screenshots');

if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// ======================= [全局运行策略配置] =======================
const RUN_CONFIG = {
    JD: true,
    PDD: true,
    TAOBAO: false, 
    YOUPIN: false  
};

// ======================= [多店矩阵配置中心] =======================
const STORE_CONFIGS = {
    // 京东单账号配置
    JD: { 
        storeName: '京东主干账号', 
        profileDir: path.join(BASE_DIR, '..', '00_Shared_Profiles', 'jd_main_store'), 
        envUserKey: 'JD_USER_MAIN',   
        envPassKey: 'JD_PASS_MAIN',
        defaultUser: '13226720449'   
    },
    // 淘系店铺配置（数组格式，支持多店）
    TAOBAO: [
        { 
            storeName: '淘宝主账号', 
            targetPlatform: '淘系', 
            profileDir: path.join(BASE_DIR, '..', '00_Shared_Profiles', 'taobao_main'),
            envUserKey: 'TB_USER_MAIN',   
            envPassKey: 'TB_PASS_MAIN',
            defaultUser: '13226720449'    
        }
    ],
  
    // 有品店铺配置
    YOUPIN: [
        { 
            storeName: '有品旗舰店', 
            targetPlatform: '米家有品', 
            profileDir: path.join(BASE_DIR, '..', '00_Shared_Profiles', 'youpin_main'),
            envUserKey: 'YP_USER_MAIN',
            envPassKey: 'YP_PASS_MAIN',
            defaultUser: '13226720449'
        }
    ],
    // 在 PDD 数组中加入 targetPlatform 映射
    PDD: [
        { 
            storeName: '云米拼多多官方旗舰店', 
            targetPlatform: '拼多多',  
            profileDir: path.join(BASE_DIR, '..', '00_Shared_Profiles', 'pdd_yunmi_official'),
            envUserKey: 'PDD_USER_YUNMI',
            envPassKey: 'PDD_PASS_YUNMI',
            defaultUser: '19928200415'
        },
        { 
            storeName: '云米拼多多专卖店_新店', 
            targetPlatform: '拼多多2', 
            profileDir: path.join(BASE_DIR, '..', '00_Shared_Profiles', 'pdd_yunmi_new'),
            envUserKey: 'PDD_USER_NEW_STORE',
            envPassKey: 'PDD_PASS_NEW_STORE',
            defaultUser: 'pdd60207941475'
        }
    ]
};

// ======================= [增量模块：数据库直连查询器 (better-sqlite3版)] =======================
/**
 * 从 TmallDataCenter.db 的 sales_history 表中抽取 JD 和 PDD 的任务
 * 过滤逻辑：
 * 1. 仅限最新日期 (record_date = MAX)
 * 2. 销售额必须 >= 100
 * 3. 必须包含有效 sku_id
 * 4. 【新增】仅限平台为京东或拼多多的数据
 */
async function fetchJdPddTasksFromDB() {
    console.log(`[DB] 正在连接本地中台数据库获取抓取任务... 地址: ${DATABASE_PATH}`);
    
    try {
        const db = new Database(DATABASE_PATH, { readonly: true, fileMustExist: true });

        // 👇 核心逻辑更新：SELECT 加入 platform，WHERE 加入平台过滤
        const query = `
            SELECT platform, sku_id, barcode, sales_amount 
            FROM sales_history 
            WHERE record_date = (SELECT MAX(record_date) FROM sales_history)
              AND sku_id IS NOT NULL 
              AND sku_id != ''
              AND sales_amount >= 100
              AND (platform LIKE '%京东%' OR platform LIKE '%拼多多%') 
        `;
        
        console.log(`[SQL] 执行筛选：最新日期 && 销售额 >= 100 && 平台包含京东/拼多多...`);
        const rows = db.prepare(query).all();
        db.close(); 

        if (rows.length === 0) {
            console.log("⚠️ [DB] 未找到符合条件（最新日期、高销售额、对应平台）的任务。");
            return [];
        }

        let parsedTasks = [];
        let jdCount = 0;
        let pddCount = 0;

        rows.forEach(row => {
            const safeBarcode = row.barcode || '无条码';
            const dbPlatform = row.platform || '';
            
            // 1. 如果数据库里这条记录是京东的，生成京东任务
            if (dbPlatform.includes('京东')) {
                parsedTasks.push({
                    platform: '京东',
                    barcode: safeBarcode,
                    sku_id: row.sku_id,
                    url: `https://item.jd.com/${row.sku_id}.html`,
                    sales_amount: row.sales_amount 
                });
                jdCount++;
            }

            // 2. 如果数据库里这条记录是拼多多的，或者你需要拿京东的 sku_id 去拼多多查价
            // (这里设定：只要是京东或拼多多的底库，都送去拼多多的两个店铺查价)
            parsedTasks.push({
                platform: '拼多多',
                barcode: safeBarcode,
                sku_id: row.sku_id,
                sales_amount: row.sales_amount
            });
            parsedTasks.push({
                platform: '拼多多2',
                barcode: safeBarcode,
                sku_id: row.sku_id,
                sales_amount: row.sales_amount
            });
            pddCount += 2;
        });
        
        console.log(`✅ [DB] 筛选完成！`);
        console.log(`📊 统计：从最新快照中提取了 ${rows.length} 个高价值 SKU。`);
        console.log(`   - 生成 京东 抓取任务: ${jdCount} 个`);
        console.log(`   - 生成 拼多多 抓取任务: ${pddCount} 个`);
        
        return parsedTasks;

    } catch (error) {
        console.error("❌ [DB] 任务提取失败，请检查数据库表结构或字段名:", error.message);
        return [];
    }
}

// ======================= [主控逻辑引擎] =======================
async function startApp() {
    console.log(`\n🚀 --- 分布式架构爬虫总控台启动 (App1: 日常价格监控) ---`);
    console.log(`🔧 当前运行模式: JD[${RUN_CONFIG.JD?'开':'关'}] | PDD[${RUN_CONFIG.PDD?'开':'关'}] | TB[${RUN_CONFIG.TAOBAO?'开':'关'}] | YP[${RUN_CONFIG.YOUPIN?'开':'关'}]`);
    
    fileUtils.initCsvFile(CSV_OUTPUT_PATH);
    
    // 👇 【架构升级 - 任务装载模块】整合双来源数据
    let allTasks = [];
    try {
        // [基座代码保留]: 淘系和有品仍然从 Excel 表格中获取
        const excelTasks = await fileUtils.readTasksFromExcel(EXCEL_TASK_FILE_PATH);
        const tbYpTasks = excelTasks.filter(t => ['淘系', '淘宝', '天猫', '有品', '米家有品'].includes(t.platform));
        allTasks = allTasks.concat(tbYpTasks);
        console.log(`📝 [Excel] 载入淘系/有品任务共计: ${tbYpTasks.length} 条`);

        // [增量模块注入]: 京东和拼多多改由数据库直连驱动
        if (RUN_CONFIG.JD || RUN_CONFIG.PDD) {
            const dbTasks = await fetchJdPddTasksFromDB();
            allTasks = allTasks.concat(dbTasks);
        }
    } catch (e) {
        console.error(`❌ [总控] 任务数据装载阶段发生崩溃:`, e.message);
    }

    if (allTasks.length === 0) {
        console.log("❌ 没有获取到有效任务，流程终止。");
        return;
    }

    let globalRecords = [];

    // ----------------------------------------------------
    // 执行京东模块
    // ----------------------------------------------------
    if (RUN_CONFIG.JD) {
        const jdTasks = allTasks.filter(t => t.platform === '京东');
        const completedSkus = dbManager.get_completed_skus_from_db("京东");
        const pendingJdTasks = jdTasks.filter(t => !completedSkus.has(t.barcode));
        
        if (pendingJdTasks.length > 0) {
            let context = null;
            try {
                // 【架构升级】统一向中台基座申请浏览器资源
                context = await browserManager.launchBrowser({ profileDir: STORE_CONFIGS.JD.profileDir, platform: 'jd' });
                const page = context.pages()[0] || await context.newPage();
                
                // 将拿到资源的 page 注入到底层蜘蛛模块
                const jdResults = await spiderJD.run(page, pendingJdTasks, STORE_CONFIGS.JD, SCREENSHOT_DIR);
                globalRecords = globalRecords.concat(jdResults);
            } catch (err) {
                console.error(`❌ [JD模块致命错误] 运行期间崩溃:`, err);
            } finally {
                if (context) await context.close();
            }
        } else {
            console.log(`🎉 [JD] 所有京东任务今日在数据库中已显示完成，跳过执行！`);
        }
    } else { 
        console.log(`⏭️  [跳过] 京东`);
    }

    // ----------------------------------------------------
    // 执行拼多多模块 (支持矩阵轮询与双管齐下策略)
    // ----------------------------------------------------
    if (RUN_CONFIG.PDD) {
        for (const storeConfig of STORE_CONFIGS.PDD) {
            console.log(`\n=============================================`);
            console.log(`🚀 [PDD矩阵调度] 当前接管店铺: ${storeConfig.storeName} (目标标签: ${storeConfig.targetPlatform})`);
            console.log(`=============================================`);
            
            const currentStoreTasks = allTasks.filter(t => t.platform === storeConfig.targetPlatform);
            if (currentStoreTasks.length > 0) {
                console.log(`   📥 成功分发 ${currentStoreTasks.length} 个任务至该店铺...`);
                let context = null;
                try {
                    // 【架构升级】按店铺加载隔离的浏览器缓存指纹
                    context = await browserManager.launchBrowser({ profileDir: storeConfig.profileDir });
                    const page = context.pages()[0] || await context.newPage();
                    
                    // 1. 先跑日常比价与数据审查
                    const pddResults = await spiderPDD.run(page, currentStoreTasks, storeConfig, SCREENSHOT_DIR);
                    globalRecords = globalRecords.concat(pddResults);

                    // 👇 2. 【新增串联】：紧接着复用当前鉴权状态，执行全维度总表底库更新
                    console.log(`\n   🔗 [流程串联] 日常查价结束，无缝启动全店商品总表 (Master Table) 刷新...`);
                    // 注意：这里不需要拿返回值，因为 spider_pdd_master.cjs 内部会自己把数据写入总表数据库
                    await spiderPddMaster.run(page, currentStoreTasks, storeConfig, SCREENSHOT_DIR);
                } catch (err) {
                    console.error(`❌ [PDD模块致命错误] ${storeConfig.storeName} 运行崩溃:`, err);
                } finally {
                    if (context) await context.close();
                }
            } else {
                console.log(`   ⏭️ 数据库/Excel 中暂无属于 [${storeConfig.targetPlatform}] 的任务，跳过该店。`);
            }
        }
    } else { 
        console.log(`⏭️  [跳过] 拼多多`);
    }

    // ----------------------------------------------------
    // 执行淘系模块 (支持矩阵轮询)
    // ----------------------------------------------------
    if (RUN_CONFIG.TAOBAO) {
        const tbTasks = allTasks.filter(t => ['淘系', '淘宝', '天猫'].includes(t.platform));
        if (tbTasks.length > 0) {
            for (const storeConfig of STORE_CONFIGS.TAOBAO) {
                console.log(`\n=============================================`);
                console.log(`🚀 [淘系调度] 当前接管店铺: ${storeConfig.storeName}`);
                console.log(`=============================================`);
                
                let context = null;
                try {
                    context = await browserManager.launchBrowser({ profileDir: storeConfig.profileDir });
                    const page = context.pages()[0] || await context.newPage();
                    const tbResults = await spiderTaobao.run(page, tbTasks, storeConfig, SCREENSHOT_DIR);
                    globalRecords = globalRecords.concat(tbResults);
                } catch (err) {
                    console.error(`❌ [淘宝模块致命错误] ${storeConfig.storeName} 运行崩溃:`, err);
                } finally {
                    if (context) await context.close();
                }
            }
        }
    } else { 
        console.log(`⏭️  [跳过] 淘系`);
    }

    // ----------------------------------------------------
    // 执行有品模块 (支持矩阵轮询)
    // ----------------------------------------------------
    if (RUN_CONFIG.YOUPIN) {
        const ypTasks = allTasks.filter(t => ['有品', '米家有品'].includes(t.platform));
        if (ypTasks.length > 0) {
            for (const storeConfig of STORE_CONFIGS.YOUPIN) {
                console.log(`\n=============================================`);
                console.log(`🚀 [有品调度] 当前接管店铺: ${storeConfig.storeName}`);
                console.log(`=============================================`);
                
                let context = null;
                try {
                    context = await browserManager.launchBrowser({ profileDir: storeConfig.profileDir });
                    const page = context.pages()[0] || await context.newPage();
                    const ypResults = await spiderYoupin.run(page, ypTasks, storeConfig, SCREENSHOT_DIR);
                    globalRecords = globalRecords.concat(ypResults);
                } catch (err) {
                    console.error(`❌ [有品模块致命错误] ${storeConfig.storeName} 运行崩溃:`, err);
                } finally {
                    if (context) await context.close();
                }
            }
        }
    } else { 
        console.log(`⏭️  [跳过] 有品`);
    }

    // ----------------------------------------------------
    // 全局数据落盘与空间清理
    // ----------------------------------------------------
    console.log(`\n⏳ 所有开启的抓取任务结束，执行全局结果聚合...`);
    if (globalRecords.length > 0) {
        fileUtils.appendResultsToCsv(CSV_OUTPUT_PATH, globalRecords);
    }
    
    // 1. 清理本地陈旧的截图文件 (保留 30 天)
    fileUtils.cleanOldScreenshots(SCREENSHOT_DIR, 30);
    // 2. 【新增加入】清理数据库陈旧的记录 (保留 90 天，false 代表日常运行不执行耗时的压缩瘦身)
    dbManager.auto_clean_old_data(90, false);

    console.log(`\n🎉 --- App1: 日常价格监控 执行完毕 ---`);
}

// 暴露出局部总控接口，供 Global_Runner 调用
module.exports = { startApp };
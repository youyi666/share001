const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');

chromium.use(stealth);

(async () => {
    // 假设这是从你们的 ERP 或 Excel 里导出的待查单号列表
    const waybillsToTrack = [
        'JDAP02888263048', 
        // 'JDAP00000000001', // 演示用的假单号
        // ... 可以在这里添加更多单号
    ];
    
    const userDataDir = './jd_mrd_browser_data'; 

    console.log(`[系统日志] 初始化浏览器...`);
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false, // 调试时建议开启
        args: ['--disable-blink-features=AutomationControlled'] 
    });

    const page = await context.newPage();

    try {
        console.log(`[系统日志] 正在访问京东物流 MRD 极简查询页...`);
        await page.goto('https://logistics-mrd.jd.com/express/query.html', { waitUntil: 'networkidle' });

        const inputSelector = 'input[type="text"], input'; 
        await page.waitForSelector(inputSelector, { state: 'visible', timeout: 10000 });

        // 开始批量循环处理单号
        for (const waybillNumber of waybillsToTrack) {
            console.log(`\n================ 开始查询单号: ${waybillNumber} ================`);
            try {
                const inputLocator = page.locator(inputSelector).first();
                
                // 1. 清空输入框并填入单号
                await inputLocator.clear();
                await inputLocator.fill(waybillNumber);
                
                // 2. 主动触发底层数据绑定事件 (防丢字)
                await page.evaluate((selector) => {
                    const el = document.querySelector(selector);
                    if(el) {
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }, inputSelector);

                // 3. 核心修改：模拟在输入框内按下回车键 (Enter)
                console.log(`[系统日志] 单号已输入，敲击回车键触发查询...`);
                await inputLocator.press('Enter');

                // 4. 等待页面网络请求完成或 DOM 刷新 (给足 3 秒缓冲)
                await page.waitForTimeout(3000); 

                // 5. 提取并清洗页面完整文本结果 (本次迭代升级：结构化解析与持久化)
                const resultText = await page.evaluate(() => document.body.innerText);

                if (resultText && (resultText.includes('揽收') || resultText.includes('派送') || resultText.includes('妥投') || resultText.includes('运单'))) {
                    console.log(`[系统日志] 抓取成功！正在进行数据结构化解析...`);
                    
                    const cleanLines = resultText.split('\n')
                        .map(line => line.trim())
                        .filter(line => line.length > 0 && !line.includes('©2026 Tencent') && !line.includes('GS(2026)'));
                    
                    const currentYear = new Date().getFullYear(); // 自动获取当前年份
                    const trackData = [];
                    let collectTime = "尚未揽收"; // 初始化揽收时间

                    // 按 3 行一组进行步进解析：[描述, 日期, 时间]
                    for (let i = 0; i < cleanLines.length; i += 3) {
                        // 容错处理：确保不越界
                        if (i + 2 < cleanLines.length) {
                            const desc = cleanLines[i];
                            const dateStr = cleanLines[i + 1]; // 例: "03-24"
                            const timeStr = cleanLines[i + 2]; // 例: "16:22"
                            
                            // 组装标准时间格式: YYYY-MM-DD HH:mm:00
                            const standardTime = `${currentYear}-${dateStr.replace('/', '-')} ${timeStr}:00`;
                            
                            trackData.push({
                                time: standardTime,
                                desc: desc
                            });

                            // 提取揽收时间：匹配京东物流的特征关键字
                            if (desc.includes('已收取快件') || desc.includes('揽收')) {
                                collectTime = standardTime;
                            }
                        }
                    }

                    console.log(`--------------------------------------------------`);
                    console.log(`提取揽收时间: ${collectTime}`);
                    console.log(`最新流转状态: ${trackData[0]?.desc || '无'}`);
                    console.log(`--------------------------------------------------`);

                    // ================= 数据持久化保存 =================
                    
                    // 1. 保存为 CSV 时效报表 (方便后续计算承诺发货时效)
                    const csvFilePath = './sla_report.csv';
                    // 如果文件不存在，先写入表头
                    if (!fs.existsSync(csvFilePath)) {
                        fs.writeFileSync(csvFilePath, '\uFEFF运单号,揽收时间,最新状态更新时间,最新状态\n', 'utf8'); // \uFEFF 防止 Excel 乱码
                    }
                    // 追加写入单条记录
                    const csvRow = `${waybillNumber},${collectTime},${trackData[0]?.time || ''},"${trackData[0]?.desc || ''}"\n`;
                    fs.appendFileSync(csvFilePath, csvRow, 'utf8');
                    
                    // 2. 保存为 JSON 全量日志 (防备查，保存完整轨迹)
                    const jsonFilePath = './track_details.json';
                    let allTracks = {};
                    if (fs.existsSync(jsonFilePath)) {
                        allTracks = JSON.parse(fs.readFileSync(jsonFilePath, 'utf8'));
                    }
                    allTracks[waybillNumber] = {
                        updateAt: new Date().toLocaleString(),
                        collectTime: collectTime,
                        history: trackData // 完整的结构化数组
                    };
                    fs.writeFileSync(jsonFilePath, JSON.stringify(allTracks, null, 2), 'utf8');

                    console.log(`[系统日志] 单号 ${waybillNumber} 轨迹已成功存入 CSV 报表与 JSON 数据库。\n`);
                } else {
                    console.log(`[系统警告] 未能匹配到物流关键字，可能是空单号或查无此单。`);
                }

            } catch (innerError) {
                // 单个订单出错，不影响全局循环
                console.error(`[系统异常] 抓取单号 ${waybillNumber} 时发生错误:`, innerError.message);
                if (!fs.existsSync('./error_shots')) fs.mkdirSync('./error_shots');
                const errorImgPath = `./error_shots/mrd_error_${waybillNumber}_${Date.now()}.png`;
                await page.screenshot({ path: errorImgPath, fullPage: true });
                console.log(`[系统日志] 现场已保留至: ${errorImgPath}`);
            }
            
            // 每次查完稍微停顿一下，防止操作过快被封 IP
            await page.waitForTimeout(1500); 
        }

    } catch (error) {
        console.error(`[系统崩溃] 脚本运行发生致命错误:`, error.message);
    } finally {
        console.log(`\n[系统日志] 所有单号处理完毕，结束任务。`);
        // 调试阶段可以先不关闭浏览器
        // await page.close();
        // await context.close();
    }
})();
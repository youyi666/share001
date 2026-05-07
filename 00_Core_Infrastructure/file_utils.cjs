// core/file_utils.cjs
const fs = require('fs');
const path = require('path');
const exceljs = require('exceljs');
const xlsx = require('xlsx');
/**
 * 统一解析 Excel 任务清单
 * 返回格式化的任务数组供各平台调用
 */



async function readTasksFromExcel(filePath) {
    const tasks = [];
    if (!fs.existsSync(filePath)) {
        console.error(`❌ [File] 未找到任务文件: ${filePath}`);
        return tasks;
    }

    const workbook = new exceljs.Workbook();
    await workbook.xlsx.readFile(filePath);
    const worksheet = workbook.worksheets[0]; 
    
    let switchColIndex = -1;
    worksheet.getRow(1).eachCell((cell, colNumber) => {
        if (cell.text && cell.text.trim() === '[T]') switchColIndex = colNumber;
    });

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return; // 跳过表头
        if (switchColIndex !== -1 && row.getCell(switchColIndex).value != 1) return; // 过滤未开启的任务

        const platform = row.getCell(1).text ? row.getCell(1).text.trim() : '';
        const barcode = row.getCell(2).text ? row.getCell(2).text.trim() : 'N/A';
        const productName = row.getCell(3).text ? row.getCell(3).text.trim() : 'N/A';
        const urlCellValue = row.getCell(4).value;
        const limitPriceRaw = row.getCell(7).value;
        
        let finalUrl = (typeof urlCellValue === 'object' && urlCellValue?.hyperlink) ? urlCellValue.hyperlink : urlCellValue;
        if (finalUrl && /^\d+$/.test(String(finalUrl).trim()) && platform === '京东') {
            finalUrl = `https://item.jd.com/${String(finalUrl).trim()}.html`; // JD 纯数字ID转链接
        }

        let trueId = "N/A";
        if (typeof finalUrl === 'string') {
            const match1 = finalUrl.match(/\/(\d+)\.html/);
            const match2 = finalUrl.match(/[?&](?:id|sku|goods_id)=(\d+)/);
            if (match1) trueId = match1[1];
            else if (match2) trueId = match2[1];
        }

        let limitPrice = null;
        if (limitPriceRaw) {
            const cleanStr = String(limitPriceRaw).replace(/[^\d.]/g, '');
            const val = parseFloat(cleanStr);
            if (!isNaN(val)) limitPrice = val;
        }

        tasks.push({ platform, barcode, productName, url: finalUrl, trueId, limitPrice });
    });

    console.log(`[File] Excel 中共读取到 ${tasks.length} 个激活状态的任务。`);
    return tasks;
}

/** 初始化 CSV 表头 */
function initCsvFile(csvPath) {
    if (!fs.existsSync(csvPath)) {
        const header = "\uFEFFPlatform,URL,Product_Name,SKU_Identifier,True_SKU_Identifier,Price,Limit_Price,Price_Status,Scrape_Date,Main_Image_URL\n";
        fs.writeFileSync(csvPath, header, 'utf8');
        console.log(`🆕 已创建新的结果文件: ${csvPath}`);
    }
}

/** 追加记录到 CSV */
function appendResultsToCsv(csvPath, records) {
    if (!records || records.length === 0) return;
    let csvContent = "";
    records.forEach(r => {
        const escapeCsv = (field) => {
            if (field === null || field === undefined) return "";
            const str = String(field).replace(/"/g, '""');
            if (str.search(/("|,|\n|\r)/g) >= 0) return `"${str}"`;
            return str;
        };

        const line = [
            escapeCsv(r.Platform), escapeCsv(r.URL), escapeCsv(r.Product_Name), 
            escapeCsv(r.SKU_Identifier), escapeCsv(r.True_SKU_Identifier), 
            escapeCsv(r.Price), escapeCsv(r.Limit_Price), escapeCsv(r.Price_Status), 
            escapeCsv(r.Scrape_Date), escapeCsv(r.Main_Image_URL)
        ].join(",");
        csvContent += line + "\n";
    });

    try {
        fs.appendFileSync(csvPath, csvContent, 'utf8');
        console.log(`   💾 CSV保存成功: 追加了 ${records.length} 条记录。`);
    } catch (e) { console.error(`   ❌ CSV写入失败: ${e.message}`); }
}

/** 清理过期截图 */
function cleanOldScreenshots(screenshotDir, days = 30) {
    console.log(`🧹 [空间运维] 启动历史截图清理策略 (保留最近 ${days} 天)...`);
    try {
        if (!fs.existsSync(screenshotDir)) return;
        const files = fs.readdirSync(screenshotDir);
        const now = Date.now();
        let deletedCount = 0;

        files.forEach(file => {
            if (!file.endsWith('.jpg') && !file.endsWith('.png') && !file.endsWith('.jpeg')) return;
            const filePath = path.join(screenshotDir, file);
            const stats = fs.statSync(filePath);
            if ((now - stats.mtimeMs) / (24 * 60 * 60 * 1000) > days) {
                fs.unlinkSync(filePath);
                deletedCount++;
            }
        });
        console.log(`   ✅ 清理完毕：共移除了 ${deletedCount} 张过期截图。`);
    } catch (e) { console.error(`   ❌ 清理截图失败: ${e.message}`); }
}
async function exportToExcel(dataArray, filePath) {
    if (!dataArray || dataArray.length === 0) return false;
    
    // 将 SQL 查询返回的 JSON 数组转为工作表
    const worksheet = xlsx.utils.json_to_sheet(dataArray);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, "报表数据");
    
    xlsx.writeFile(workbook, filePath);
    console.log(`✅ 报表已成功导出至: ${filePath}`);
    return true;
}
module.exports = { exportToExcel,readTasksFromExcel, initCsvFile, appendResultsToCsv, cleanOldScreenshots };
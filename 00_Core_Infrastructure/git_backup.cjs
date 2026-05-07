const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const archiver = require('archiver');
const ENV_CONFIG = require('./env_config.cjs');

// 配置
const DB_PATH = ENV_CONFIG.DATABASE_PATH; // 数据库物理路径 
const ROOT_DIR = ENV_CONFIG.ROOT;
// 项目根目录
const BACKUP_NAME = 'TmallDataCenter_Latest.zip'; // 固定文件名，方便 Git 替换
const BACKUP_PATH = path.join(ROOT_DIR, BACKUP_NAME);

// =========================================================================
// 【增量模块】：全局日志记录系统
// 功能：拦截并重写原生 console，将输出双写到项目目录的 log 文件中
// =========================================================================
const util = require('util');
const LOG_FILE_PATH = path.join(ROOT_DIR, 'git_backup_auto.log');

// 缓存原生的输出方法
const originalLog = console.log;
const originalError = console.error;

// 格式化并写入文件的容错函数
function writeLogToFile(level, message, ...args) {
    try {
        const timestamp = new Date().toLocaleString('zh-CN', { hour12: false });
        // 处理可能存在的对象格式化输出
        const formattedMessage = args.length > 0 ? util.format(message, ...args) : message;
        const logContent = `[${timestamp}] [${level}] ${formattedMessage}\n`;
        
        fs.appendFileSync(LOG_FILE_PATH, logContent);
    } catch (e) {
        // 防止日志模块自身由于权限问题报错，从而引发主程序崩溃
        originalError(`[日志系统异常] 无法写入日志文件: ${e.message}`);
    }
}

// 代理 console.log
console.log = function(message, ...args) {
    writeLogToFile('INFO', message, ...args);
    originalLog.apply(console, [message, ...args]); // 保持原有的控制台显示
};

// 代理 console.error
console.error = function(message, ...args) {
    writeLogToFile('ERROR', message, ...args);
    originalError.apply(console, [message, ...args]); // 保持原有的控制台显示
};
// =========================================================================


// =========================================================================
// 【基座代码】：原有业务逻辑，结构与执行顺序绝对保持不变
// =========================================================================
async function runBackup() {
    console.log('📦 开始执行数据库本地备份...');

    try {
        // 1. 压缩数据库 (200MB -> 20MB)
        await new Promise((resolve, reject) => {
            const output = fs.createWriteStream(BACKUP_PATH);
            const archive = archiver('zip', { zlib: { level: 9 } });
            output.on('close', resolve);
            archive.on('error', reject);
 
            archive.pipe(output);
            // 使用流式读取，避免数据库锁定冲突
            archive.file(DB_PATH, { name: 'TmallDataCenter.db' });
            archive.finalize();
        });
        console.log(`✅ 压缩完成: ${BACKUP_NAME}`);

        // 2. 执行 Git 操作
        console.log('🚀 正在推送至 GitHub...');
        // 切换到根目录执行指令
        const gitOptions = { cwd: ROOT_DIR, stdio: 'inherit' };
        execSync(`git add "${BACKUP_NAME}"`, gitOptions);
        
        // 检查是否有变化，防止无意义提交报错
        const status = execSync('git status --porcelain', { cwd: ROOT_DIR }).toString();
        if (status.includes(BACKUP_NAME)) {
            const timestamp = new Date().toLocaleString();
            execSync(`git commit -m "Auto DB Backup: ${timestamp}"`, gitOptions);
            execSync('git push', gitOptions);
            console.log('🎉 GitHub 同步成功！');
        } else {
            console.log('ℹ️ 数据库无变化，跳过本次提交。');
        }

    } catch (error) {
        console.error('❌ 备份失败:', error.message);
    }
}

runBackup();
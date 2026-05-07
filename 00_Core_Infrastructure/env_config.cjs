// 00_Core_Infrastructure/env_config.cjs
const path = require('path');

// 💡 核心逻辑：基于当前文件位置，向上回溯一级找到项目根目录
// 因为本文件在 /00_Core_Infrastructure/ 目录下，所以 .. 就是根
const ROOT_DIR = path.resolve(__dirname, '..');

const ENV_CONFIG = {
    // 基础根路径
    ROOT: ROOT_DIR,

    // 共享资源目录（动态拼接）
    DATABASE_PATH: path.join(ROOT_DIR, '00_Shared_Database数据库', 'TmallDataCenter.db'),
    PROFILES_DIR: path.join(ROOT_DIR, '00_Shared_Profiles'),
    DOWNLOADS_DIR: path.join(ROOT_DIR, '00_Shared_Downloads'),
    
    // 业务插件目录
    APP_DIR: {
        PRICE_MONITOR: path.join(ROOT_DIR, 'App1_Price_Monitor品牌价格'),
        MARKET_RADAR: path.join(ROOT_DIR, 'App2_Market_Radar市场价格'),
        STORE_OPS: path.join(ROOT_DIR, 'App3_Store_Operations店铺运营'),
    }
};

module.exports = ENV_CONFIG;
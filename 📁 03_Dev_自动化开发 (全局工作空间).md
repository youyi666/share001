📁 03_Dev_自动化开发 (全局工作空间)
│
├── 📁 00_Shared_Database        (全局数据中心)
│   └── 📄 TmallDataCenter.db    # 所有业务的数据都汇聚于此
│
├── 📁 00_Shared_Profiles        (全局身份中心)
│   ├── 📁 pdd_yunmi_official    # 官方旗舰店浏览器指纹 (各路脚本共享免密)
│   └── 📁 pdd_yunmi_new         # 专卖店指纹
│
├── 📁 00_Core_Infrastructure    (全局公共基座 / 中台)
│   ├── 📄 browser_manager.cjs   # 统一浏览器启动、防爬伪装、智能鉴权、下载劫持
│   ├── 📄 db_manager.cjs        # 统一的 SQLite 连接池与建表语句分发
│   └── 📄 file_utils.cjs        # 统一的 ZIP 解压、Excel 读写、历史截屏清理
│
├── 📁 App1_Price_Monitor        (业务线一：日常价格监控)
│   ├── 📄 main_controller.cjs   
│   └── 📁 platforms/ (JD/PDD/TB/YP)
│
├── 📁 App2_Market_Radar         (业务线二：市场竞品销量大盘)
│   └── 📄 pddprice-scraper.cjs  # 清洗热卖指数、自动提取销量增量
│
├── 📁 App3_Store_Operations     (业务线三：店铺运营与财务中枢)
│   ├── 📄 00-Master_Runner.cjs  # 👈 串联以下所有模块的总控调度器
│   ├── 📄 01-Unified_Task.cjs   # 订单与推广报表抓取
│   ├── 📄 02-Finance_Sync.cjs   # 多账户流水对账
│   ├── 📄 03-Expense_Sync.cjs   # 营销结算明细
│   └── 📄 04-Price_Guard.cjs    # 智能调价卫兵
├── 📁 App4_Viomi超管系统
│   ├── 📄 03-Inventory_Risk_Analyzer.js
│   ├── 📄 03-Viomi_ZongHe_Sales_Downloader.js
│   ├── 📄 04-Viomi_PDD_Sales_Fixer.js
│   ├── 📄 05-Viomi_DBS_Ultimate_Consumables.js
│   ├── 📄 06-Viomi_Ultimate_Integration.js
└── 📁 App5_Wuliu物流轨迹
    └── 📄 jdwuliu.cjs
# daed-board

仿 [zashboard](https://github.com/Zephyruso/zashboard) 风格的 **daed**（[dae](https://github.com/daeuniverse/dae) 管理面板）Web 仪表盘。

纯原生 HTML/JS/CSS，**零依赖、零构建**，单页应用直接跑在路由器 uhttpd 上，手机/电脑浏览器均可使用。

> 适用于 OpenWrt / ImmortalWrt 系固件（需内核支持 eBPF，建议较新内核）。已在 qualcommax/ipq60xx + 内核 6.12 环境长期验证。

## 功能

- **代理**：分组卡片 + 全量节点池（显式成员 + 订阅匹配成员自动合并）、按区域分区（香港/台湾/日本/新加坡/美国/其他，可扩展）、延迟色阶 DOTS 预览、单节点/区域/整组测速
- **选点策略切换**：random / fixed / min / min_avg10 / min_moving_avg 下拉直切（fixed 需单节点组，多节点组会被 daed 拒绝并自动回退原策略）
- **📌 钉选节点**：把组收缩为仅一个节点并设为 fixed；fixed 组可用「✎ 换节点」从全部节点中挑选（按延迟排序）
- **区域托管**：点区域 chip 把组临时收缩为该区域节点，托管区域全失效时自动切换到最优存活区域
- **实际出口（真值）**：解析 daed 连接日志，展示每条连接/每个分组**实际走了哪个节点**——这是 daed 官方面板缺失的关键信息
- **概览**：实时速率图、活动连接/UDP 会话、**路由器内存可用 + 7 天趋势曲线**（观察内存泄漏）、分组实际出口
- **出口记录**：连接级日志表（时间/设备/目标/嗅探域名/出站/实际节点/MAC），可筛选、点击复制原始行；**增量读取**——客户端持游标 (inode, 字节偏移)，稳态每次只回新增几百字节（基线是每次全量 165KB）
- **节点订阅管理**：订阅导入/立即更新/编辑(cron)/删除；节点批量导入（分享链接粘贴）、多选删除、批量测速
- **配置编辑**：路由/DNS 多版本文本编辑器（**保存前 daed 服务端解析校验**）+ 全局配置 33 字段动态表单 + 应用(run) 与 modified 状态
- **场景预设**：内置「日常模式 / 全局自动 / 诊断模式 / 恢复安静」一键切换；可把当前状态保存为自定义预设（跨设备）
- **LuCI 集成**：OpenWrt 侧边栏「服务 → Daed 仪表盘」入口（iframe 内嵌）

## 安全设计（针对破坏性操作）

- 区域托管 / 钉选节点：**自动快照**原成员与原策略，存 daed jsonStorage（跨设备），一键还原；订阅更新"删旧建新"重建节点 id 后，按**节点名称**自动重映射并补齐组员
  - 性能取舍：跨设备同步只在**面板启动时**做一次（此后审计读浏览器本地快照、且只在快照真的变化时才写回），所以**别的设备刚改的托管状态要等本设备刷新页面才可见**；换来的是不再每 30 秒读+写一份 ~47KB 的快照
- 路由/DNS 编辑：保存前强制 **daed 服务端解析校验**；移除关键规则（如 DNS 命脉 `must_direct`、关键上游）时**强制二次确认**
- 所有写操作均有确认弹窗；`run` 重载会瞬断代理连接 1-2 秒，UI 明示
- 建议同时保留 daed 官方面板链接作为应急备份

## 部署

需求：OpenWrt 路由器（已运行 daed）、Python 3 + paramiko（部署机）、路由器开启 SSH。

```bash
pip install paramiko
python deploy.py --host 192.168.1.1        # 密码交互输入，或用环境变量 DAED_SSH_PASS
```

部署内容：

```
/www/daed-board/{index.html,app.js,style.css}   面板本体（uhttpd 静态托管）
/www/cgi-bin/daed-board-log                      日志 tail CGI（出口记录/内存数据源）
/usr/share/luci/menu.d/luci-app-daed-board.json  LuCI 菜单入口
/www/luci-static/resources/view/daed-board.js    LuCI 视图（iframe 内嵌面板）
```

访问 `http://<路由器IP>/daed-board/`，首次登录填写 daed 后端地址（如 `http://192.168.1.1:2023`）与 daed 面板账号。

重复执行 `deploy.py` 即可升级（自动带防缓存版本号）；LuCI 入口修改后脚本会自动重启 uhttpd 并清理缓存。

## 数据来源说明

- 面板通过 daed 的 GraphQL API 读写（CORS 全开放，无需反代）
- 「实际出口/出口记录」来自 daed 连接日志（需日志级别 ≥ info）：`dialer=` 字段是每条连接真实选点的**真值**；仅代理出站流量有日志（直连/拦截不记录，dae 行为）
- 日志增量协议（`cgi/daed-board-log`，**服务端无状态**）：请求 `?inode=<ino>&off=<bytes>[&reset=1]`，响应控制段 `#MEM` / `#GUARD` / `#META inode= size= off= reset=`，其后是原始日志切片。首次、参数非法、日志轮换（inode 变）或落后 >128KB 时 `reset=1` 并回填最近 400 行；只回传完整行的裁剪由前端完成（按最后一个换行截断、余数留给下次读）。游标只存浏览器内存，所以多标签页互不干扰，重开页面走一次回填
- 「预计出口」是面板按自采样延迟均值对 **min_avg10** 的近似，非 dae 内部精确值；卡片会同时显示该组**当前实际策略**，若当前是 min_moving_avg 则该值仅供参考（真值始终看日志 `dialer=`）
- 内存数据由 CGI 附带 `/proc/meminfo` 的 MemAvailable，每 30 分钟采样存浏览器本地（保留 8 天）

## 常见问题

- **订阅更新 403**：多数机场要求先在**服务商后台开启订阅开关**；面板会原样透传 daed 的报错
- **无法把多节点组切成 fixed**：dae 强制 fixed 组只能有 1 个节点；用「📌 钉选节点」等价实现（组收缩为单节点 + fixed）
- **订阅更新后组员变化**：daed 订阅对账是"删旧建新"式重建节点 id——面板按节点名称自动重映射并补齐托管成员
- **日志级别**：连接日志需要 info 及以上级别；日志由 daed 内置轮换（如 2MB×1 备份）封顶，不会吃满 tmpfs

## 目录结构

```
index.html / app.js / style.css   面板本体（原生 JS，hash 路由，无框架）
cgi/daed-board-log                uhttpd CGI：daed 日志增量切片（游标协议）+ 附带内存信息
luci/                             LuCI 菜单与视图（iframe 入口）
deploy.py                         一键部署/升级脚本
tools/                            本地调试小工具（不参与部署，需自行配置地址与密码后使用）
```

## 许可

MIT

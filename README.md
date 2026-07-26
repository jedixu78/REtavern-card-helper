# REtavern-card-helper

一个为 [SillyTavern](https://github.com/SillyTavern/SillyTavern) 设计的角色卡辅助制作工具。通过可视化向导与 AI 辅助，把原本需要手动拼写 JSON / YAML 的工作，变成一步一步填表、一键导出的流程。

## 在线体验

https://tavern-card-helper.tavern-helper.workers.dev

## 主要功能

- **角色卡创建向导**：分步骤完成角色设定、世界书、开场白、MVU 变量等核心内容，降低写卡门槛。
- **MVU 状态栏系统**：可视化配置角色状态变量，自动生成 SillyTavern 可用的状态栏 HTML，支持正数、负数、双向进度条。
- **分阶段世界书**：内置多种分阶段模板（甜宠纯爱、虐恋 NTR、修仙境界、主线推进、案件调查等，覆盖恋爱 / 成长 / 冒险 / 黑化 / 悬疑五大类），按剧情或情感进度自动切换不同阶段的世界书条目。
- **AI 辅助优化**：对角色卡字段调用 AI 进行优化，并提供 diff 对比与选择性应用，改哪条由你决定。
- **质量检查评分**：从清晰度、一致性、token 效率等维度自动评估角色卡质量，给出可操作的改进建议。
- **多角色支持**：一张卡片里可以配置多名角色，各自拥有独立的状态变量与阶段世界书。
- **世界书编辑器**：支持「紧凑 / 预览 / 编辑」三种视图，在信息密度与可操作性之间自由切换。
- **状态栏模板**：内置多种风格模板（紧凑面板、极简暗色、毛玻璃、游戏 HUD、二次元卡片、古风卷轴、终端风格等）。
- **响应式界面**：针对桌面与移动设备做了深度适配。
- **一键导出**：生成符合 SillyTavern 格式的角色卡 PNG / JSON 文件。

## 快速开始

```bash
# 安装依赖
npm install

# 本地开发（支持热更新）
npm run dev

# 类型检查
npm run typecheck

# 生产构建
npm run build
```

## 技术栈

- React + TypeScript
- Vite
- Tailwind CSS
- Cloudflare Workers（AI 代理部署）

## 开源协议

本项目采用 [GPL-3.0](LICENSE) 协议开源。

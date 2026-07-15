# 天眼查企业合作风险评分 Demo

输入企业简称或全称后，从天眼查数据中选择精确主体，并按 100 分制输出企业合作风险。当前规则版本为 v2.1，采用“基础权重 + 严重事件额外扣分/总分封顶”。

## 主要能力

- 企业简称模糊搜索和候选企业下拉选择
- 社保人数、成立年限、实缴比例、地址特征、法人关联企业评分
- 被执行人、失信、限高、股权冻结、开庭公告、裁判文书评分
- 行政处罚、经营异常、严重违法、欠税、破产和注销风险评分
- 低于 70 分黄色预警；严重事件可将总分封顶至 59、49 或 39 分
- 每条规则展示权重、扣分原因和原始历史证据
- 一键跳转天眼查企业原始页面

## 本地运行

要求 Node.js 18+，并已安装、初始化 `tyc-cli`。

```bash
npm install -g tyc-cli
tyc init --authorization "你的天眼查 API Key"
npm start
```

打开 `http://127.0.0.1:4173`。

## Docker 部署

```bash
docker build -t tyc-risk-demo .
docker run --rm -p 4173:4173 -e TYC_API_KEY="你的密钥" tyc-risk-demo
```

不要把密钥写入代码、Dockerfile 或 GitHub 仓库。部署平台应通过 Secret/Environment Variables 注入 `TYC_API_KEY`。

## GitHub 部署说明

GitHub Pages 只能托管静态文件，无法安全运行本项目的 Node 后端，也不能保存天眼查 API Key。因此本仓库提供 Docker 配置，建议从 GitHub 仓库连接 Render、Railway、Fly.io 或其他容器平台，并在平台中设置 `TYC_API_KEY`。GitHub 仓库本身用于版本管理和自动部署源代码，不在 Pages 中暴露密钥。

## 免责声明

评分仅用于商业合作初筛，不构成征信、法律或投资结论。公开数据可能存在延迟或缺失，重大合作应进行人工尽调。

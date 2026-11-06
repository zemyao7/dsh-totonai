# dsh-totonai 发布指南

从本地工程到出现在 DSH 模型广场的完整步骤。**分三步:打包验证 → 发布 npm → 登记市场。**

## 前置条件(一次性,做完就不用管)

| 需要 | 用途 | 现状 |
| --- | --- | --- |
| npm 账号 | 把包装发布到 npmjs.com,市场按包名安装 | 本机**未登录**,需要 `npm login` 由你本人输入密码 |
| GitHub 账号 | 放仓库 + 给 awesome-dsh-plugin 提 PR | 还不知道你的用户名,两个文档里的 `YOUR_GITHUB_USERNAME` 要替换 |
| Git for Windows | 推送仓库(`git` 命令) | 本机**未安装**,需装 [Git for Windows](https://git-scm.com/download/win) 或用 GitHub 网页上传 |

包名 `dsh-totonai` 已在 npm 查询确认**未被占用**。

---

## 第 1 步:本地打包与验证

```bash
# 1. 安装依赖并编译
npm install
npm run build          # tsc 输出到 lib/

# 2. 跑冒烟测试(流映射 / 消息转换 / 401 重试 / 充值工具 / 面板动作)
node test/smoke.mjs
node test/client-smoke.mjs   # 面板能否注册到设置页

# 3. 打包
npm pack               # 生成 dsh-totonai-0.1.0.tgz
```

### 本地安装到 DSH 试运行

```bash
# 安装本地包(web profile)
dsh plugin --profile web add ./dsh-totonai-0.1.0.tgz
```

安装后:

1. 重启 DeepSeek Harness。
2. **设置 → ToTonAI**,面板里点"注册新账号"或直接登录(不用改插件配置;也可以在 设置 → 插件 → llm-totonai 里填账号密码)。
3. 面板应显示用户名、档位、总额度/已用/剩余 token;点"生成收款码"应直接显示二维码图片。
4. 新会话选择任意 `ToTonAI` 模型(如 `openai/gpt-5.4`),对话测试。
5. 对模型说"帮我充值 Plus 月卡",验证返回金额、订单号与收款码;再说"已付款",验证申报写入站点 `manual_pay.log`;最后说"查一下会员状态",确认能读到档位与额度。

> 后端配套:主站 proxy.py 已加 `get_token_from_request()`(同时认 `X-Local-Pass` 与
> `Authorization: Bearer`),部署新版到服务器后插件才能用 Bearer 令牌。旧版网页端不受影响。

---

## 第 2 步:发布 npm 包

市场索引以 npm 包名为安装来源,所以必须先发布 npm。

```bash
npm login
npm publish --access public
```

发布前确认 `package.json`:

| 字段 | 要求 |
| --- | --- |
| `name` | `dsh-totonai`(已确认未被占用) |
| `main` / `exports` | 指向 `lib/index.js` 插件入口 |
| `dsh.bundle.patch` | `./cordis.patch.yml`(cordis 行注入,名字必须与包名一致) |
| `engines.dsh` | `>=0.2.0-rc.1 <0.3.0`(与市场索引的 engines.dsh 一致) |
| `files` | 只发 `lib`、`client`、`cordis.patch.yml`、`README.md`、`icon.svg`(不含 src/test/docs) |
| `exports["./client"]` | `./client/index.js`,设置页面板入口(缺了面板不会显示) |
| `dsh.client.platform` | `web`,告诉 DSH 这是 web 客户端插件 |

发布后验证:

```bash
npm view dsh-totonai version
```

---

## 第 3 步:登记市场(让插件出现在模型广场)

### 3.1 dsh-market(模型广场本体)

1. 把工程推到 GitHub(建议仓库名 `dsh-totonai`,tag `v0.1.0`)。
2. 在 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提 PR,
   新增 `data/plugins/totonai__dsh-totonai.yml`(内容见 `docs/awesome-dsh-plugin-totonai.yml`,
   把 `YOUR_GITHUB_USERNAME` 换成你的 GitHub 用户名)。
3. 合并后 dsh-market 通常一天内自动收录,模型广场搜索 "ToTonAI" 即可看到。

### 3.2 自建市场索引(可选,完全可控)

把 `docs/market-index-example.json` 按需改好(替换 GitHub 地址、更新版本/时间戳),
连同 `icons/totonai.svg` 一起放到任意静态主机(GitHub Pages / 对象存储):

```
https://your-host/dsh/index.json
https://your-host/dsh/icons/totonai.svg
```

在 DSH **插件 → 实验性插件 → 自定义插件市场** 开启,「发现」页**添加索引源**填 `index.json` 的 URL。

### 3.3 其他第三方市场(可选)

| 市场 | 提交方式 |
| --- | --- |
| dsh.so | 提交仓库地址,或在 GitHub 加 `dsh-plugin` / `dsh-pack` 话题 |
| dshopen.org | 提交插件仓库 |
| SkillHub | 提交插件信息 |

---

## 版本更新流程

改代码 → `npm run build` → 冒烟测试 → `npm version patch` → `npm publish` →
更新自建市场索引的 `version` / `publishTimestamp`(如自建)。
dsh-market 会自动发现 npm 新版本。

## 常见问题

- **装不上/不显示**:确认 DSH 版本 ≥ 0.2.0-rc.1;`engines.dsh` 是否匹配;cordis.patch.yml 的 `name` 是否等于包名。
- **401 登录失败**:账号密码是否正确;主站 proxy.py 是否已部署新版(Bearer 兼容)。
- **模型缺失**:站点模型有增减时,同步修改 `src/models.ts` 的 `TEXT_MODEL_IDS` 后重新发布。

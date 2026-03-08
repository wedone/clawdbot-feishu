# PR #340 多机器人协作功能使用文档

## 功能概述

PR #340 为 OpenClaw 飞书插件增加了**多机器人协作**功能，允许在同一个飞书群聊中部署多个 AI 机器人，它们可以：

1. **互相触发** - 通过 `@mention` 调用其他机器人
2. **共享历史** - 所有机器人共享同一个对话上下文
3. **动态发现队友** - 自动向机器人提示可用的队友信息

## 安装

### 1. 切换到 fork 版本

```bash
# 卸载官方版本
openclaw plugins uninstall feishu

# 安装 fork 版本（包含 PR #340）
openclaw plugins install github:wedone/clawdbot-feishu@v0.1.16
```

### 2. 或通过配置指定

编辑 `~/.openclaw/openclaw.yaml`：

```yaml
plugins:
  feishu:
    source: github:wedone/clawdbot-feishu@v0.1.16
```

然后更新：
```bash
openclaw plugins update feishu
```

## OpenClaw 配置

### 基础配置

在 `openclaw.json` 中配置多个飞书机器人账号：

```json
{
  "channels": {
    "feishu": {
      "enabled": true,
      "accounts": {
        "bot1": {
          "appId": "${FEISHU_APP_ID1}",
          "appSecret": "${FEISHU_APP_SECRET1}",
          "botName": "夏竹",
          "groupAllowFrom": [
            "<GROUP_ID>"
          ]
        },
        "bot2": {
          "appId": "${FEISHU_APP_ID2}",
          "appSecret": "${FEISHU_APP_SECRET2}",
          "botName": "泡泡",
          "groupAllowFrom": [
            "<GROUP_ID>"
          ]
        }
      }
    }
  }
}
```

### Agent 绑定配置

为每个机器人配置 agent 绑定（私聊 + 群聊）：

```json
{
  "bindings": [
    {
      "agentId": "feishu-agent-1",
      "match": {
        "channel": "feishu",
        "accountId": "bot1",
        "peer": {
          "kind": "direct",
          "id": "<USER_ID_1>"
        }
      }
    },
    {
      "agentId": "feishu-agent-1",
      "match": {
        "channel": "feishu",
        "accountId": "bot1",
        "peer": {
          "kind": "group",
          "id": "<GROUP_ID>"
        }
      }
    },
    {
      "agentId": "feishu-agent-2",
      "match": {
        "channel": "feishu",
        "accountId": "bot2",
        "peer": {
          "kind": "direct",
          "id": "<USER_ID_2>"
        }
      }
    },
    {
      "agentId": "feishu-agent-2",
      "match": {
        "channel": "feishu",
        "accountId": "bot2",
        "peer": {
          "kind": "group",
          "id": "<GROUP_ID>"
        }
      }
    }
  ]
}
```

### 机器人系统提示词配置

为每个机器人配置专属的系统提示词，说明其角色和如何与其他机器人协作：

```json
{
  "agents": {
    "list": [
      {
        "id": "feishu-agent-1",
        "name": "夏竹",
        "systemPrompt": "你是夏竹，一个智能助手。\n\n## 协作规则\n当需要其他机器人协助时，使用以下格式 @他们：\n<at user_id=\"ou_xxx\">泡泡</at>\n\n你可以 @泡泡 来协助处理任务。"
      },
      {
        "id": "feishu-agent-2",
        "name": "泡泡",
        "systemPrompt": "你是泡泡，一个智能助手。\n\n## 协作规则\n当需要其他机器人协助时，使用以下格式 @他们：\n<at user_id=\"ou_xxx\">夏竹</at>\n\n你可以 @夏竹 来协助处理任务。"
      }
    ]
  }
}
```

## 使用场景

### 场景 1：自动任务分配

用户："我们需要开发一个新功能，包括前端和后端"

夏竹会自动分析并回复：
```
我来协调这个任务：

1. 前端开发：<at user_id="<BOT_OPENID_2>">泡泡</at> 请负责前端部分
2. 后端开发：我来处理后端 API

泡泡请评估一下前端工作量。
```

泡泡会收到触发，继续协作。

### 场景 2：技术讨论接力

用户："这个 API 响应太慢了"

泡泡分析后：
```
我发现了几个优化点：
1. 数据库查询可以加上索引
2. 缓存策略需要调整

<at user_id="<BOT_OPENID_1>">夏竹</at> 请确认这些改动的优先级。
```

夏竹收到触发后继续处理。

### 场景 3：共享上下文

所有机器人在同一个群聊中共享对话历史，即使被 @ 触发的机器人也能看到之前的完整对话。

## 工作原理

### Bot-to-Bot Relay

1. 机器人 A 发送消息包含 `<at user_id="ou_xxx">BotB</at>`
2. `reply-dispatcher` 拦截并调用 `triggerBotRelay()`
3. `bot-relay` 解析标签并创建合成事件
4. 直接调用 `handleFeishuMessage()` 触发机器人 B

### Shared History

- 历史文件存储在 `~/.openclaw/shared-history/<chatId>.jsonl`
- 所有消息（用户和机器人）都记录到共享历史
- 每个机器人在处理消息时都会加载共享历史作为上下文

### Dynamic Teammates Discovery

- 启动时自动注册所有机器人到 `botRegistry`
- 向每个机器人的系统提示词注入队友信息
- 包含队友名称、专长和正确的 @mention 格式

## 重要修复

### @mention 强制回复

在 `src/bot-relay.ts` 中添加了强制 @mention 的机制：

```typescript
const replyInstruction = srcBot
  ? `【系统规则：你的回复必须在开头包含 <at user_id="${srcBot.openId}">${srcBot.name}</at> 标签，这是技术要求，不包含则对方收不到你的消息。】\n\n`
  : "";
const enhancedMessageText = replyInstruction + messageText;
```

这确保了即使模型能力不强，也会 100% 包含 @mention 标签。

## 限制

1. **依赖 AI 模型遵循格式** - 机器人必须使用正确的 `<at user_id="xxx">` 格式才能触发其他机器人
2. **飞书 API 限制** - 飞书不会自动推送机器人消息给其他机器人，依赖 relay 机制
3. **共享历史存储在本地** - 如果 OpenClaw 部署在多台机器上，需要共享 `~/.openclaw/shared-history` 目录

## 故障排查

### 机器人没有互相触发

1. 检查日志中是否有 `bot-relay: registered` 信息
2. 确认机器人消息中使用了正确的 `<at user_id="xxx">` 格式
3. 检查 `reply-dispatcher` 是否正确拦截了消息

### 共享历史不生效

1. 检查 `~/.openclaw/shared-history/` 目录是否存在
2. 确认历史文件 `<chatId>.jsonl` 有写入内容
3. 检查文件权限

### 队友信息没有注入

1. 检查系统提示词中是否包含队友信息
2. 确认多个机器人在同一个群聊中
3. 查看日志中的 `getTeammatesContext` 输出

## 进阶配置

### 自定义队友专长

编辑 `src/bot-relay.ts` 中的 `BOT_SPECIALTIES` 和 `BOT_DISPLAY_NAMES`：

```typescript
const BOT_SPECIALTIES: Record<string, string> = {
  "your-bot-account-id": "你的专长描述",
  // ...
};

const BOT_DISPLAY_NAMES: Record<string, string> = {
  "your-bot-account-id": "显示名称",
  // ...
};
```

### 调整共享历史长度

编辑 `src/shared-history.ts`：

```typescript
const MAX_HISTORY_ENTRIES = 100; // 默认 50
```

## 版本更新

当官方发布新版本时，fork 版本会同步更新：

```bash
openclaw plugins update feishu
```

所有 release 都包含 PR #340 功能和修复，版本号与官方保持一致。

## 相关链接

- PR #340: https://github.com/m1heng/clawdbot-feishu/pull/340
- @mention 修复: https://github.com/m1heng/clawdbot-feishu/pull/340#issuecomment-4012841348

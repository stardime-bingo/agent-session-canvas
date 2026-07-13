/**
 * [INPUT]: 依赖 llm 的多后端路由、adapters/shared 的局部读取、store 的增强数据仓
 * [OUTPUT]: 对外提供 summarize(session)、makeHandoff(session)、nameSession(session)、extractDigest(session)
 * [POS]: server 的认知层——把机器日志蒸馏成人话：标题给一眼扫过的人，摘要给想接手的人
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import fs from 'node:fs';
import { runLLM, llmConfig } from './llm.mjs';
import { headLines, tailText, sliceText } from './adapters/shared.mjs';
import { updateEnrich } from './store.mjs';

// ============================================================
//  会话事件流抽取：对白 + 工具行动轨迹 + 错误现场，三流合一
//  ——弯路和失败大多藏在工具调用与报错里，只抽纯文本等于丢掉考古层
// ============================================================
const briefInput = input => {
  if (!input) return '';
  return input.file_path || input.command?.slice(0, 140) || input.description
    || input.pattern || input.url || JSON.stringify(input).slice(0, 120);
};

function extractEvents(lines) {
  const out = [];
  for (const line of lines) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    // ---- Claude Code 格式 ----
    if (d.type === 'user' || d.type === 'assistant') {
      const c = d.message?.content;
      if (typeof c === 'string') {
        if (c.trim()) out.push({ k: d.type, t: c });
      } else if (Array.isArray(c)) {
        for (const x of c) {
          if (x.type === 'text' && x.text?.trim()) out.push({ k: d.type, t: x.text });
          else if (x.type === 'tool_use') out.push({ k: 'tool', t: `${x.name}: ${briefInput(x.input)}` });
          else if (x.type === 'tool_result' && x.is_error) {
            const t = typeof x.content === 'string' ? x.content
              : (x.content || []).map(y => y.text || '').join(' ');
            if (t.trim()) out.push({ k: 'error', t: t.slice(0, 320) });
          }
        }
      }
    }
    // ---- Codex 格式 ----
    const p = d.payload || {};
    if (d.type === 'response_item') {
      if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
        const t = (p.content || []).map(c => c.text || '').join('\n');
        if (t.trim()) out.push({ k: p.role, t });
      } else if (p.type === 'function_call') {
        out.push({ k: 'tool', t: `${p.name}: ${String(p.arguments || '').slice(0, 140)}` });
      } else if (p.type === 'function_call_output') {
        const o = String(p.output || '').slice(0, 400);
        if (/error|failed|exception|denied|fatal/i.test(o)) out.push({ k: 'error', t: o.slice(0, 320) });
      }
    }
  }
  return out
    .map(m => ({ ...m, t: m.t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim() }))
    .filter(m => m.t && !(m.k !== 'tool' && m.t.startsWith('<')));
}

const CAPS = { user: 900, assistant: 500, tool: 160, error: 320 };
const MARK = { user: '[用户]', assistant: '[助手]', tool: '  ▸', error: '  ✗ 报错' };
const fmtEvents = events => events.map(m => `${MARK[m.k]} ${m.t.slice(0, CAPS[m.k])}`).join('\n');

// ============================================================
//  会话蒸馏：轻档（命名/摘要）读首尾；深档（接力）加读中段切片，
//  三段式：任务源起 → 行动与弯路 → 最终状态
// ============================================================
export function extractDigest(session, cap = 12000, deep = false) {
  const size = fs.statSync(session.filePath).size;
  const headBytes = deep ? 262144 : 131072;
  const tailBytes = deep ? 524288 : 262144;

  const head = extractEvents(headLines(session.filePath, headBytes));
  const tail = extractEvents(tailText(session.filePath, tailBytes).split('\n').slice(1).filter(Boolean));

  let middle = '';
  if (deep && size > headBytes + tailBytes) {
    const midEvents = extractEvents(
      sliceText(session.filePath, Math.floor(size / 2), 131072).split('\n').slice(1, -1).filter(Boolean));
    middle = `\n\n【中段采样 · 行动与弯路】(全文 ${(size / 1048576).toFixed(1)}MB，此为中点切片)\n${fmtEvents(midEvents.slice(0, 60))}`;
  }

  const opening = fmtEvents(head.slice(0, deep ? 35 : 6));
  const ending = fmtEvents(tail.slice(-(deep ? 90 : 16)));
  return `【开场 · 任务源起】\n${opening}${middle}\n\n【结尾 · 最终状态】\n${ending}`.slice(0, cap);
}

export function jsonOf(text) {
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') quoted = false;
        continue;
      }
      if (ch === '"') quoted = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); }
        catch { break; }
      }
    }
  }
  return null;
}

// 模型偶尔会包一层 ```markdown 围栏，剥掉它
const unfence = text => text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/, '').trim();

function saveTo(bucket, key, value) {
  updateEnrich(enrich => { enrich[bucket][key] = value; });
}

// ============================================================
//  批量命名：轻量蒸馏，只求一个"人扫一眼就懂"的标题
// ============================================================
export async function nameSession(session, effort) {
  const digest = extractDigest(session, 3500);
  const { text, backend } = await runLLM(
    `你在给一位同时管理几百个 AI 编程会话的主理人整理看板。下面是某次会话的片段，给它起一个标题。

标题铁律：
- 中文人话，动词开头，8-16 字，像"修复了登录页闪退"而不是"login-fix-session"
- 说清【做了什么事】，禁止复述指令原文、禁止路径/命令/代号开头
- 会话没实质内容就叫"闲置会话"

输出严格 JSON（无代码块）: {"title":"...","tags":["1-2个中文短标签"]}

工作区: ${session.cwd}
${digest}`, { effort: effort || llmConfig().effortBatch });

  const result = jsonOf(text);
  if (!result?.title) throw new Error('命名解析失败: ' + text.slice(0, 120));
  saveTo('titles', session.key, result.title);
  return { ...result, backend };
}

// ============================================================
//  摘要：给"想快速判断要不要接手"的人写三句话
// ============================================================
export async function summarize(session) {
  const digest = extractDigest(session);
  const { text, backend } = await runLLM(
    `你在给一位管理几百个 AI 编程会话的主理人写会话档案卡。他只想知道三件事：干了什么、干到哪了、还欠什么。

输出严格 JSON（无代码块）：
{"title":"动词开头的中文人话标题，8-16字","summary":"2-3句白话。第一句干了什么，第二句结果如何，第三句(如有)遗留什么。禁止术语堆砌，像跟人口头交代一样","tags":["1-3个中文标签"],"outcome":"completed|in_progress|failed|unknown"}

工作区: ${session.cwd}
工具: ${session.tool}

${digest}`);

  const result = jsonOf(text);
  if (!result) throw new Error('摘要解析失败: ' + text.slice(0, 200));
  saveTo('summaries', session.key, { ...result, backend, generatedAt: new Date().toISOString() });
  if (result.title) saveTo('titles', session.key, result.title);
  return result;
}

// ============================================================
//  接力提示词：为接班 Agent 写交接文档
//  哲学：给地图和考古线索，不给圣旨——指引他自己去读真相源，
//  事无巨细保住"试过什么/为何废弃"这类代码里挖不回来的知识
// ============================================================
export async function makeHandoff(session) {
  const digest = extractDigest(session, 30000, true);
  const { text, backend } = await runLLM(
    `你是 AI 会话接力官。下面是一场即将交棒的 Agent 编程会话的完整蒸馏（开场、中段行动轨迹、结尾），请为「零上下文的接班 Agent」写一份交接文档（中文 markdown）。

先记住你的读者：接班的是另一个 Claude Code / Codex Agent。这类 Agent 的四大通病——冷启动时重新摸索浪费轮次、轻信过时摘要产生幻觉状态、重做已完成的事、重踩前任踩过的坑。你的文档就是针对这四个病的疫苗。

写作哲学（比结构更重要）：
- 你的职责是让接班人**有指引地自己去读**真相源（文件/git log/台账），不是替他转述内容，更不是规定他具体怎么干活——压缩即失真，越俎代庖损失最大
- 「尝试过什么、为什么废弃」是唯一无法从代码和 git 里恢复的知识，这部分事无巨细，宁长勿缺
- 每个"已完成"都给验证方式（命令/路径），让接班人实证而非轻信
- 易腐细节（行号/临时状态）给指路牌不给快照；不确定的标注「待验证：」；绝不编造文件名或命令
- 某节确实无内容就写「无」，不要硬凑

结构（不设字数上限，详尽优先）：
# 会话接力 · <一句话任务名>
## 0. 角色与协作约定 —— 从会话观察到的：用户称呼、语言、哪些动作必须先向用户确认
## 1. 任务本质 —— 这活为什么存在，最终要达成什么
## 2. 上下文重建路径（按序读，读完再动手）—— 有序清单：每步读什么文件/跑什么命令 + 为什么读它
## 3. 已完成（不要重做）—— 每项附验证方式
## 4. 尝试与失败考古 —— 弯路、被否决的方案、废弃原因，越细越好
## 5. 当前精确状态 —— 已提交 vs 未提交、运行中的服务、改到一半的东西、悬着的承诺
## 6. 未竟与风险 —— 陈述事实与方向即可，具体做法留给接班人和用户商定
## 7. 铁律 —— 本会话中用户纠正过的做法、立下的规矩，原样保留
## 8. 小事记账 —— 容易丢的零碎（待用户提供的东西、挂着的外部依赖、一次性口头约定）

直接输出交接文档正文，不要解释。

工作区: ${session.cwd}
工具: ${session.tool}

${digest}`);

  const clean = unfence(text);
  saveTo('handoffs', session.key, { text: clean, backend, generatedAt: new Date().toISOString() });
  return clean;
}

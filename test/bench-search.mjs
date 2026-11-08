#!/usr/bin/env node
/**
 * 0.8.0 search benchmark — 10,000 synthetic notes (mixed corpus).
 *
 * Run:  npm run build && node test/bench-search.mjs
 *
 * Reports five numbers:
 *   1. Cold index time (full build from scratch, no persisted index).
 *   2. Hot query p50/p95/p99/max (100 mixed queries after the index is ready).
 *   3. Incremental update time (10 files changed, stat scan + re-index).
 *   4. Memory (heap used after build; peak RSS).
 * The maximum latency is reported alongside the percentiles: a p99
 * over 100 queries hides the slowest one.
 *
 * The corpus is deterministic (seeded RNG) so runs are comparable.
 * Nothing is published to npm; this is a verification script.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { LocalStorageBackend } from '../dist/storage.js';
import { LocalSearchIndex } from '../dist/search-index.js';

const NOTE_COUNT = 10_000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A realistic vocabulary (was 20 Chinese + 16 English words, so
// almost every note shared the same few terms and the query set was
// far more repetitive than a real library).
const ZH_WORDS = [
  '全文检索', '记忆库', '笔记', '工作', '读书', '项目', '会议', '计划', '思考', '总结',
  '开发', '测试', '发布', '文档', '学习', '时间', '管理', '目标', '问题', '方案',
  '产品', '设计', '用户', '需求', '功能', '系统', '数据', '分析', '报告', '团队',
  '沟通', '效率', '工具', '方法', '经验', '教训', '想法', '灵感', '创意', '写作',
  '阅读', '运动', '健康', '睡眠', '饮食', '旅行', '摄影', '音乐', '电影', '书籍',
  '课程', '考试', '面试', '求职', '简历', '工资', '投资', '理财', '股票', '基金',
  '房价', '租房', '装修', '汽车', '手机', '电脑', '网络', '安全', '隐私', '备份',
  '同步', '云端', '本地', '搜索', '索引', '缓存', '数据库', '服务器', '客户端', '接口',
  '算法', '模型', '训练', '推理', '提示', '代理', '插件', '扩展', '主题', '界面',
  '交互', '体验', '反馈', '迭代', '版本', '分支', '合并', '冲突', '修复', '漏洞',
  '性能', '优化', '重构', '代码', '函数', '变量', '类型', '用例', '覆盖', '部署',
  '上线', '回滚', '监控', '告警', '日志', '追踪', '调试', '断点', '堆栈', '内存',
  '磁盘', '延迟', '带宽', '流量', '费用', '订阅', '付费', '免费', '试用', '优惠',
  '折扣', '活动', '抽奖', '礼物', '节日', '生日', '纪念', '周年', '家庭', '朋友',
  '同事', '领导', '客户', '合作', '竞争', '市场', '销售', '运营', '推广', '广告',
  '品牌', '口碑', '评价', '投诉', '建议', '改进', '创新', '突破', '瓶颈', '风险',
  '机会', '挑战', '成长', '进步', '成功', '失败', '坚持', '放弃', '选择', '决定',
  '行动', '习惯', '规律', '作息', '早起', '夜跑', '健身', '瑜伽', '冥想', '画画',
  '烹饪', '烘焙', '园艺', '钓鱼', '登山', '跑步', '游泳', '骑行', '滑雪', '潜水',
  '露营', '野餐', '烧烤', '火锅', '奶茶', '咖啡', '面包', '水果', '蔬菜', '肉类',
  '海鲜', '调料', '食谱', '营养', '维生素', '蛋白质',
];
const EN_WORDS = [
  'search', 'index', 'memory', 'notes', 'project', 'meeting', 'review', 'design',
  'testing', 'release', 'document', 'learning', 'planning', 'benchmark', 'cache', 'token',
  'model', 'prompt', 'agent', 'plugin', 'server', 'client', 'database', 'network', 'security',
  'privacy', 'backup', 'sync', 'cloud', 'local', 'mobile', 'desktop', 'browser', 'editor',
  'terminal', 'keyboard', 'mouse', 'monitor', 'speaker', 'camera', 'photo', 'video', 'audio',
  'music', 'movie', 'book', 'course', 'exam', 'interview', 'resume', 'salary', 'invest',
  'finance', 'stock', 'fund', 'market', 'sales', 'marketing', 'brand', 'product', 'feature',
  'system', 'data', 'analysis', 'report', 'team', 'feedback', 'iteration', 'version', 'branch',
  'merge', 'conflict', 'bug', 'performance', 'refactor', 'code', 'function', 'variable', 'type',
  'deploy', 'log', 'debug', 'disk', 'latency', 'traffic', 'cost', 'subscription', 'trial',
  'discount', 'gift', 'holiday', 'birthday', 'family', 'friend', 'travel', 'fitness', 'health',
  'sleep', 'diet', 'recipe', 'coffee', 'bread', 'fruit', 'garden', 'fishing', 'hiking',
  'running', 'swimming', 'cycling', 'skiing', 'camping', 'cooking', 'reading', 'writing',
  'painting', 'guitar', 'piano',
];
const TAGS = ['工作', '读书', '项目', '生活', 'tech', 'notes'];

function makeNote(rng, i) {
  const lines = [];
  const tagCount = Math.floor(rng() * 3);
  const tags = [];
  for (let t = 0; t < tagCount; t += 1) {
    tags.push(TAGS[Math.floor(rng() * TAGS.length)]);
  }
  const month = String(1 + Math.floor(rng() * 12)).padStart(2, '0');
  const day = String(1 + Math.floor(rng() * 28)).padStart(2, '0');
  lines.push('---');
  if (tags.length > 0) {
    lines.push(`tags: [${tags.join(', ')}]`);
  }
  lines.push(`date: 2026-${month}-${day}`);
  lines.push('---');
  lines.push(`# 笔记 ${i} ${ZH_WORDS[Math.floor(rng() * ZH_WORDS.length)]}`);
  lines.push('');
  const paraCount = 1 + Math.floor(rng() * 4);
  for (let p = 0; p < paraCount; p += 1) {
    const words = [];
    const wordCount = 20 + Math.floor(rng() * 60);
    for (let w = 0; w < wordCount; w += 1) {
      if (rng() < 0.6) {
        words.push(ZH_WORDS[Math.floor(rng() * ZH_WORDS.length)]);
      } else {
        words.push(EN_WORDS[Math.floor(rng() * EN_WORDS.length)]);
      }
    }
    lines.push(words.join(rng() < 0.5 ? '' : ' '));
    lines.push('');
  }
  return lines.join('\n');
}

function percentile(sorted, p) {
  if (sorted.length === 0) {
    return 0;
  }
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

async function main() {
  const rng = mulberry32(20261108);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'memdrive-bench-'));
  const libDir = path.join(tmp, 'library');
  await fs.mkdir(libDir, { recursive: true });
  const cacheDir = path.join(tmp, 'cache');
  process.env['MEMDRIVE_CACHE_DIR'] = cacheDir;

  // Generate the corpus (spread over 20 subfolders, like a real library).
  const genStart = Date.now();
  for (let i = 0; i < NOTE_COUNT; i += 1) {
    const sub = `folder-${String(Math.floor(i / 500)).padStart(2, '0')}`;
    await fs.mkdir(path.join(libDir, sub), { recursive: true });
    await fs.writeFile(path.join(libDir, sub, `note-${String(i).padStart(5, '0')}.md`), makeNote(rng, i));
  }
  const genMs = Date.now() - genStart;

  const backend = new LocalStorageBackend(libDir);
  const idx = new LocalSearchIndex(libDir, libDir, backend);

  // 1. Cold index time.
  const coldStart = Date.now();
  await idx.buildAll();
  const coldMs = Date.now() - coldStart;

  // 2. Hot query p50/p95/p99/max (100 mixed queries).
  const queries = [];
  for (let q = 0; q < 100; q += 1) {
    if (q % 2 === 0) {
      queries.push(ZH_WORDS[Math.floor(rng() * ZH_WORDS.length)]);
    } else {
      queries.push(EN_WORDS[Math.floor(rng() * EN_WORDS.length)]);
    }
  }
  const latencies = [];
  for (const q of queries) {
    const t0 = Date.now();
    await idx.search({ keyword: q, limit: 20 });
    latencies.push(Date.now() - t0);
  }
  latencies.sort((a, b) => a - b);
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const p99 = percentile(latencies, 99);
  const max = latencies.length > 0 ? latencies[latencies.length - 1] : 0;

  // 3. Incremental update (10 files changed). The appended term is a
  // nonsense word that occurs nowhere else, so the hit count must
  // equal the number of changed files. Settle first: the query loop
  // above leaves a background refresh in flight, and measuring on
  // top of it would count its remainder plus a follow-up pass.
  await idx.refreshIfNeeded(Date.now() + 60_000);
  for (let i = 0; i < 10; i += 1) {
    const target = path.join(libDir, 'folder-00', `note-${String(i).padStart(5, '0')}.md`);
    await fs.appendFile(target, '\n新增内容 ZQXJUPDATE 全文检索。\n');
  }
  const incrStart = Date.now();
  await idx.refreshIfNeeded(Date.now() + 60_000);
  const incrMs = Date.now() - incrStart;
  const afterUpdate = await idx.search({ keyword: 'ZQXJUPDATE' });

  // 4. Memory.
  const mem = process.memoryUsage();

  console.log(`corpus: ${NOTE_COUNT} notes (generated in ${genMs} ms)`);
  console.log(`cold index time: ${coldMs} ms`);
  console.log(`hot query: p50 ${p50} ms, p95 ${p95} ms, p99 ${p99} ms, max ${max} ms (100 queries)`);
  console.log(`incremental update (10 files changed): ${incrMs} ms; updated term found: ${afterUpdate.total} hit(s)`);
  console.log(`memory: heapUsed ${(mem.heapUsed / 1_000_000).toFixed(1)} MB, rss ${(mem.rss / 1_000_000).toFixed(1)} MB`);
  console.log(`index files: ${(await fs.readdir(cacheDir, { recursive: true })).length} entries under cache dir`);

  await fs.rm(tmp, { recursive: true, force: true });
}

main().catch((error) => {
  console.error('Benchmark failed:', error);
  process.exit(1);
});

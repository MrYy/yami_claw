import { describe, expect, it } from "vitest";
import { extractSuggestions, mergeStreamingText } from "./streaming-card.js";

describe("mergeStreamingText", () => {
  it("prefers the latest full text when it already includes prior text", () => {
    expect(mergeStreamingText("hello", "hello world")).toBe("hello world");
  });

  it("keeps previous text when the next partial is empty or redundant", () => {
    expect(mergeStreamingText("hello", "")).toBe("hello");
    expect(mergeStreamingText("hello world", "hello")).toBe("hello world");
  });

  it("appends fragmented chunks without injecting newlines", () => {
    expect(mergeStreamingText("hello wor", "ld")).toBe("hello world");
    expect(mergeStreamingText("line1", "line2")).toBe("line1line2");
  });
});

describe("extractSuggestions", () => {
  it("extracts bullet list items from the end of text", () => {
    const text = `如果你要更硬一点的数据版，我可以再做一轮：
• 近 24h 抓取更大样本（例如 100 条）
• 输出 占比 + 时间分布 + 关键触发帖子 的小报表。`;
    expect(extractSuggestions(text)).toEqual([
      "近 24h 抓取更大样本（例如 100 条）",
      "输出 占比 + 时间分布 + 关键触发帖子 的小报表。",
    ]);
  });

  it("extracts dash-prefixed list items", () => {
    const text = `我建议：
- 优化数据库查询
- 添加缓存层
- 增加监控告警`;
    expect(extractSuggestions(text)).toEqual(["优化数据库查询", "添加缓存层", "增加监控告警"]);
  });

  it("extracts numbered list items", () => {
    const text = `你可以试试：
1. 重启服务
2. 检查日志
3. 联系运维`;
    expect(extractSuggestions(text)).toEqual(["重启服务", "检查日志", "联系运维"]);
  });

  it("respects max limit", () => {
    const text = `建议：
- A
- B
- C
- D`;
    expect(extractSuggestions(text, 2)).toEqual(["A", "B"]);
  });

  it("returns empty array when no trailing list found", () => {
    expect(extractSuggestions("这是一段普通文本，没有列表。")).toEqual([]);
  });

  it("stops at non-list lines (only captures trailing list)", () => {
    const text = `- 这是前面的列表项
这里是普通文本
- 这才是末尾的建议`;
    expect(extractSuggestions(text)).toEqual(["这才是末尾的建议"]);
  });

  it("extracts prose-style suggestions when no list found", () => {
    const text = `从数据侧看你这个 case

如果你愿意，我可以继续给你一版**传播链路图**（触发帖 → 扩散账号类型 → 峰值时间段 → 衰减预测），用于判断这个话题还能热多久。`;
    const result = extractSuggestions(text);
    expect(result.length).toBe(1);
    expect(result[0]).toContain("我可以继续给你一版传播链路图");
  });

  it("extracts multiple prose suggestions", () => {
    const text = `总结完毕。

你可以试试用这个方案优化查询性能。
如果你需要，我可以帮你写一个完整的实现。`;
    const result = extractSuggestions(text);
    expect(result.length).toBe(2);
    expect(result[0]).toContain("你可以试试");
    expect(result[1]).toContain("我可以帮你");
  });

  it("extracts prose with indirect phrasing like '我下一条可以补'", () => {
    const text = `一页结论（可放页脚）
• 核心目标不是"删热度"，而是把热度从"情绪对抗"转成"事实讨论"。
• 最关键窗口是前 1~2 小时，越晚介入，治理成本指数上升。
• 治理优先级：误导信息 > 对抗情绪 > 品牌修复。
如果你要，我下一条可以补一张"指标看板模板"（告警阈值、责任人、处置 SLA）。`;
    const result = extractSuggestions(text);
    expect(result.length).toBe(1);
    expect(result[0]).toContain("可以补一张");
  });

  it("prefers list items over prose suggestions", () => {
    const text = `如果你愿意，我可以继续：
- 方案A
- 方案B`;
    expect(extractSuggestions(text)).toEqual(["方案A", "方案B"]);
  });
});

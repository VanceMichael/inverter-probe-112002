// 两种采集柜共用同一套来源接口：
// - GET  /source/archive、/source/live、/source/wiring 分页领取（offset/limit，next 为 null 即末页）
// - POST /control?stage=N 切换回放阶段；阶段切换后早期记录仍可查，只新增记录
// 客户端按“来源记录键 record”做幂等：重放页、重复推送都不会产生第二条入站记录。
// live 的 seq 空洞只表示本地序号不连续，不能据此判定缺测（见 coverage.mjs 的处理）。

export class SourceClient {
  #baseUrl;
  #fetch;
  #watermarks = new Map(); // source -> 已领页最大 offset 之后的位置（按 record 键幂等）
  #seen = new Map();       // source -> Set(record)

  constructor(baseUrl, { fetchImpl = fetch } = {}) {
    this.#baseUrl = baseUrl.replace(/\/$/, '');
    this.#fetch = fetchImpl;
    for (const name of ['archive', 'live', 'wiring']) {
      this.#watermarks.set(name, 0);
      this.#seen.set(name, new Set());
    }
  }

  async overview() {
    const response = await this.#fetch(this.#baseUrl);
    if (!response.ok) throw new Error(`来源根路径失败: ${response.status}`);
    return response.json();
  }

  async setStage(stage) {
    const response = await this.#fetch(`${this.#baseUrl}/control?stage=${stage}`, { method: 'POST' });
    if (!response.ok) {
      throw new Error(`切换阶段 ${stage} 失败: ${response.status}`);
    }
    return response.json();
  }

  // 仅领取自上次以来新增的记录；按 record 键去重，返回新记录数组。
  // 分页页偏移本身不保存状态语义（来源保留全部已释出记录），逐页扫描直到 next=null。
  async fetchNew(source, { limit = 100 } = {}) {
    if (!this.#seen.has(source)) throw new Error(`未知来源: ${source}`);
    const seen = this.#seen.get(source);
    const fresh = [];
    let offset = 0;
    for (;;) {
      const response = await this.#fetch(
        `${this.#baseUrl}/source/${source}?offset=${offset}&limit=${limit}`,
      );
      if (!response.ok) throw new Error(`领取 ${source} 失败: ${response.status}`);
      const page = await response.json();
      for (const entry of page.records) {
        if (!seen.has(entry.record)) {
          seen.add(entry.record);
          fresh.push(entry);
        }
      }
      if (page.next === null) break;
      offset = page.next;
    }
    this.#watermarks.set(source, offset);
    return fresh;
  }

  hasSeen(source, recordKey) {
    return this.#seen.get(source)?.has(recordKey) ?? false;
  }
}

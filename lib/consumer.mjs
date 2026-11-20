// 实时消费者视图：
// - 只暴露当前仍有效的释出（withdrawn 痕迹永不对外当作当前值）；
// - 失效信息指到具体接线事件、区间与受影响样本，修订后的新数据必须带确定归属依据才再可见；
// - 覆盖按“已确认覆盖领区间”表达，未确认/不可恢复区段显式标出，不制造完整假象；
// - 同站未搬迁通道互不影响：所有查询以入站通道为键。

import { EventEmitter } from 'node:events';

export class ConsumerView extends EventEmitter {
  #lastEventId;

  constructor(pipeline) {
    super();
    this.pipeline = pipeline;
    this.#lastEventId = null;
    for (const event of pipeline.store.events) this.#note(event);
  }

  #note(event) {
    this.#lastEventId = event.id;
    if (event.type === 'invalidated') this.emit('invalidation', event);
    if (event.type === 'released' || event.type === 'rereleased' || event.type === 'unblocked') {
      this.emit('release', event);
    }
    if (event.type === 'suspended') this.emit('suspension', event);
  }

  // 流水线外直接登记新记录后调用，补发增量事件。
  sync() {
    const fresh = this.pipeline.eventsSince(this.#lastEventId);
    for (const event of fresh) this.#note(event);
    return fresh;
  }

  get lastEventId() {
    return this.#lastEventId;
  }

  // 当前已确认覆盖领区间：只汇总 covered 段，附带阻断段说明。
  confirmedCoverage(cabinet, channel, window = ['00:00', '24:00']) {
    const summary = this.pipeline.coverage(cabinet, channel, window);
    return {
      channel: summary.channel,
      complete: summary.complete,
      floor: summary.floor,
      confirmed: summary.segments
        .filter((segment) => segment.status === 'covered')
        .map(({ startText, endText, meta }) => ({ start: startText, end: endText, recordKey: meta.recordKey })),
      suspended: summary.segments
        .filter((segment) => segment.status === 'suspended')
        .map(({ startText, endText }) => ({ start: startText, end: endText })),
      explicitEmpty: summary.segments
        .filter((segment) => segment.status === 'explicit-empty')
        .map(({ startText, endText }) => ({ start: startText, end: endText })),
      pending: summary.segments
        .filter((segment) => segment.status === 'pending')
        .map(({ startText, endText }) => ({ start: startText, end: endText })),
      unrecoverable: summary.segments
        .filter((segment) => segment.status === 'unrecoverable')
        .map(({ startText, endText, meta }) => ({ start: startText, end: endText, floor: meta.floor })),
      blocking: summary.blocking,
    };
  }

  // 检修员视角：只补缺失点位与时段，不必重取全站。
  backfillTicket(cabinet, channel, window = ['00:00', '24:00']) {
    const plan = this.pipeline.backfillPlan(cabinet, channel, window);
    return {
      channel: `${cabinet}|${channel}`,
      fetchScope: 'missing-only',
      slots: plan,
      note: plan.length === 0
        ? '保存期内无待补时段；若仍有缺口请查看 unrecoverable/suspended 段'
        : '仅领取下列时段，已覆盖与已确认空档无需重取',
    };
  }

  currentSeries(point) {
    return this.pipeline.series(point);
  }

  // 失效台账：消费者可据此撤回本地已展示曲线并定位修订事件。
  invalidationFeed() {
    return this.pipeline.store.events.filter((event) => event.type === 'invalidated');
  }
}

// 接线登记：
// 同一 (cabinet, channel) 的接线按 revision 演进；新修订只在其声明区间内推翻旧依据。
// 归属解析严格按“样本发生时刻 measured”落在哪条接线的左闭右开区间，
// 而不是接收时刻或柜内重放起点。
//
// 换接底数（cutover）决定累计量能否跨换接点拼接：
// 只有 continuous=true 且拆、装底数都给得出时，才允许按两侧倍率拼到同一连续序列。

import { contains, parseHM, toInterval } from './time.mjs';

export class WiringRegistry {
  // key: `${cabinet}|${channel}` -> 接线数组（按 revision 排序）
  #wires = new Map();
  // key: `${point}` -> cutover 事件数组（按发生时刻）
  #cutovers = new Map();

  addWire({ record, payload }) {
    const key = channelKey(payload.cabinet, payload.channel);
    const entry = {
      record,
      cabinet: payload.cabinet,
      channel: payload.channel,
      point: payload.point,
      interval: toInterval(payload.range),
      rangeText: payload.range,
      scale: payload.scale,
      direction: payload.direction,
      revision: payload.revision,
    };
    const list = this.#wires.get(key) ?? [];
    const existing = list.findIndex((item) => item.record === entry.record);
    if (existing >= 0) list[existing] = entry;
    else list.push(entry);
    list.sort((a, b) => a.interval[0] - b.interval[0] || a.revision - b.revision);
    this.#wires.set(key, list);
    return entry;
  }

  addCutover({ record, payload }) {
    const entry = {
      record,
      id: payload.id,
      point: payload.point,
      time: parseHM(payload.time),
      timeText: payload.time,
      continuous: payload.continuous === true,
      baseOld: payload.base?.[0] ?? null,
      baseNew: payload.base?.[1] ?? null,
    };
    const list = this.#cutovers.get(entry.point) ?? [];
    const idx = list.findIndex((item) => item.id === entry.id);
    if (idx >= 0) list[idx] = entry;
    else list.push(entry);
    list.sort((a, b) => a.time - b.time);
    this.#cutovers.set(entry.point, list);
    return entry;
  }

  // 解析某入站通道在某发生时刻适用的接线；区间内取最高 revision。
  // 返回 null 即“当前没有可证明的接线属性”，样本必须挂起而非猜测归属。
  resolve(cabinet, channel, measured) {
    const t = parseHM(measured);
    const list = this.#wires.get(channelKey(cabinet, channel)) ?? [];
    const hit = list
      .filter((wire) => contains(wire.interval, t))
      .sort((a, b) => b.revision - a.revision)[0];
    return hit ? basisOf(hit) : null;
  }

  wiresOf(cabinet, channel) {
    return (this.#wires.get(channelKey(cabinet, channel)) ?? []).map(basisOf);
  }

  cutoversOf(point) {
    return this.#cutovers.get(point) ?? [];
  }

  // 累计量跨换接点拼接判定。
  // allowed=false 时给出明确原因，调用方不得把两侧差值当发电量，也不得用相邻柜凑数。
  evaluateCutover(point) {
    const cutover = this.#cutovers.get(point)?.at(-1);
    if (!cutover) {
      return { allowed: false, reason: 'no-cutover-record', cutover: null };
    }
    if (!cutover.continuous) {
      return { allowed: false, reason: 'meter-not-continuous', cutover };
    }
    if (cutover.baseOld === null || cutover.baseNew === null) {
      return { allowed: false, reason: 'missing-handover-base', cutover };
    }
    return { allowed: true, reason: null, cutover };
  }
}

export function channelKey(cabinet, channel) {
  return `${cabinet}|${channel}`;
}

function basisOf(wire) {
  return {
    wireRecord: wire.record,
    cabinet: wire.cabinet,
    channel: wire.channel,
    point: wire.point,
    interval: wire.interval,
    rangeText: wire.rangeText,
    scale: wire.scale,
    direction: wire.direction,
    revision: wire.revision,
  };
}

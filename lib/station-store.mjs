// 站内存储：原始点 -> 可解释物理测点的全部证据都在这里留痕。
//
// 三层身份：
//   入站身份 (recordKey, cabinet, channel, sample, seq) 永久保留；
//   物理身份 sample：重放来源（origin）指向的是同一个物理样本，不另立样本；
//   物理测点 point：由接线依据决定，接线修订可改变测点归属。
//
// 释出痕迹 traces：同一样本每次释出/失效都追加痕迹，绝不就地覆盖，
// 因此“后来被接线修订推翻”的区间可以精确定位到事件与样本。

import { channelKey } from './wiring-registry.mjs';
import { formatHM, parseHM } from './time.mjs';

export class StationStore {
  #observations = new Map();      // recordKey -> 入站记录
  #byInbound = new Map();         // channelKey -> Map(sampleName -> recordKey)
  #releases = new Map();          // 物理样本 sample -> release
  #coverage = new Map();          // channelKey -> 覆盖台账
  #events = [];
  #eventSeq = 0;

  constructor(station) {
    this.station = station;
  }

  get events() {
    return this.#events;
  }

  appendEvent(type, details) {
    const event = { id: `evt-${++this.#eventSeq}`, type, at: new Date().toISOString(), ...details };
    this.#events.push(event);
    return event;
  }

  findObservation(recordKey) {
    return this.#observations.get(recordKey) ?? null;
  }

  findByInbound(cabinet, channel, sample) {
    const map = this.#byInbound.get(channelKey(cabinet, channel));
    const key = map?.get(sample);
    return key ? this.#observations.get(key) : null;
  }

  observationsOf(cabinet, channel) {
    const map = this.#byInbound.get(channelKey(cabinet, channel));
    if (!map) return [];
    return [...map.values()].map((key) => this.#observations.get(key));
  }

  // 登记一条入站原始点；重复 recordKey 直接返回既有记录（幂等）。
  recordObservation({ recordKey, source, kind, payload, receivedAt, exportedAt }) {
    const existing = this.#observations.get(recordKey);
    if (existing) return existing;
    const key = channelKey(payload.cabinet, payload.channel);
    const obs = {
      recordKey,
      source,
      kind,
      receivedAt,
      exportedAt: exportedAt ?? null,
      inbound: {
        cabinet: payload.cabinet,
        channel: payload.channel,
        sample: payload.sample,
        seq: payload.seq ?? null,
      },
      origin: payload.origin
        ? { cabinet: payload.origin[0], channel: payload.origin[1], sample: payload.origin[2] }
        : null,
      measured: payload.measured,
      measuredMin: parseHM(payload.measured),
      unit: payload.unit ?? null,
      rawCumulative: payload.cumulative ?? null,
      quality: payload.quality ?? 'unknown',
      status: 'suspended',       // released | suspended | replay-alias
      physicalSample: null,
    };
    this.#observations.set(recordKey, obs);
    if (!this.#byInbound.has(key)) this.#byInbound.set(key, new Map());
    this.#byInbound.get(key).set(payload.sample, recordKey);
    this.#ledger(key).covered.set(obs.measuredMin, {
      recordKey,
      status: 'suspended',
    });
    return obs;
  }

  setObservationStatus(recordKey, status, physicalSample = null) {
    const obs = this.#observations.get(recordKey);
    if (!obs) throw new Error(`未知入站记录: ${recordKey}`);
    obs.status = status;
    obs.physicalSample = physicalSample;
    const entry = this.#ledger(channelKey(obs.inbound.cabinet, obs.inbound.channel))
      .covered.get(obs.measuredMin);
    if (entry) entry.status = status;
  }

  // 追加一次释出痕迹；同一样本被修订后重释出会留下新旧两条痕迹。
  addTrace(obs, basis, { receivedAt }) {
    const sample = obs.physicalSample ?? obs.inbound.sample;
    const trace = {
      recordKey: obs.recordKey,
      source: obs.source,
      origin: obs.origin,
      inbound: { ...obs.inbound },
      measured: obs.measured,
      measuredMin: obs.measuredMin,
      exportedAt: obs.exportedAt,
      receivedAt,
      unit: obs.unit,
      rawCumulative: obs.rawCumulative,
      seq: obs.inbound.seq,
      quality: obs.quality,
      basis: {
        wireRecord: basis.wireRecord,
        point: basis.point,
        scale: basis.scale,
        direction: basis.direction,
        revision: basis.revision,
        rangeText: basis.rangeText,
      },
      reading: obs.rawCumulative === null ? null : obs.rawCumulative * basis.scale,
      status: 'active',
      withdrawnReason: null,
    };
    let release = this.#releases.get(sample);
    if (!release) {
      release = {
        sample,
        point: basis.point,
        measured: obs.measured,
        measuredMin: obs.measuredMin,
        quality: obs.quality,
        status: 'active',
        traces: [],
      };
      this.#releases.set(sample, release);
    }
    release.traces.push(trace);
    release.status = 'active';
    release.point = basis.point;
    this.setObservationStatus(obs.recordKey, 'released', sample);
    return { release, trace };
  }

  // 撤销样本当前有效的释出痕迹（接线修订推翻、或接线依据消失）。
  withdraw(sample, reason) {
    const release = this.#releases.get(sample);
    if (!release) return null;
    let withdrew = 0;
    for (const trace of release.traces) {
      if (trace.status === 'active') {
        trace.status = 'withdrawn';
        trace.withdrawnReason = reason;
        withdrew += 1;
      }
    }
    release.status = 'withdrawn';
    return { release, withdrew };
  }

  findRelease(sample) {
    return this.#releases.get(sample) ?? null;
  }

  activeTrace(sample) {
    const release = this.#releases.get(sample);
    if (!release || release.status !== 'active') return null;
    return [...release.traces].reverse().find((trace) => trace.status === 'active') ?? null;
  }

  activeReleases(point) {
    return [...this.#releases.values()]
      .filter((release) => release.status === 'active' && release.point === point)
      .sort((a, b) => a.measuredMin - b.measuredMin);
  }

  allReleases() {
    return [...this.#releases.values()];
  }

  // ---- 历史保存期底数（floor） -------------------------------------------
  setFloor(cabinet, channel, oldest, recordKey) {
    const ledger = this.#ledger(channelKey(cabinet, channel));
    ledger.floor = { oldest, oldestMin: parseHM(oldest), recordKey };
  }

  // 显式空测量登记（现场校验表确认某区间确实无测量，与“暂时缺”区分）。
  addExplicitGap(cabinet, channel, interval, note = {}) {
    const ledger = this.#ledger(channelKey(cabinet, channel));
    ledger.gaps.push({
      interval: [parseHM(interval[0]), parseHM(interval[1])],
      rangeText: interval,
      ...note,
    });
  }

  coverageOf(cabinet, channel) {
    return this.coverageSummary(channelKey(cabinet, channel));
  }

  allCoverage() {
    return [...this.#coverage.entries()].map(([key]) => ({ key, ...this.coverageSummary(key) }));
  }

  // 覆盖分段：
  //   unrecoverable —— 早于来源保存期底数，该来源永久无法补齐；
  //   pending       —— 保存期内但没有任何测量，属于暂时无法补齐，不能算完整；
  //   suspended     —— 收到读数但接线依据不足，归属挂起；
  //   covered       —— 已释出到物理测点；
  //   explicit-empty—— 现场校验表确认确实没有测量。
  coverageSummary(key, window = [0, 1440]) {
    const ledger = this.#ledger(key);
    const [winStart, winEnd] = [parseHMWindow(window[0]), parseHMWindow(window[1])];
    const segments = [];
    const push = (start, end, status, meta = {}) => {
      if (start >= end) return;
      const last = segments.at(-1);
      if (last && last.status === status && last.end === start) {
        last.end = end;
        Object.assign(last.meta, meta);
      } else {
        segments.push({ start, end, status, meta });
      }
    };

    let cursor = winStart;
    if (ledger.floor && winStart < ledger.floor.oldestMin) {
      const end = Math.min(winEnd, ledger.floor.oldestMin);
      push(winStart, end, 'unrecoverable', { floor: ledger.floor.oldest });
      cursor = end;
    }

    // 保存期内：按分钟合并已覆盖时刻、显式空档与挂起时刻。
    const instants = [...ledger.covered.entries()].sort((a, b) => a[0] - b[0]);
    while (cursor < winEnd) {
      const nextInstant = instants.find(([minute]) => minute >= cursor && minute < winEnd);
      const nextGap = ledger.gaps
        .map((gap) => ({ ...gap, from: Math.max(gap.interval[0], cursor) }))
        .filter((gap) => gap.from < gap.interval[1] && gap.from < winEnd)
        .sort((a, b) => a.from - b.from)[0];
      const nextBoundary = [nextInstant?.[0], nextGap?.from].filter((v) => v !== undefined).sort((a, b) => a - b)[0];
      if (nextBoundary === undefined) {
        push(cursor, winEnd, 'pending');
        break;
      }
      if (nextBoundary > cursor) push(cursor, nextBoundary, 'pending');
      if (nextGap && nextGap.from === nextBoundary) {
        const end = Math.min(nextGap.interval[1], winEnd);
        push(nextGap.from, end, 'explicit-empty', { gap: nextGap.rangeText });
        cursor = end;
      } else {
        const [minute, entry] = nextInstant;
        push(minute, minute + 1, entry.status === 'released' ? 'covered' : entry.status, {
          recordKey: entry.recordKey,
        });
        cursor = minute + 1;
      }
    }

    const blocking = segments.filter((segment) =>
      ['pending', 'unrecoverable', 'suspended'].includes(segment.status));
    return {
      channel: key,
      window: [winStart, winEnd],
      floor: ledger.floor ? { ...ledger.floor } : null,
      segments: segments.map((segment) => ({
        ...segment,
        startText: formatHM(segment.start),
        endText: formatHM(segment.end),
      })),
      complete: blocking.length === 0,
      blocking: blocking.map(({ status, startText, endText }) => ({ status, start: startText, end: endText })),
    };
  }

  // 检修员的补取计划：只列 pending 区间，且不早于保存期底数；
  // 已覆盖、已挂起、已确认空档与不可恢复区段都不会要求重取。
  backfillPlan(cabinet, channel, window = [0, 1440]) {
    const summary = this.coverageSummary(channelKey(cabinet, channel), window);
    return summary.segments
      .filter((segment) => segment.status === 'pending')
      .map(({ start, end, startText, endText }) => ({ start, end, startText, endText }));
  }

  // ---- 物理测点连续段 -----------------------------------------------------
  // 同一测点按发生时刻排列；入站通道变化或存在换接事件即切段。
  runsOf(point, cutoverTimes = []) {
    const releases = this.activeReleases(point);
    const runs = [];
    let current = null;
    for (const release of releases) {
      const trace = this.activeTrace(release.sample);
      if (!current) {
        current = { point, start: trace.measuredMin, end: trace.measuredMin, channel: channelKey(trace.inbound.cabinet, trace.inbound.channel), samples: [release.sample] };
        runs.push(current);
        continue;
      }
      const changedChannel = channelKey(trace.inbound.cabinet, trace.inbound.channel) !== current.channel;
      const crossesCutover = cutoverTimes.some((t) => current.end <= t && t <= trace.measuredMin);
      if (changedChannel || crossesCutover) {
        current = { point, start: trace.measuredMin, end: trace.measuredMin, channel: channelKey(trace.inbound.cabinet, trace.inbound.channel), samples: [release.sample] };
        runs.push(current);
      } else {
        current.end = trace.measuredMin;
        current.samples.push(release.sample);
      }
    }
    return runs.map((run) => ({
      ...run,
      startText: formatHM(run.start),
      endText: formatHM(run.end),
    }));
  }

  #ledger(key) {
    if (!this.#coverage.has(key)) {
      this.#coverage.set(key, { floor: null, covered: new Map(), gaps: [] });
    }
    return this.#coverage.get(key);
  }
}

function parseHMWindow(value) {
  return typeof value === 'number' ? value : parseHM(value);
}

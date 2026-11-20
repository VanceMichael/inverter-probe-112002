// 入站流水线：把来源信封（archive/live/wiring）归并成可解释的物理测点数据。
//
// 处理纪律：
// - 接线/换接/底数资料先于样本处理，保证“样本发生时刻按当时适用接线归属”可复算；
// - 带 origin 的重放记录不产生新物理样本，只在原始样本上挂入站别名，杜绝双算；
// - 接线修订到达时全通道重解析：先失效受影响释出（带事件与区间），再按新依据重释出；
// - 没有适用接线的读数保持 suspended，后续接线补登记可以使其转可用；
// - 接线被推翻到无依据时连续性允许暂时倒退（active 数下降、runs 重算）。

import { energyWindow } from './energy.mjs';
import { SourceClient } from './source-client.mjs';
import { StationStore } from './station-store.mjs';
import { formatHM } from './time.mjs';
import { WiringRegistry, channelKey } from './wiring-registry.mjs';

export class IngestPipeline {
  #clock;
  #liveReceived = 0;

  constructor(station, { clock = () => new Date() } = {}) {
    this.station = station;
    this.clock = clock;
    this.store = new StationStore(station);
    this.wiring = new WiringRegistry();
  }

  connect(baseUrl, options) {
    this.client = new SourceClient(baseUrl, options);
    return this.client;
  }

  // 推进一个回放阶段：接线 -> 历史 -> 实时，返回本阶段处理摘要。
  async advanceStage(stage) {
    if (!this.client) throw new Error('尚未连接来源');
    const switched = await this.client.setStage(stage);
    const summary = { stage: switched.stage, ingested: 0, events: 0 };
    for (const source of ['wiring', 'archive', 'live']) {
      const fresh = await this.client.fetchNew(source);
      for (const envelope of fresh) {
        this.ingestEnvelope(envelope);
        summary.ingested += 1;
      }
    }
    summary.events = this.store.events.length;
    return summary;
  }

  ingestEnvelope(envelope) {
    return this.ingestRecord(envelope.kind, envelope.record, envelope.payload, {
      source: envelope.availableFrom ? `stage-${envelope.availableFrom}` : 'direct',
      recordKey: envelope.record,
    });
  }

  // 直接登记业务记录（绕过 HTTP，便于单元演练）。
  ingestRecord(kind, recordKey, payload, { source = 'direct' } = {}) {
    const now = this.clock().toISOString();
    switch (kind) {
      case 'wire': {
        const entry = this.wiring.addWire({ record: recordKey, payload });
        this.store.appendEvent('wiring-registered', {
          recordKey,
          channel: channelKey(entry.cabinet, entry.channel),
          point: entry.point,
          revision: entry.revision,
          interval: [formatHM(entry.interval[0]), formatHM(entry.interval[1])],
          scale: entry.scale,
          direction: entry.direction,
        });
        this.#reresolveChannel(entry.cabinet, entry.channel);
        return { kind: 'wire', entry };
      }
      case 'cutover': {
        const entry = this.wiring.addCutover({ record: recordKey, payload });
        const decision = this.wiring.evaluateCutover(entry.point);
        this.store.appendEvent('cutover-registered', {
          recordKey,
          cutoverId: entry.id,
          point: entry.point,
          time: entry.timeText,
          continuous: entry.continuous,
          spliceAllowed: decision.allowed,
          spliceReason: decision.reason,
        });
        return { kind: 'cutover', entry, decision };
      }
      case 'floor': {
        this.store.setFloor(payload.cabinet, payload.channel, payload.oldest, recordKey);
        this.store.appendEvent('floor-registered', {
          recordKey,
          channel: channelKey(payload.cabinet, payload.channel),
          oldest: payload.oldest,
        });
        return { kind: 'floor' };
      }
      case 'sample':
      case 'point': {
        const exportedAt = kind === 'sample' ? payload.exported : null;
        const obs = this.store.recordObservation({
          recordKey,
          source,
          kind,
          payload,
          receivedAt: now,
          exportedAt,
        });
        if (kind === 'point') this.#liveReceived += 1;
        return this.#classify(obs);
      }
      default:
        throw new Error(`未知记录类型: ${kind}`);
    }
  }

  get liveReceivedCount() {
    return this.#liveReceived;
  }

  #classify(obs) {
    // 重放别名：origin 指向旧柜的同一物理样本，只挂别名、不重算倍率。
    if (obs.origin) {
      const canonical = this.store.findByInbound(
        obs.origin.cabinet,
        obs.origin.channel,
        obs.origin.sample,
      );
      if (canonical) {
        this.store.setObservationStatus(obs.recordKey, 'replay-alias', canonical.physicalSample);
        this.store.appendEvent('replay-aliased', {
          recordKey: obs.recordKey,
          aliasInbound: channelKey(obs.inbound.cabinet, obs.inbound.channel),
          canonicalRecord: canonical.recordKey,
          physicalSample: obs.origin.sample,
          measured: obs.measured,
        });
        return { status: 'replay-alias', canonical: canonical.recordKey };
      }
      // 正本尚未到达：保持挂起，等正本到达后自然重解析（此处不猜测）。
      this.store.appendEvent('suspended', {
        recordKey: obs.recordKey,
        reason: 'replay-origin-unknown',
        measured: obs.measured,
        channel: channelKey(obs.inbound.cabinet, obs.inbound.channel),
      });
      return { status: 'suspended', reason: 'replay-origin-unknown' };
    }

    const basis = this.wiring.resolve(obs.inbound.cabinet, obs.inbound.channel, obs.measured);
    if (!basis) {
      this.store.setObservationStatus(obs.recordKey, 'suspended');
      this.store.appendEvent('suspended', {
        recordKey: obs.recordKey,
        reason: 'no-applicable-wiring',
        measured: obs.measured,
        channel: channelKey(obs.inbound.cabinet, obs.inbound.channel),
      });
      return { status: 'suspended', reason: 'no-applicable-wiring' };
    }

    const { release, trace } = this.store.addTrace(obs, basis, { receivedAt: obs.receivedAt });
    this.store.appendEvent('released', {
      recordKey: obs.recordKey,
      sample: release.sample,
      point: basis.point,
      revision: basis.revision,
      measured: obs.measured,
      interval: basis.rangeText,
      reading: trace.reading,
    });
    return { status: 'released', sample: release.sample, point: basis.point, trace };
  }

  #reresolveChannel(cabinet, channel) {
    const observations = this.store.observationsOf(cabinet, channel)
      .filter((obs) => obs.status !== 'replay-alias');
    for (const obs of observations) {
      const basis = this.wiring.resolve(cabinet, channel, obs.measured);
      const sample = obs.physicalSample ?? obs.inbound.sample;
      const previous = this.store.activeTrace(sample);

      if (!basis) {
        if (previous) {
          this.store.withdraw(sample, 'wiring-basis-removed');
          this.store.setObservationStatus(obs.recordKey, 'suspended');
          this.store.appendEvent('invalidated', {
            recordKey: obs.recordKey,
            sample,
            reason: 'wiring-basis-removed',
            measured: obs.measured,
            previousBasis: {
              wireRecord: previous.basis.wireRecord,
              point: previous.basis.point,
              revision: previous.basis.revision,
              interval: previous.basis.rangeText,
            },
          });
        }
        continue;
      }

      const sameBasis = previous
        && previous.basis.wireRecord === basis.wireRecord
        && previous.basis.revision === basis.revision;
      if (sameBasis) continue;

      if (previous) {
        this.store.withdraw(sample, 'wiring-revision');
        this.store.appendEvent('invalidated', {
          recordKey: obs.recordKey,
          sample,
          reason: 'wiring-revision',
          measured: obs.measured,
          interval: basis.rangeText,
          previousBasis: {
            wireRecord: previous.basis.wireRecord,
            point: previous.basis.point,
            revision: previous.basis.revision,
            interval: previous.basis.rangeText,
          },
          newBasis: {
            wireRecord: basis.wireRecord,
            point: basis.point,
            revision: basis.revision,
            interval: basis.rangeText,
            scale: basis.scale,
            direction: basis.direction,
          },
        });
      }

      const { release, trace } = this.store.addTrace(obs, basis, { receivedAt: this.clock().toISOString() });
      this.store.appendEvent(previous ? 'rereleased' : 'unblocked', {
        recordKey: obs.recordKey,
        sample: release.sample,
        point: basis.point,
        revision: basis.revision,
        measured: obs.measured,
        interval: basis.rangeText,
        reading: trace.reading,
      });
    }
  }

  // ---- 消费侧查询 ---------------------------------------------------------
  coverage(cabinet, channel, window) {
    return this.store.coverageOf(cabinet, channel, window);
  }

  backfillPlan(cabinet, channel, window) {
    return this.store.backfillPlan(cabinet, channel, window);
  }

  series(point) {
    return this.store.activeReleases(point).map((release) => {
      const trace = this.store.activeTrace(release.sample);
      return {
        sample: release.sample,
        point: release.point,
        measured: release.measured,
        quality: release.quality,
        reading: trace.reading,
        rawCumulative: trace.rawCumulative,
        scale: trace.basis.scale,
        direction: trace.basis.direction,
        revision: trace.basis.revision,
        inbound: trace.inbound,
        recordKey: trace.recordKey,
      };
    });
  }

  pointRuns(point) {
    const cutovers = this.wiring.cutoversOf(point).map((item) => item.time);
    return this.store.runsOf(point, cutovers);
  }

  energy(point, window = ['00:00', '24:00']) {
    return energyWindow(this.store, this.wiring, point, window);
  }

  eventsSince(eventId) {
    if (!eventId) return this.store.events;
    const index = this.store.events.findIndex((event) => event.id === eventId);
    return index < 0 ? this.store.events : this.store.events.slice(index + 1);
  }
}
